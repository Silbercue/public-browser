/**
 * Friction-Session-Tracking (opt-in, dev-only).
 *
 * Zaehlt auf dem Entwickler-Rechner mit, in welchen Claude-Code-Sessions Public
 * Browser benutzt wurde und wie viel Reibung dabei auftrat (Tool-Fehler,
 * Fallback-Spiralen). Ab einer Schwelle liefert `virtual_desk` einen
 * Hinweis, dass genug Material fuer einen `bmad-frictioneer`-Lauf
 * (Session-Modus) zusammengekommen ist.
 *
 * Harte Leitplanke: Public Browser ist ein oeffentliches npm-Paket. Das
 * gesamte Feature liegt hinter `SILBERCUE_CHROME_FRICTION_LOG=1`. Ohne die
 * Variable wird JEDE oeffentliche Methode zum sofortigen No-op — kein
 * Dateizugriff, kein Zaehler, kein Hinweis (AC 1).
 *
 * Queue-Datei: `~/.silbercue-chrome/friction-queue.json`. Ein Eintrag pro
 * Serverprozess. Claude Code reicht `CLAUDE_CODE_SESSION_ID` und
 * `CLAUDE_PROJECT_DIR` als Env-Vars an den MCP-Prozess durch — jeder
 * Eintrag merkt sich deshalb alle Session-IDs, die waehrend seiner Laufzeit
 * beobachtet wurden (`sessionIds`). Bei `/clear` bekommt Claude Code eine
 * neue Session-ID, der MCP-Prozess laeuft aber weiter: bei jedem (throttled)
 * Flush wird deshalb die juengste `.jsonl`-Datei unter
 * `~/.claude/projects/<slug>/` geprueft und ihre UUID nachgetragen, falls
 * noch nicht bekannt.
 *
 * Zwei Leitplanken gegen Muell in der Queue: Ein Eintrag entsteht erst, wenn
 * der Serverprozess wirklich benutzt wurde — `init()` legt ihn nur im
 * Speicher an, geschrieben wird er beim ersten `recordToolResult()`. Und
 * wenn die Queue ueber `MAX_QUEUE_ENTRIES` waechst, fliegen zuerst
 * Eintraege ohne einen einzigen Tool-Call raus (aelteste zuerst), erst
 * danach Eintraege mit Nutzung — sonst verdraengen viele leere Starts genau
 * den einen Eintrag, der Reibung dokumentiert.
 */
import { mkdir, readFile, writeFile, rename, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { toolSequence, type ToolSequenceTracker } from "./tool-sequence.js";

const QUEUE_FILE = "friction-queue.json";

/** Ab hier throttelt der Recorder Zwischen-Flushes (Serverstart + Shutdown sind Ausnahmen). */
const FLUSH_THROTTLE_MS = 10_000;

/** Queue klein halten: aeltere Eintraege werden beim Start geprunt. */
const MAX_QUEUE_ENTRIES = 50;

/** Schwellen fuer den virtual_desk-Hinweis (Summe ueber alle Eintraege seit lastFrictioneerRun). */
const THRESHOLD_SESSIONS = 10;
const THRESHOLD_TOOL_ERRORS = 25;
const THRESHOLD_SPIRALS = 3;

const EPOCH_ISO = new Date(0).toISOString();

interface FrictionSessionEntry {
  startedAt: string;
  endedAt?: string;
  cwd: string;
  pid: number;
  projectDir: string;
  sessionIds: string[];
  toolCalls: number;
  toolErrors: number;
  spirals: number;
}

interface FrictionQueue {
  lastFrictioneerRun: string;
  sessions: FrictionSessionEntry[];
}

export interface FrictionRecorderOptions {
  /** Verzeichnis der Queue-Datei. Default: `~/.silbercue-chrome`. Nur fuer Tests gedacht. */
  dataDir?: string;
}

/** Liest das Flag direkt am Nutzungsort (Muster `isFullToolsMode()` in registry.ts). */
function isFrictionLogEnabled(): boolean {
  const v = process.env.SILBERCUE_CHROME_FRICTION_LOG;
  return v === "1" || v === "true";
}

/** Slug-Regel aus `~/.claude/scripts/get-session-id.sh`: alles ausser [a-zA-Z0-9] wird zu `-`. */
function projectDirToSlug(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, "-");
}

export class FrictionRecorder {
  private readonly _dataDir: string;
  private _enabled = false;
  private _entry: FrictionSessionEntry | null = null;
  private _lastFlushAt = 0;
  private _hintShown = false;
  /** Erst mit dem ersten Tool-Call wird der Eintrag ueberhaupt geschrieben (Leereintraege vermeiden). */
  private _used = false;
  /** H4-Muster (local-store.ts): serialisiert Schreibzugriffe auf die Queue-Datei. */
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(options?: FrictionRecorderOptions) {
    this._dataDir = options?.dataDir ?? join(homedir(), ".silbercue-chrome");
  }

  /**
   * Beim Serverstart aufrufen. Ohne Flag ein No-op (kein fs-Zugriff). Mit
   * Flag: legt den eigenen Queue-Eintrag NUR im Speicher an und haengt sich
   * an den ToolSequenceTracker. Geschrieben wird nichts — das uebernimmt
   * der erste `recordToolResult()`.
   */
  async init(): Promise<void> {
    this._enabled = isFrictionLogEnabled();
    if (!this._enabled) return;

    this._entry = {
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      pid: process.pid,
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      sessionIds: process.env.CLAUDE_CODE_SESSION_ID
        ? [process.env.CLAUDE_CODE_SESSION_ID]
        : [],
      toolCalls: 0,
      toolErrors: 0,
      spirals: 0,
    };

    this.attachTo(toolSequence);
  }

  /**
   * Zaehlt einen Tool-Call (immer) und einen Tool-Fehler (wenn `isError`).
   * Der erste Aufruf schreibt den Eintrag zum ersten Mal — vorher existiert
   * er nur im Speicher, damit ein Serverprozess ohne Nutzung keinen
   * Leereintrag in der Queue hinterlaesst. No-op ohne Flag.
   */
  recordToolResult(isError: boolean): void {
    if (!this._enabled || !this._entry) return;
    this._entry.toolCalls++;
    if (isError) this._entry.toolErrors++;
    const first = !this._used;
    this._used = true;
    void this._flush(first);
  }

  /** Zaehlt eine Fallback-Spirale (Uebergang auf Tier 3 im ToolSequenceTracker). No-op ohne Flag. */
  recordSpiral(): void {
    if (!this._enabled || !this._entry) return;
    this._entry.spirals++;
    if (this._used) void this._flush(false);
  }

  /**
   * Bindet sich als `onSpiral`-Callback an den `ToolSequenceTracker`-Singleton.
   * Dupliziert keine Tier-Logik — der Tracker entscheidet, wann er feuert.
   */
  attachTo(tracker: ToolSequenceTracker): void {
    tracker.onSpiral = () => this.recordSpiral();
  }

  /**
   * Baut den Hinweis-Block fuer `virtual_desk`, wenn: Flag aktiv UND
   * `bmad-frictioneer` auf dieser Maschine vorhanden (Datei ODER Verzeichnis)
   * UND Schwelle erreicht UND noch nicht in diesem Serverprozess gezeigt.
   * Markiert intern "gezeigt", sobald ein Block zurueckgegeben wird — auch
   * wenn ein spaeterer Aufruf technisch wieder ueber der Schwelle liegt.
   */
  async buildHintBlock(): Promise<string | null> {
    if (!this._enabled) return null;
    if (this._hintShown) return null;

    if (!(await this._frictioneerPresent())) return null;

    const queue = await this._readQueueSafe();
    const sessions = queue.sessions;
    if (sessions.length === 0) return null;

    const sessionsWithErrors = sessions.filter((s) => s.toolErrors > 0).length;
    const toolErrorsSum = sessions.reduce((sum, s) => sum + s.toolErrors, 0);
    const spiralsSum = sessions.reduce((sum, s) => sum + s.spirals, 0);

    const overThreshold =
      sessions.length >= THRESHOLD_SESSIONS ||
      toolErrorsSum >= THRESHOLD_TOOL_ERRORS ||
      spiralsSum >= THRESHOLD_SPIRALS;
    if (!overThreshold) return null;

    this._hintShown = true;

    const lastRunLabel = this._formatDateLabel(queue.lastFrictioneerRun);
    const queuePath = join(this._dataDir, QUEUE_FILE);

    return [
      "── friction-tracking ──────────────────────────────────────────",
      `${sessions.length} Sessions seit dem letzten frictioneer-Lauf (${lastRunLabel}), davon`,
      `${sessionsWithErrors} mit Tool-Fehlern (${toolErrorsSum} gesamt), ${spiralsSum} Fallback-Spiralen erkannt.`,
      `Queue: ${queuePath}`,
      "→ Hinweis an den User: genug Material fuer einen Verbesserungs-",
      "  lauf. Vorschlag: /bmad-frictioneer im SilbercueChrome-Repo",
      "  starten; die Queue-Datei liefert Session-IDs, Zeitfenster + cwd.",
      "───────────────────────────────────────────────────────────────",
    ].join("\n");
  }

  /** Finaler Flush (setzt `endedAt`) beim Server-Shutdown. Ohne Nutzung ein No-op. Wirft nie. */
  async shutdown(): Promise<void> {
    if (!this._enabled || !this._entry || !this._used) return;
    try {
      this._entry.endedAt = new Date().toISOString();
      await this._flush(/* force */ true);
    } catch {
      /* best effort */
    }
  }

  // ---------------------------------------------------------------------
  // Intern
  // ---------------------------------------------------------------------

  private _formatDateLabel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "nie";
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}.`;
  }

  /** Doppelter Boden: Hinweis nur, wenn Datei ODER Verzeichnis existiert (robust gegen Umzuege). */
  private async _frictioneerPresent(): Promise<boolean> {
    const commandFile = join(homedir(), ".claude", "commands", "bmad-frictioneer.md");
    const skillDir = join(homedir(), ".claude", "skills", "bmad-frictioneer");
    const checks = await Promise.all([
      stat(commandFile).then(() => true).catch(() => false),
      stat(skillDir).then(() => true).catch(() => false),
    ]);
    return checks[0] || checks[1];
  }

  private async _ensureDir(): Promise<void> {
    try {
      await mkdir(this._dataDir, { recursive: true });
    } catch {
      /* best effort — write below fails loud enough on its own */
    }
  }

  private get _queuePath(): string {
    return join(this._dataDir, QUEUE_FILE);
  }

  /** Defensiv: liefert immer eine valide Struktur, wirft nie (AC 5). */
  private async _readQueueSafe(): Promise<FrictionQueue> {
    try {
      const raw = await readFile(this._queuePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<FrictionQueue>;
      const lastFrictioneerRun =
        typeof parsed.lastFrictioneerRun === "string" &&
        !Number.isNaN(Date.parse(parsed.lastFrictioneerRun))
          ? parsed.lastFrictioneerRun
          : EPOCH_ISO;
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return { lastFrictioneerRun, sessions };
    } catch {
      return { lastFrictioneerRun: EPOCH_ISO, sessions: [] };
    }
  }

  private async _writeQueueSafe(queue: FrictionQueue): Promise<void> {
    try {
      await this._ensureDir();
      const content = JSON.stringify(queue, null, 2);
      const tmp = `${this._queuePath}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, content, "utf-8");
      await rename(tmp, this._queuePath);
    } catch {
      /* best effort — corrupte/fehlende Queue-Datei darf den Server nie stoppen */
    }
  }

  /**
   * Throttled Flush: schreibt fruehestens alle `FLUSH_THROTTLE_MS`, ausser
   * `force` (Serverstart, Shutdown). Serialisiert ueber `_writeQueue`, damit
   * parallele Aufrufe (z.B. mehrere Tool-Ergebnisse kurz hintereinander)
   * sich nicht gegenseitig ueberschreiben.
   */
  private async _flush(force: boolean): Promise<void> {
    if (!this._entry || !this._used) return;
    const now = Date.now();
    if (!force && now - this._lastFlushAt < FLUSH_THROTTLE_MS) return;
    this._lastFlushAt = now;

    this._writeQueue = this._writeQueue.then(() => this._doFlush());
    return this._writeQueue;
  }

  private async _doFlush(): Promise<void> {
    if (!this._entry) return;
    try {
      await this._maybeAppendClearedSessionId();

      const queue = await this._readQueueSafe();
      const cutoff = Date.parse(queue.lastFrictioneerRun);

      let sessions = queue.sessions.filter((s) => {
        const t = Date.parse(s.startedAt);
        return Number.isFinite(t) && (!Number.isFinite(cutoff) || t >= cutoff);
      });

      const idx = sessions.findIndex(
        (s) => s.pid === this._entry!.pid && s.startedAt === this._entry!.startedAt,
      );
      if (idx >= 0) sessions[idx] = this._entry!;
      else sessions.push(this._entry!);

      if (sessions.length > MAX_QUEUE_ENTRIES) {
        const nachAlter = (a: FrictionSessionEntry, b: FrictionSessionEntry) =>
          Date.parse(a.startedAt) - Date.parse(b.startedAt);
        const leer = sessions.filter((s) => (s.toolCalls ?? 0) === 0).sort(nachAlter);
        const benutzt = sessions.filter((s) => (s.toolCalls ?? 0) > 0).sort(nachAlter);

        let zuviel = sessions.length - MAX_QUEUE_ENTRIES;
        const leerWeg = Math.min(zuviel, leer.length);
        zuviel -= leerWeg;

        sessions = [...leer.slice(leerWeg), ...benutzt].sort(nachAlter).slice(zuviel);
      }

      await this._writeQueueSafe({ lastFrictioneerRun: queue.lastFrictioneerRun, sessions });
    } catch {
      /* best effort — never crash the server on flush failure (AC 5) */
    }
  }

  /**
   * /clear-Erkennung (Design-Update 2): Claude Code vergibt bei `/clear`
   * eine neue Session-ID, der MCP-Prozess laeuft aber weiter. Deshalb prueft
   * jeder Flush, welche `.jsonl`-Datei unter `~/.claude/projects/<slug>/`
   * gerade die neueste (mtime) ist, und traegt ihre UUID nach, falls noch
   * nicht bekannt. Fehler hierbei (Verzeichnis fehlt etc.) werden still
   * geschluckt.
   */
  private async _maybeAppendClearedSessionId(): Promise<void> {
    if (!this._entry) return;
    try {
      const slug = projectDirToSlug(this._entry.projectDir);
      const projectsDir = join(homedir(), ".claude", "projects", slug);
      const files = await readdir(projectsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      if (jsonlFiles.length === 0) return;

      let latestName: string | null = null;
      let latestMtime = -Infinity;
      for (const f of jsonlFiles) {
        const st = await stat(join(projectsDir, f));
        if (st.mtimeMs > latestMtime) {
          latestMtime = st.mtimeMs;
          latestName = f;
        }
      }
      if (!latestName) return;

      const sid = latestName.slice(0, -".jsonl".length);
      if (sid && !this._entry.sessionIds.includes(sid)) {
        this._entry.sessionIds.push(sid);
      }
    } catch {
      /* still schlucken */
    }
  }
}

/** Modul-Level-Singleton, analog zu `toolSequence`. */
export const frictionRecorder = new FrictionRecorder();
