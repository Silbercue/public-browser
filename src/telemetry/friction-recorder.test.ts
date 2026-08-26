/**
 * Friction-Session-Tracking (opt-in, dev-only) — Tests.
 *
 * Deckt die 6 Akzeptanzkriterien aus docs/friction-session-tracking-plan.md
 * ab, plus die beiden Design-Updates aus dem Implementierungs-Auftrag:
 *  - Session-ID direkt aus `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PROJECT_DIR`.
 *  - /clear-Nachtrags-Logik ueber die juengste `.jsonl`-Datei (mtime).
 *
 * fs-Mock-Muster wie `src/cdp/chrome-profiles.test.ts` (vi.mock("node:fs"),
 * homedir-Stub via vi.mock("node:os")) und `src/tools/file-upload.test.ts`
 * (nur die tatsaechlich benutzten Funktionen mocken).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => "/Users/testuser"),
  };
});

import { mkdir, readFile, writeFile, rename, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { FrictionRecorder } from "./friction-recorder.js";
import { ToolSequenceTracker, FLAG_QUERY_SELECTOR } from "./tool-sequence.js";

const mockMkdir = vi.mocked(mkdir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRename = vi.mocked(rename);
const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockHomedir = vi.mocked(homedir);

/** Node-typischer fehlender-Datei-Fehler, fuer defensive-read-Tests. */
function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/** Letzter writeFile()-Aufruf, als geparstes Queue-JSON. */
function lastWrittenQueue(): { lastFrictioneerRun: string; sessions: Array<Record<string, unknown>> } {
  const calls = mockWriteFile.mock.calls;
  const last = calls[calls.length - 1];
  return JSON.parse(last[1] as string);
}

/** Wartet die verkettete, nicht awaitbare Flush-Promise ab (`void this._flush(...)`). */
async function flushPending(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Macht `stat()` fuer den bmad-frictioneer-Command-File "vorhanden". */
function mockFrictioneerFilePresent(): void {
  mockStat.mockImplementation(async (p: unknown) => {
    if (String(p).endsWith("commands/bmad-frictioneer.md")) return {} as never;
    throw enoent();
  });
}

function fixtureSessions(
  count: number,
  overrides: Partial<{ toolErrors: number; spirals: number }> = {},
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    startedAt: "2026-08-11T00:00:00.000Z",
    cwd: "/some/project",
    pid: 1000 + i,
    projectDir: "/some/project",
    sessionIds: [],
    toolCalls: 5,
    toolErrors: overrides.toolErrors ?? 0,
    spirals: overrides.spirals ?? 0,
  }));
}

describe("FrictionRecorder (Friction-Session-Tracking, opt-in dev-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue("/Users/testuser");
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockReadFile.mockRejectedValue(enoent());
    mockReaddir.mockRejectedValue(enoent());
    mockStat.mockRejectedValue(enoent());
    delete process.env.SILBERCUE_CHROME_FRICTION_LOG;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    delete process.env.SILBERCUE_CHROME_FRICTION_LOG;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  // =========================================================================
  // AC 1 — ohne Flag: sofortiger No-op, kein Dateizugriff
  // =========================================================================
  describe("AC 1 — ohne Flag", () => {
    it("greift auf keine fs-Funktion zu und liefert null/keine Aenderung", async () => {
      const recorder = new FrictionRecorder({ dataDir: "/fake/.silbercue-chrome" });

      await recorder.init();
      recorder.recordToolResult(true);
      recorder.recordSpiral();
      const hint = await recorder.buildHintBlock();
      await recorder.shutdown();

      expect(hint).toBeNull();
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
      expect(mockReaddir).not.toHaveBeenCalled();
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("bleibt ein No-op fuer explizit falsche Flag-Werte (z.B. '0')", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "0";
      const recorder = new FrictionRecorder({ dataDir: "/fake/.silbercue-chrome" });
      await recorder.init();
      recorder.recordToolResult(true);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // AC 2 — mit Flag: Serverstart erzeugt/erweitert die Queue-Datei; Fehler
  // und Spiralen erhoehen die Zaehler.
  // =========================================================================
  describe("AC 2 — mit Flag: Queue-Datei entsteht, Zaehler erhoehen sich", () => {
    it("schreibt ab dem ersten Tool-Call und zaehlt bis zum finalen Flush", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      const recorder = new FrictionRecorder({ dataDir: "/fake/.silbercue-chrome" });

      await recorder.init();
      expect(mockWriteFile).not.toHaveBeenCalled(); // erst der erste Tool-Call schreibt

      recorder.recordToolResult(false); // toolCalls=1
      recorder.recordToolResult(true); // toolCalls=2, toolErrors=1
      recorder.recordToolResult(true); // toolCalls=3, toolErrors=2
      recorder.recordSpiral(); // spirals=1

      await recorder.shutdown(); // finaler Flush, ignoriert Throttle

      const written = lastWrittenQueue();
      expect(written.sessions).toHaveLength(1);
      const entry = written.sessions[0];
      expect(entry.toolCalls).toBe(3);
      expect(entry.toolErrors).toBe(2);
      expect(entry.spirals).toBe(1);
      expect(entry.cwd).toBe(process.cwd());
      expect(entry.pid).toBe(process.pid);
      expect(entry.endedAt).toBeTruthy();
    });

    it("throttelt Zwischen-Flushes: recordToolResult() allein schreibt nicht sofort erneut", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      const recorder = new FrictionRecorder({ dataDir: "/fake/.silbercue-chrome" });
      await recorder.init();
      recorder.recordToolResult(false); // erster, forcierter Flush
      await flushPending();
      mockWriteFile.mockClear();

      recorder.recordToolResult(true);
      recorder.recordToolResult(true);

      // Kein force-Flush ausgelöst — Throttle-Fenster (10s) ist noch nicht um.
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // AC 3 — Schwellen-Logik: unter Schwelle kein Block; ab Schwelle genau
  // ein Block, nur beim ersten Aufruf im Serverprozess.
  // =========================================================================
  describe("AC 3 — Schwellen-Logik", () => {
    it("liefert null, wenn keine Schwelle erreicht ist", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockFrictioneerFilePresent();
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(3, { toolErrors: 1 }),
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();

      const hint = await recorder.buildHintBlock();
      expect(hint).toBeNull();
    });

    it("liefert genau EINEN Block ab Schwelle (>=10 Sessions), danach null im selben Prozess", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockFrictioneerFilePresent();
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(10, { toolErrors: 1 }),
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();

      const first = await recorder.buildHintBlock();
      expect(first).not.toBeNull();
      expect(first).toContain("── friction-tracking");
      expect(first).toMatch(/10 Sessions seit dem letzten frictioneer-Lauf \(\d{2}\.\d{2}\.\), davon/);
      expect(first).toContain("10 mit Tool-Fehlern (10 gesamt)");
      expect(first).toContain("Queue: ");
      expect(first).toContain("→ Hinweis an den User");

      const second = await recorder.buildHintBlock();
      expect(second).toBeNull();
    });

    it("loest auch ueber die toolErrors-Schwelle (>=25) aus, unabhaengig von der Sessionanzahl", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockFrictioneerFilePresent();
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(2, { toolErrors: 13 }), // 2 Sessions, 26 Fehler gesamt
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      const hint = await recorder.buildHintBlock();
      expect(hint).not.toBeNull();
    });

    it("loest auch ueber die spirals-Schwelle (>=3) aus", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockFrictioneerFilePresent();
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(2, { spirals: 2 }), // 2 Sessions, 4 Spiralen gesamt
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      const hint = await recorder.buildHintBlock();
      expect(hint).not.toBeNull();
    });
  });

  // =========================================================================
  // AC 4 — fehlt bmad-frictioneer (Datei UND Verzeichnis), erscheint der
  // Block auch ueber der Schwelle nicht. Gezaehlt wird trotzdem.
  // =========================================================================
  describe("AC 4 — doppelter Boden: kein bmad-frictioneer, kein Block", () => {
    it("liefert null, wenn weder Datei noch Verzeichnis existieren, zaehlt aber weiter", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      // Default-Mock: stat() rejected fuer alles -> weder Datei noch Verzeichnis vorhanden.
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(10, { toolErrors: 1 }),
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();

      const hint = await recorder.buildHintBlock();
      expect(hint).toBeNull();

      recorder.recordToolResult(true);
      await recorder.shutdown();

      const written = lastWrittenQueue();
      const ownEntry = written.sessions.find((s) => s.pid === process.pid);
      expect(ownEntry?.toolErrors).toBe(1);
    });

    it("erscheint, sobald NUR die Datei existiert (robust gegen kuenftige Umzuege)", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockStat.mockImplementation(async (p: unknown) => {
        if (String(p).endsWith("commands/bmad-frictioneer.md")) return {} as never;
        throw enoent();
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(10, { toolErrors: 1 }),
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      const hint = await recorder.buildHintBlock();
      expect(hint).not.toBeNull();
    });

    it("erscheint, sobald NUR das Verzeichnis existiert", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockStat.mockImplementation(async (p: unknown) => {
        if (String(p).endsWith("skills/bmad-frictioneer")) return {} as never;
        throw enoent();
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          lastFrictioneerRun: "2026-08-10T12:00:00.000Z",
          sessions: fixtureSessions(10, { toolErrors: 1 }),
        }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      const hint = await recorder.buildHintBlock();
      expect(hint).not.toBeNull();
    });
  });

  // =========================================================================
  // AC 5 — korrupte/fehlende Queue-Datei crasht nie den Server.
  // =========================================================================
  describe("AC 5 — korrupte/fehlende Queue-Datei", () => {
    it("legt eine frische Struktur an, wenn readFile mit ENOENT fehlschlaegt", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockReadFile.mockRejectedValue(enoent());

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await expect(recorder.init()).resolves.toBeUndefined();
      recorder.recordToolResult(false);
      await flushPending();

      const written = lastWrittenQueue();
      expect(written.sessions).toHaveLength(1);
      expect(typeof written.lastFrictioneerRun).toBe("string");
    });

    it("liest defensiv weiter, wenn die Datei kaputtes JSON enthaelt", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockReadFile.mockResolvedValue("{ this is not valid json !!");

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await expect(recorder.init()).resolves.toBeUndefined();
      recorder.recordToolResult(false);
      await flushPending();

      const written = lastWrittenQueue();
      expect(written.sessions).toHaveLength(1); // nur der eigene, frisch angelegte Eintrag
    });

    it("saeubert eine Datei mit falscher Struktur (sessions kein Array)", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockReadFile.mockResolvedValue(JSON.stringify({ lastFrictioneerRun: 12345, sessions: "kaputt" }));

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await expect(recorder.init()).resolves.toBeUndefined();
      recorder.recordToolResult(false);
      await flushPending();

      const written = lastWrittenQueue();
      expect(Array.isArray(written.sessions)).toBe(true);
      expect(written.sessions).toHaveLength(1);
    });

    it("wirft nie, wenn mkdir/writeFile/rename fehlschlagen (Schreibfehler)", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockMkdir.mockRejectedValue(new Error("EACCES"));
      mockWriteFile.mockRejectedValue(new Error("EACCES"));
      mockRename.mockRejectedValue(new Error("EACCES"));

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await expect(recorder.init()).resolves.toBeUndefined();
      recorder.recordToolResult(true);
      await expect(recorder.shutdown()).resolves.toBeUndefined();
    });

    it("schreibt atomar: rename() vom .tmp-Pfad auf <dataDir>/friction-queue.json", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false);
      await flushPending();

      const [tmpPfad, zielPfad] = mockRename.mock.calls[0] as [string, string];
      // Ziel ist die echte Queue-Datei, nicht irgendein anderer Name.
      expect(zielPfad).toBe("/fake/friction-queue.json");
      // Geschrieben wurde vorher unter einem eindeutigen .tmp-Namen daneben.
      expect(tmpPfad).toMatch(/^\/fake\/friction-queue\.json\.[0-9a-f]+\.tmp$/);
      // Und der Inhalt ging in genau diese .tmp-Datei, nicht direkt ins Ziel.
      expect(mockWriteFile).toHaveBeenCalledWith(tmpPfad, expect.any(String), "utf-8");
    });
  });

  // =========================================================================
  // Design-Update 1 — Session-ID direkt aus CLAUDE_CODE_SESSION_ID /
  // CLAUDE_PROJECT_DIR statt Zeitfenster-Matching.
  // =========================================================================
  describe("Design-Update 1 — Session-ID aus Env-Vars", () => {
    it("uebernimmt CLAUDE_CODE_SESSION_ID und CLAUDE_PROJECT_DIR in den Eintrag", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      process.env.CLAUDE_CODE_SESSION_ID = "f65dfbdc-9a0d-4735-85dd-eed6c615b9ad";
      process.env.CLAUDE_PROJECT_DIR = "/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome";

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false);
      await flushPending();

      const entry = lastWrittenQueue().sessions[0];
      expect(entry.sessionIds).toEqual(["f65dfbdc-9a0d-4735-85dd-eed6c615b9ad"]);
      expect(entry.projectDir).toBe("/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome");
    });

    it("faellt ohne CLAUDE_PROJECT_DIR auf process.cwd() zurueck, sessionIds bleibt leer ohne CLAUDE_CODE_SESSION_ID", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false);
      await flushPending();

      const entry = lastWrittenQueue().sessions[0];
      expect(entry.sessionIds).toEqual([]);
      expect(entry.projectDir).toBe(process.cwd());
    });
  });

  // =========================================================================
  // Design-Update 2 — /clear-Erkennung ueber die juengste .jsonl-Datei
  // (mtime) unter ~/.claude/projects/<slug>/.
  // =========================================================================
  describe("Design-Update 2 — /clear-Nachtragslogik", () => {
    it("traegt die UUID der juengsten .jsonl-Datei nach, wenn sie noch nicht bekannt ist", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      process.env.CLAUDE_CODE_SESSION_ID = "old-session-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      process.env.CLAUDE_PROJECT_DIR = "/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome";

      mockReaddir.mockResolvedValue([
        "old-session-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
        "new-session-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl",
      ] as never);
      mockStat.mockImplementation(async (p: unknown) => {
        const s = String(p);
        if (s.endsWith("old-session-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl")) {
          return { mtimeMs: 1000 } as never;
        }
        if (s.endsWith("new-session-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl")) {
          return { mtimeMs: 2000 } as never; // juenger -> soll nachgetragen werden
        }
        throw enoent();
      });

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false); // der erste Tool-Call flusht -> prueft dabei die .jsonl-Ordner
      await flushPending();

      const entry = lastWrittenQueue().sessions[0];
      expect(entry.sessionIds).toEqual([
        "old-session-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "new-session-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      ]);

      // Slug-Regel: alles ausser [a-zA-Z0-9] wird zu "-".
      expect(mockReaddir).toHaveBeenCalledWith(
        "/Users/testuser/.claude/projects/-Users-silbercue-Documents-Cursor-Skills-SilbercueChrome",
      );
    });

    it("haengt keine zweite ID an, wenn die juengste Datei bereits bekannt ist", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      process.env.CLAUDE_CODE_SESSION_ID = "known-session-cccc-cccc-cccc-cccccccccccc";
      process.env.CLAUDE_PROJECT_DIR = "/Users/silbercue/Documents/Cursor/Skills/SilbercueChrome";

      mockReaddir.mockResolvedValue(["known-session-cccc-cccc-cccc-cccccccccccc.jsonl"] as never);
      mockStat.mockResolvedValue({ mtimeMs: 5000 } as never);

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false);
      await flushPending();

      const entry = lastWrittenQueue().sessions[0];
      expect(entry.sessionIds).toEqual(["known-session-cccc-cccc-cccc-cccccccccccc"]);
    });

    it("schluckt Fehler still, wenn das Projekt-Verzeichnis nicht existiert", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      mockReaddir.mockRejectedValue(enoent());

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await expect(recorder.init()).resolves.toBeUndefined();
      recorder.recordToolResult(false);
      await flushPending();

      const entry = lastWrittenQueue().sessions[0];
      expect(entry.sessionIds).toEqual([]);
    });
  });

  // =========================================================================
  // onSpiral-Anbindung (Anker: ToolSequenceTracker.onSpiral) — attachTo()
  // =========================================================================
  describe("attachTo() — bindet sich an einen ToolSequenceTracker", () => {
    it("recordSpiral() wird beim exakten Tier-3-Uebergang des Trackers ausgeloest", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();

      const tracker = new ToolSequenceTracker();
      recorder.attachTo(tracker);

      const qs = new Set([FLAG_QUERY_SELECTOR]);
      for (let i = 1; i <= 8; i++) {
        tracker.record("evaluate", qs);
        tracker.evaluateStreakResponse();
      }

      recorder.recordToolResult(false); // erzeugt die Nutzung — ab hier wird geschrieben
      await recorder.shutdown();
      const entry = lastWrittenQueue().sessions[0];
      expect(entry.spirals).toBe(1);
    });
  });
  // =========================================================================
  // Aenderung 1 — Eintrag erst bei erster Nutzung, nicht schon beim init().
  // =========================================================================
  describe("Aenderung 1 — Eintrag erst bei erster Nutzung", () => {
    it("schreibt beim init() noch nichts", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      const recorder = new FrictionRecorder({ dataDir: "/fake" });

      await recorder.init();
      await flushPending();

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it("flusht beim ERSTEN recordToolResult() sofort, trotz Throttle", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();

      recorder.recordToolResult(false);
      await flushPending();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const entry = lastWrittenQueue().sessions[0];
      expect(entry.toolCalls).toBe(1);
    });

    it("schreibt beim shutdown() nichts, wenn nie ein Tool-Call kam", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";
      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();

      await recorder.shutdown();
      await flushPending();

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Aenderung 2 — beim Pruning fliegen Leereintraege zuerst.
  // =========================================================================
  describe("Aenderung 2 — Leereintraege beim Pruning zuerst", () => {
    it("verwirft den aeltesten LEEREN Eintrag, nicht den aeltesten benutzten", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";

      // 50 Alt-Eintraege: der aelteste ist benutzt (wertvoll), die restlichen 49 leer.
      const alt = Array.from({ length: 50 }, (_, i) => ({
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        cwd: "/some/project",
        pid: 2000 + i,
        projectDir: "/some/project",
        sessionIds: [],
        toolCalls: i === 0 ? 79 : 0,
        toolErrors: i === 0 ? 12 : 0,
        spirals: 0,
      }));
      mockReadFile.mockResolvedValue(
        JSON.stringify({ lastFrictioneerRun: "2026-07-01T00:00:00.000Z", sessions: alt }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false); // 51 Eintraege -> genau einer muss fallen
      await flushPending();

      const written = lastWrittenQueue();
      expect(written.sessions).toHaveLength(50);
      // Der benutzte Alt-Eintrag (pid 2000) hat ueberlebt.
      expect(written.sessions.some((s) => s.pid === 2000)).toBe(true);
      // Gefallen ist der aelteste LEERE (pid 2001).
      expect(written.sessions.some((s) => s.pid === 2001)).toBe(false);
    });

    it("faellt auf die Alters-Regel zurueck, wenn kein Eintrag leer ist", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";

      const alt = Array.from({ length: 50 }, (_, i) => ({
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        cwd: "/some/project",
        pid: 3000 + i,
        projectDir: "/some/project",
        sessionIds: [],
        toolCalls: 5,
        toolErrors: 0,
        spirals: 0,
      }));
      mockReadFile.mockResolvedValue(
        JSON.stringify({ lastFrictioneerRun: "2026-07-01T00:00:00.000Z", sessions: alt }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false);
      await flushPending();

      const written = lastWrittenQueue();
      expect(written.sessions).toHaveLength(50);
      // Ohne Leereintraege faellt der aelteste ueberhaupt (pid 3000).
      expect(written.sessions.some((s) => s.pid === 3000)).toBe(false);
      expect(written.sessions.some((s) => s.pid === 3001)).toBe(true);
    });

    it("wirft bei grossem Ueberhang erst alle Leereintraege und dann die aeltesten benutzten weg", async () => {
      process.env.SILBERCUE_CHROME_FRICTION_LOG = "1";

      // 54 Alt-Eintraege, davon 3 leer (pid 4010-4012). Mit dem eigenen Eintrag
      // sind es 55 -> 5 zu viel. Die 3 Leereintraege decken den Ueberhang NICHT,
      // also muessen danach noch die 2 aeltesten benutzten fallen.
      const alt = Array.from({ length: 54 }, (_, i) => ({
        startedAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        cwd: "/some/project",
        pid: 4000 + i,
        projectDir: "/some/project",
        sessionIds: [],
        toolCalls: i >= 10 && i <= 12 ? 0 : 5,
        toolErrors: 0,
        spirals: 0,
      }));
      mockReadFile.mockResolvedValue(
        JSON.stringify({ lastFrictioneerRun: "2026-07-01T00:00:00.000Z", sessions: alt }),
      );

      const recorder = new FrictionRecorder({ dataDir: "/fake" });
      await recorder.init();
      recorder.recordToolResult(false);
      await flushPending();

      const written = lastWrittenQueue();
      const pids = written.sessions.map((s) => s.pid);
      expect(pids).toHaveLength(50);

      // Erst alle drei Leereintraege raus — der benutzte Nachbar daneben bleibt.
      expect(pids).toContain(4013);
      expect(pids.filter((pid) => pid === 4010 || pid === 4011 || pid === 4012)).toEqual([]);

      // Danach die zwei aeltesten benutzten — der drittaelteste bleibt.
      expect(pids).toContain(4002);
      expect(pids.filter((pid) => pid === 4000 || pid === 4001)).toEqual([]);
    });
  });
});
