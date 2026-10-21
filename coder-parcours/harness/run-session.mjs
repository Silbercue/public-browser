#!/usr/bin/env node
// run-session.mjs — eine Coder-Parcours-Sitzung: frische App, blinde Claude-Code-Sitzung mit genau einem
// Teilnehmer, Auswertung (Sperre, Modell, Browser, Integritaet, Bericht bzw. Nachpruefung), Ergebnisdatei.
// CLI: node harness/run-session.mjs --participant <slug> --type explore|capture --seed <n> --round <name>
//        [--smoke] [--secret-dir <dir>] [--replace]
//
// Ordner: Rundir (Arbeitsordner des Agenten, cwd der Sitzung) und getrennt davon ein Steuerordner (session.json,
// Ereignisdatei, Shim run-my-test, run-my-test.log). Der Steuerordner wird am Ende geloescht, der Rundir bleibt.
// Beendet werden nur selbst gestartete Prozesse: App, Claude-Prozessgruppe, bei Public Browser neue Chrome-
// Prozesse auf 9333, bei capture die von run-my-test eingetragenen Reste (App, Test-Lauf). Auf 9222/9223 beendet
// die Sitzung nichts: das tut nur der Lauf eines Tests selbst, und nur waehrend er laeuft.
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, writeFileSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MODEL_PIN, cliCallsFromJsonl, isAlive, jsonlSlugFor, killGroup, mcpCallsFromJsonl, probeServerInfo,
  readModelFromJsonl, sh, spawnWithTimeout, usageTotal } from './blind-run-lib.mjs';
import { CP_PARTICIPANTS, cpDeps, devModeLinks, participantSkillText, scrubSessionEnv, toolchainBinDir, toolchainDir } from './participants.mjs';
import { defaultSecretFiles, needlesFromFiles, scrubSecrets } from './secrets.mjs';
import { toolLockMulti } from './guard.mjs';
import { browserBinaries, chromeProcessesOnPort, killPids, listProcesses, portBusy } from './proc.mjs';
import { OWN_PROCESSES_FILE, TEST_PORTS, checkCapture, isRunProcess, killOwnProcesses, snapshotPids } from './capture-check.mjs';
import { BUDGETS, renderSessionPrompt } from './prompt.mjs';
import { normalizeExploreReport } from './report-schema.mjs';
import { SESSION_SCHEMA, sessionFileName, validateSessionResult } from './result-schema.mjs';
import { buildRunConfig, runConfigSha } from './seed.mjs';
import { loadCatalog } from '../catalog/load.mjs';
import { spawnAppServer } from '../server/spawn.mjs';
import { RUNTIME_MARKER } from '../server/bug-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CP_ROOT = join(HERE, '..');
const RESULTS_ROOT = join(CP_ROOT, 'results');
const GUARD_HOOK = join(HERE, 'guard-hook.mjs');
const PB_PORT = 9333;
const SMOKE = { maxTurns: 15, wallMin: 8 };

/**
 * Tool-Eingaben mit runtime.js oder Tool-Ergebnisse mit RUNTIME_MARKER (volle Inhalte, nicht gekuerzt).
 * Write-Eingaben zaehlen nicht: ein Bericht darf die Datei nennen, ohne sie gelesen zu haben.
 */
export function readsBugScript(jsonlText) {
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (obj.type === 'assistant' && c?.type === 'tool_use' && c.name !== 'Write' && JSON.stringify(c.input ?? null).includes('runtime.js')) return true;
      if (obj.type === 'user' && c?.type === 'tool_result' && JSON.stringify(c.content ?? null).includes(RUNTIME_MARKER)) return true;
    }
  }
  return false;
}

/**
 * Werkzeug-Eingaben (ausser Write) mit einer file:-Adresse: Browser aller Teilnehmer koennen damit lokale Dateien
 * oeffnen (Verzeichnislisten, Ereignisdatei, Schluessel), vorbei an Lese- und Befehlssperre.
 */
export function readsLocalFiles(jsonlText) {
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content;
    if (obj?.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use' && c.name !== 'Write' && /\bfile:\//i.test(JSON.stringify(c.input ?? null))) return true;
    }
  }
  return false;
}

/** Alle regulaeren Dateien unter dir (Symlinks wie testDir/node_modules werden nicht verfolgt). */
function filesUnder(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };

/**
 * Festhalten: Spuren eines Zugriffs ausserhalb des Testordners in RUN, den Testdateien und dem
 * run-my-test-Protokoll. RUN laeuft ohne Befehlssperre, das hier ist das einzige Gegenmittel.
 * In allen Dateien gesucht: realer Pfad von coder-parcours/ und des Ergebnisordners, secretDir, `--secret-dir`,
 * `runtime.js`, RUNTIME_MARKER. Nur in den Dateien des Agenten (RUN, testDir) zusaetzlich: Heimatpfad und
 * `ps`-Aufrufe (im Protokoll stehen Stacktraces und Browser-Cache-Pfade unter dem Heimatordner).
 * Pfade der Werkzeugkette (liegt unter coder-parcours/, taucht in Playwright-Stacktraces auf) werden vorher entfernt.
 * @param {{ testDir: string, logFile: string, secretDir?: string|null, resultsRoot?: string, ctl?: string|null, home?: string }} o
 */
export function captureOutsideAccess({ testDir, logFile, secretDir = null, resultsRoot = RESULTS_ROOT, ctl = null, home = homedir() }) {
  const needles = [realOr(CP_ROOT), CP_ROOT, realOr(resultsRoot), resultsRoot, '--secret-dir', 'runtime.js', RUNTIME_MARKER];
  if (secretDir) needles.push(secretDir, realOr(secretDir));
  // Der Steuerordner steht im Shim, nicht im Protokoll (dort nennt ihn der eigene Aufruf): nur in Agenten-Dateien gesucht.
  const agentNeedles = ctl ? [...needles, ctl, realOr(ctl)] : needles;
  const tc = [realOr(toolchainDir()), toolchainDir()];
  // Absolute Pfad-Tokens vorher normalisieren, damit `<toolchain>/../../<geschuetzt>` nicht als Werkzeugkette durchgeht.
  const normalize = (text) => text.replace(/(^|[\s"'`=(])(\/[^\s"'`;|&()<>]*)/g,
    (m, pre, tok) => (/\/\.\.?(\/|$)/.test(tok) ? pre + resolve(tok) : m));
  // Agenten-Dateien: nur der exakte Praefix <toolchain>/node_modules/ ist Werkzeugkette (Stacktraces der Testbibliothek).
  const readAgent = (f) => { let text = normalize(readFileSync(f, 'utf8')); for (const t of tc) text = text.split(`${t}/node_modules/`).join(''); return text; };
  // Protokoll von run-my-test: der Werkzeugkette-Ordner insgesamt.
  const readLog = (f) => { let text = normalize(readFileSync(f, 'utf8')); for (const t of tc) text = text.split(t).join(''); return text; };
  const hitIn = (list) => (text) => list.some((n) => n && text.includes(n));
  // `ps` nur als Befehlsanfang einer Shell-Zeile (Zeilenanfang oder nach ; & | ( ), und nur in RUN und *.sh: eine
  // Python-Variable `ps = ...` oder ein Wort im Text ist kein Aufruf.
  const PS = /(^|[;&|(])[ \t]*ps(?![\w=.-])(?![ \t]*=)/m;
  // Linux: /proc/<pid>/fd/<n> eines fremden Prozesses oeffnet dessen Leitungen (auch den Zaehlkanal der App, Task 12).
  const PROC_FD = /\/proc\/(?:\d+|self|\$[\w{}$]+)\/fd\b/;
  const isShellFile = (f) => basename(f) === 'RUN' || f.endsWith('.sh');
  for (const f of filesUnder(testDir)) {
    const text = readAgent(f);
    if (hitIn(agentNeedles)(text) || (home && home.length > 1 && text.includes(home)) || PROC_FD.test(text) || (isShellFile(f) && PS.test(text))) return true;
  }
  return existsSync(logFile) ? hitIn(needles)(readLog(logFile)) : false;
}

/** Ersetzt jedes Vorkommen des Heimatpfads durch ~. */
const scrubHome = (text, home = homedir()) => (home && home.length > 1 ? String(text).split(home).join('~') : String(text));

/** Schreibt content an die erste freie Stelle <base>-<n>.json (n ab 1). */
function writeNumbered(dir, base, content) {
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, `${base}-${n}.json`);
    try { writeFileSync(p, content, { flag: 'wx' }); return p; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`no free file name for ${base} in ${dir}`);
}

/** Werkzeuge, erlaubte Befehlskoepfe und Hook je Teilnehmerart und Sitzungstyp (Plan Task 13, Schritt 4). */
function toolSetup(p, type, rundir) {
  const isCli = p.kind === 'cli';
  const extra = p.extraCommands || [];
  let tools;
  let heads;
  if (type === 'explore') {
    tools = isCli ? 'Bash,Read,Write' : 'Write';
    heads = isCli ? [p.cli, ...extra] : [];
  } else {
    tools = isCli ? 'Bash,Read,Write' : 'Bash,Write';
    heads = isCli ? [p.cli, ...extra, 'run-my-test'] : ['run-my-test'];
  }
  const allowed = ['Write', ...(isCli ? ['Read'] : [`mcp__${p.name}`]), ...heads.map((h) => `Bash(${h}:*)`)];
  const hook = heads.length ? { hooks: { PreToolUse: [{ matcher: 'Bash|Read', hooks: [{ type: 'command',
    command: `"${process.execPath}" "${GUARD_HOOK}" ${heads.join(',')} "${rundir}"` }] }] } } : null;
  return { tools, heads, allowed, hook, read_root: isCli ? rundir : null };
}

/**
 * Skill-Dateien eines CLI-Teilnehmers in den Rundir kopieren (damit Anweisungen wie `cp {SKILL_DIR}/templates/…`
 * ausfuehrbar sind) und den Skill-Text mit einem Vorspann ueber deren Ort nach skill.md schreiben.
 */
function prepareSkill(slug, p, rundir) {
  const skill = participantSkillText(slug);
  const base = p.vendoredDir || join(toolchainDir(), 'node_modules', ...p.package.split('/'));
  const skillDir = join(rundir, 'skill');
  for (const rel of p.skillFiles || []) {
    mkdirSync(dirname(join(skillDir, rel)), { recursive: true });
    copyFileSync(join(base, rel), join(skillDir, rel));
  }
  const preamble = `The skill files below are also on disk in ${skillDir}; each section heading (# <path>) is the file's path `
    + 'relative to that folder. Where a skill writes {SKILL_DIR}, it means the folder in there that holds that skill\'s SKILL.md.\n\n';
  const text = preamble + skill.text;
  writeFileSync(join(rundir, 'skill.md'), text);
  return { files: skill.files, sha256: createHash('sha256').update(text).digest('hex'), dir: skillDir };
}

/** Werkzeugname im Auftrag: bis auf diesen Namen ist der Text fuer alle Teilnehmer gleich. */
const toolNameOf = (p) => (p.kind === 'cli' ? `the ${p.cli} command` : `the ${p.display} MCP tools`);

const readEvents = (file) => {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* halbe Zeile beim Stoppen */ }
  }
  return out;
};

/**
 * @param {{ slug: string, type: 'explore'|'capture', seed: number, round: string, smoke?: boolean,
 *   secretDir?: string|null, replace?: boolean }} opts
 * @param {{ cp?: object, envOverrides?: Record<string, string>, resultsRoot?: string, wallMs?: number,
 *   portBusy?: (port: number) => Promise<boolean>, listProcesses?: () => Array<{ pid: number, command: string }>,
 *   chromeVersion?: () => string|null, runMyTestCmd?: string[], captureDeps?: any, spawnApp?: typeof spawnAppServer,
 *   allowPublicDir?: boolean, devModeLinks?: () => string[], secretFiles?: string[],
 *   onAppStarted?: (app: { url: string, port: number }) => any, inspectCtl?: (ctl: string, rundir: string) => any,
 *   log?: (line: string) => void }} [deps]
 * @returns {Promise<{ result: any, outPath: string }>}
 */
export async function runSession({ slug, type, seed, round, smoke = false, secretDir = null, replace = false }, deps = {}) {
  const p = CP_PARTICIPANTS[slug];
  if (!p) throw new Error(`unknown participant ${slug}; known: ${Object.keys(CP_PARTICIPANTS).join(', ')}`);
  if (type !== 'explore' && type !== 'capture') throw new Error(`unknown session type ${type}`);
  if (!Number.isInteger(seed)) throw new Error(`seed must be an integer (got ${seed})`);
  if (typeof round !== 'string' || !/^[A-Za-z0-9._-]+$/.test(round) || round.startsWith('.')) throw new Error(`invalid round name ${round}`);

  // Ein umgeleiteter Katalog (nur fuer Tests) wuerde still den falschen Katalog messen; der Fingerabdruck sieht ihn nicht.
  if (process.env.CODER_PARCOURS_PUBLIC_DIR && !deps.allowPublicDir) {
    throw new Error('CODER_PARCOURS_PUBLIC_DIR is set: this session would measure another catalog than bugs/public; unset it');
  }

  const base = { ...cpDeps(), ...(deps.cp || {}) };
  const roundDir = join(deps.resultsRoot ?? RESULTS_ROOT, round);
  const fileName = sessionFileName({ slug, type, seed });
  const stem = fileName.replace(/\.json$/, '');
  const finalPath = join(roundDir, 'sessions', fileName);
  if (existsSync(finalPath) && !replace) throw new Error(`${finalPath} already exists; use --replace to run this session again`);

  const isCli = p.kind === 'cli';
  const busy = deps.portBusy ?? portBusy;
  const listProcs = deps.listProcesses ?? (() => listProcesses());
  const log = deps.log ?? (() => {});
  const capDeps = deps.captureDeps ?? {};

  // Schritt 1: Konfiguration, Ordner, Schnappschuss vor App- und Claude-Start.
  const baselinePids = await snapshotPids();
  const baselineSet = new Set(baselinePids);
  const catalog = await loadCatalog({ secretDir });
  const runConfig = buildRunConfig({ seed, sessionType: type, catalog, variant: type === 'capture' ? 'healthy' : null });
  const rundir = mkdtempSync(join(tmpdir(), `cp-${slug}-${type}-s${seed}-`));
  const ctl = mkdtempSync(join(tmpdir(), 'cp-ctl-'));
  const testDir = join(rundir, 'test');
  if (type === 'capture') mkdirSync(testDir);
  const sessionJson = `${JSON.stringify({ seed, testDir, baselinePids })}\n`;
  writeFileSync(join(ctl, 'session.json'), sessionJson);
  const sessionJsonSha = createHash('sha256').update(sessionJson).digest('hex');
  const eventsFile = join(ctl, 'events.jsonl');
  const logFile = join(ctl, 'run-my-test.log');
  const reportPath = join(rundir, 'report.json');

  const envOverrides = deps.envOverrides || {};
  const projectsDir = join(envOverrides.HOME ?? homedir(), '.claude', 'projects');
  const childEnv = scrubSessionEnv({ ...process.env, ...envOverrides });
  const sessionId = randomUUID();
  const setup = toolSetup(p, type, rundir);
  const maxTurns = smoke ? SMOKE.maxTurns : BUDGETS[type].maxTurns;
  const wallMs = deps.wallMs ?? (smoke ? SMOKE.wallMin : BUDGETS[type].wallMin) * 60_000;
  const mcpPrefix = isCli ? `cli__${p.cli}__` : `mcp__${p.name}__`;
  const cliBinDir = isCli ? (p.binDir || toolchainBinDir()) : null;
  const cliBin = cliBinDir ? join(cliBinDir, p.cli) : null;

  /** @type {string[]} */
  const notes = [];
  let aborted = false;
  const abort = (msg) => { aborted = true; notes.push(`aborted: ${msg}`); };
  let app = null;
  let res = null;
  let result = null;
  let serverInfo = null;
  let skillInfo = null;
  let claudeVer = null;
  let chromeVer = null;
  let flags = [];
  let jsonlText = '';
  let jsonlSha = null;
  let model = null;
  let calls = [];
  let toolLock = { bash_attempted: 0, bash_denied: false, read_attempted: 0, read_denied: false, non_mcp_executed: [] };
  const integrity = { read_bug_script: false, capture_outside_access: false, local_file_access: false };
  let wallClockS = 0;
  let report = null;
  let capture = null;
  let events = [];
  let tokens = { delta: null, rounds: null, dedup: null, result_usage_total: null };
  const browsersSeen = new Set();
  let sessionEnv = childEnv;
  let pbStarted = false;

  const sampleBrowsers = () => {
    try {
      // Browser, die der Test des Agenten unter seinem Arbeitsordner (cp-run-...) startet, gehoeren dem Test,
      // nicht dem Browser-Werkzeug des Teilnehmers.
      const procs = listProcs();
      const testOwned = new Set(procs.filter((x) => isRunProcess(x.command)).map((x) => x.pid));
      for (const b of browserBinaries(procs)) if (!baselineSet.has(b.pid) && !testOwned.has(b.pid)) browsersSeen.add(b.binary);
    } catch { /* ps nicht verfuegbar: Beleg fehlt, Sitzung geht weiter */ }
  };

  try {
    try {
      // Schritt 2: Ports pruefen, App starten.
      if (type === 'capture') {
        const taken = [];
        for (const port of TEST_PORTS) if (await busy(port)) taken.push(port);
        if (taken.length) throw new Error('ports 9222/9223 busy');
      }
      if (slug === 'public-browser') {
        const dev = (deps.devModeLinks ?? devModeLinks)();
        if (dev.length) throw new Error('Public Browser dev mode is active (an npx cache links build/ to a local build); run npm run dev:off in the Public Browser repository, then start again');
        if (await busy(PB_PORT)) throw new Error(`port ${PB_PORT} already in use; close that program first`);
        pbStarted = true;
      }
      app = await (deps.spawnApp ?? spawnAppServer)({ seed, session: type, variant: type === 'capture' ? 'healthy' : null, secretDir, eventsFile });
      await deps.onAppStarted?.(app);

      // Schritt 3: Teilnehmer vorbereiten.
      if (!existsSync(base.claude.file)) throw new Error(`claude binary not found: ${base.claude.file}`);
      claudeVer = sh(base.claude.file, [...base.claude.argsPrefix, '--version'], { env: childEnv }).trim().split(/\s+/)[0] || null;
      if (!claudeVer) throw new Error('claude --version returned nothing');
      if (deps.chromeVersion) chromeVer = deps.chromeVersion();
      else if (base.chromeBin) { try { chromeVer = sh(base.chromeBin, ['--version']).trim().replace(/^Google Chrome /, ''); } catch { chromeVer = null; } }

      const env = p.env(rundir, base);
      if (isCli) {
        if (!existsSync(cliBin)) throw new Error(`cli binary not found: ${cliBin} (run node harness/setup.mjs)`);
        sessionEnv = { ...childEnv, ...env };
        const verOut = sh(cliBin, ['--version'], { env: sessionEnv, cwd: rundir }).trim();
        skillInfo = prepareSkill(slug, p, rundir);
        serverInfo = { name: p.cli, version: (verOut.match(/\d+\.\d+\.\d+[^\s]*/g) || []).pop() ?? null, instructions: null };
        p.setup?.(rundir, base);
        writeFileSync(join(rundir, 'mcp.json'), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
      } else {
        const args = [...p.args, ...(p.extraArgs ? p.extraArgs(base) : [])];
        writeFileSync(join(rundir, 'mcp.json'), `${JSON.stringify({ mcpServers: { [p.name]: { command: p.command, args, env } } }, null, 2)}\n`);
        serverInfo = await probeServerInfo({ ...p, args }, env, { ...base, envOverrides: { ...(base.envOverrides || {}), ...envOverrides } }, { cwd: rundir });
      }
      const expectVersion = p.serverVersion ?? p.version;
      if (serverInfo.version !== expectVersion) throw new Error(`version mismatch: ${p.name} reports ${serverInfo.version}, pinned ${expectVersion}`);

      // Schritt 4: Shim, PATH, Auftrag, Flags.
      const pathParts = [];
      if (type === 'capture') {
        mkdirSync(join(ctl, 'bin'));
        const cmd = deps.runMyTestCmd ?? [process.execPath, join(HERE, 'run-my-test.mjs')];
        const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
        // Ohne secretDir: die heile App hat in capture ohnehin keinen aktiven Fehler, und jeder Weg, den Pfad
        // ans Shim zu geben, laege fuer RUN (laeuft ohne Sperre als derselbe Benutzer) offen.
        writeFileSync(join(ctl, 'bin', 'run-my-test'), `#!/bin/sh\nexec ${cmd.map(q).join(' ')} --ctl ${q(ctl)}\n`);
        chmodSync(join(ctl, 'bin', 'run-my-test'), 0o755);
        pathParts.push(join(ctl, 'bin'));
      }
      if (cliBinDir) pathParts.push(cliBinDir);
      sessionEnv = { ...sessionEnv, PATH: [...pathParts, sessionEnv.PATH ?? ''].filter(Boolean).join(delimiter) };

      const prompt = renderSessionPrompt({ type, toolName: toolNameOf(p), appUrl: app.url, runConfig, catalog, reportPath, testDir, smoke });
      flags = ['--model', MODEL_PIN, '--output-format', 'json', '--session-id', sessionId,
        '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(rundir, 'mcp.json'),
        '--permission-mode', 'dontAsk', '--allowedTools', ...setup.allowed, '--tools', setup.tools,
        ...(setup.hook ? ['--settings', JSON.stringify(setup.hook)] : []),
        ...(isCli ? ['--append-system-prompt-file', join(rundir, 'skill.md')] : []),
        '--max-turns', String(maxTurns)];

      log(`[run-session] ${slug} ${type} seed ${seed} -> ${rundir}`);
      const spawnedAt = Date.now();
      const sampler = setInterval(sampleBrowsers, 3000);
      try {
        res = await spawnWithTimeout(base.claude.file, [...base.claude.argsPrefix, '-p', prompt, ...flags],
          { cwd: rundir, env: sessionEnv, timeoutMs: wallMs, stderrFile: join(rundir, 'claude.log') });
      } finally {
        clearInterval(sampler);
        sampleBrowsers();
      }
      wallClockS = Math.round((Date.now() - spawnedAt) / 1000);
      try { result = JSON.parse(res.stdout); } catch { result = null; }
      if (res.error) abort(`claude spawn failed: ${res.error.message}`);

      // session.json steuert run-my-test (testDir, baselinePids): eine Aenderung durch die Sitzung bricht sie ab.
      let sessionJsonNow = null;
      try { sessionJsonNow = createHash('sha256').update(readFileSync(join(ctl, 'session.json'))).digest('hex'); } catch { /* fehlt: Abweichung */ }
      if (sessionJsonNow !== sessionJsonSha) abort('session.json in the control folder was changed or removed during the session');

      // Schritt 5: Protokoll auswerten.
      const jsonlPath = join(projectsDir, jsonlSlugFor(rundir), `${sessionId}.jsonl`);
      jsonlText = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf8') : '';
      if (!jsonlText) abort('session JSONL missing');
      jsonlSha = jsonlText ? createHash('sha256').update(jsonlText).digest('hex') : null;
      model = readModelFromJsonl(jsonlText);
      if (jsonlText && !model) abort('model not found in session JSONL');
      else if (model && !model.startsWith(MODEL_PIN)) abort(`model mismatch: ${model} (pinned ${MODEL_PIN})`);
      calls = isCli ? cliCallsFromJsonl(jsonlText, p.cli) : mcpCallsFromJsonl(jsonlText, mcpPrefix);
      toolLock = toolLockMulti(jsonlText, { mcpPrefix: isCli ? undefined : mcpPrefix, heads: setup.heads, readRoot: setup.read_root ?? undefined, writeRoot: rundir });
      if (toolLock.non_mcp_executed.length) abort(`fairness violated, tools outside the lock executed: ${toolLock.non_mcp_executed.join(', ')}`);
      const nonChrome = [...browsersSeen].filter((b) => b !== base.chromeBin);
      if (nonChrome.length) abort(`non-Google-Chrome browser process seen: ${nonChrome.join(', ')}`);
      integrity.read_bug_script = readsBugScript(jsonlText);
      integrity.local_file_access = readsLocalFiles(jsonlText);
      if (type === 'capture') integrity.capture_outside_access = captureOutsideAccess({ testDir, logFile, secretDir, ctl, resultsRoot: deps.resultsRoot ?? RESULTS_ROOT });

      // Schritt 7 (Teil): Token aus dem Mess-Skript, Kosten aus total_cost_usd.
      if (jsonlText) {
        try {
          const cost = JSON.parse(sh('bash', [join(base.measureDir, 'measure-session-cost.sh'), jsonlSlugFor(rundir), sessionId], { env: childEnv }));
          tokens = { delta: cost?.total?.all ?? null, rounds: cost?.rounds ?? null, dedup: cost?.dedup ?? null, result_usage_total: null };
        } catch (e) {
          notes.push(`measurement failed: ${String(e.message).slice(0, 300)}`);
        }
      }
      tokens.result_usage_total = usageTotal(result?.usage);
    } catch (e) {
      abort(e.message);
    }

    // Schritt 6: Bericht bzw. Nachpruefung.
    if (type === 'explore') {
      const n = normalizeExploreReport(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null);
      report = { ok: n.ok, problems: n.problems, normalized: n.report };
    } else if (aborted) {
      capture = { command: null, healthy: [], broken: null, valid: false, reason: 'session aborted' };
    } else {
      capture = await checkCapture({ testDir, seed, secretDir, baselinePids }, capDeps);
    }
  } finally {
    // Schritt 9: nur selbst Gestartetes beenden.
    if (app) { try { await app.stop(); } catch (e) { notes.push(`app stop failed: ${e.message}`); } }
    if (res?.pid && isAlive(res.pid)) {
      killGroup(res.pid, 'SIGTERM');
      setTimeout(() => killGroup(res.pid, 'SIGKILL'), 10_000).unref();
    }
    if (pbStarted) {
      try {
        const own = chromeProcessesOnPort(PB_PORT, listProcesses()).map((x) => x.pid).filter((pid) => !baselineSet.has(pid));
        if (own.length) await killPids(own);
      } catch (e) { notes.push(`chrome cleanup on ${PB_PORT} failed: ${String(e.message).slice(0, 120)}`); }
    }
    if (isCli && cliBin && existsSync(cliBin) && p.cleanupArgs) {
      try { sh(cliBin, p.cleanupArgs, { cwd: rundir, env: sessionEnv, timeout: 30_000 }); } catch (e) {
        notes.push(`cli cleanup failed: ${String(e.message).slice(0, 120)}`);
      }
    }
    if (type === 'capture') {
      // Nach einem Abbruch mitten in run-my-test: genau dessen App und Test-Lauf beenden, sonst nichts.
      try { await killOwnProcesses(join(ctl, OWN_PROCESSES_FILE), { baselinePids, listProcs: listProcesses }); } catch (e) {
        notes.push(`cleanup of own processes failed: ${String(e.message).slice(0, 120)}`);
      }
    }
    events = readEvents(eventsFile);
    try { await deps.inspectCtl?.(ctl, rundir); } finally { rmSync(ctl, { recursive: true, force: true }); }
  }

  // Schritt 8: Status.
  let status;
  if (aborted) status = 'aborted';
  else if (res?.timedOut) { status = 'timeout'; notes.push('wall-clock limit reached'); }
  else if (result?.subtype === 'error_max_turns') { status = 'budget'; notes.push('turn limit reached'); }
  else if (res?.code !== 0) { status = 'aborted'; notes.push(`aborted: claude exited with code ${res?.code}`); }
  else status = 'ok';
  if (type === 'explore' && !report.ok) notes.push(`report: ${report.problems.join('; ')}`);
  const costKnown = Number.isFinite(result?.total_cost_usd);
  if (!costKnown && res) notes.push('cost unknown: no result usage');

  const obj = {
    schema: SESSION_SCHEMA,
    participant: { slug, display: p.display, kind: p.kind, package: p.package ?? null, version: p.version ?? null },
    session: { type, seed, round, run_config: runConfig, run_config_sha256: runConfigSha(runConfig) },
    status,
    model: model || 'unknown',
    harness: {
      claude_code_version: claudeVer, os: `${process.platform} ${release()}`, node: process.version, chrome_version: chromeVer,
      wall_clock_s: wallClockS, exit_code: res?.code ?? null, timed_out: res?.timedOut ?? false, num_turns: result?.num_turns ?? null,
      flags: flags.join(' ').split(sessionId).join('<session_id>'),
      tool_setup: setup, max_turns: maxTurns, wall_limit_s: Math.round(wallMs / 1000), smoke,
      tool_lock: toolLock, session_jsonl_sha256: jsonlSha,
      calls_ledger: calls.map((c, i) => ({ i: i + 1, tool: c.name, chars: c.chars, ...(Number.isFinite(c.ms) ? { ms: c.ms } : {}) })),
      integrity,
      server_info: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : null,
      skill: skillInfo ? { files: skillInfo.files, sha256: skillInfo.sha256 } : null,
      browser_binaries: [...browsersSeen], profile_isolation: p.profile_isolation ?? null,
      run_dir: rundir,
    },
    tokens,
    cost_usd_list: costKnown ? [result.total_cost_usd] : [],
    ...(type === 'explore' ? { report } : { capture }),
    events,
    notes,
  };
  const needles = needlesFromFiles(deps.secretFiles ?? defaultSecretFiles(CP_ROOT));
  const scrubbed = scrubSecrets(scrubHome(JSON.stringify(obj)), { needles });
  const finalObj = JSON.parse(scrubbed.text);
  if (scrubbed.count) finalObj.notes.push(`secrets: ${scrubbed.count} value(s) that look like keys were replaced in this file`);
  const problems = validateSessionResult(finalObj);
  if (problems.length) throw new Error(`session result invalid: ${problems.join('; ')}`);
  const content = `${JSON.stringify(finalObj, null, 2)}\n`;

  let outPath;
  let rawPath;
  if (status === 'aborted') {
    outPath = writeNumbered(join(roundDir, 'aborted'), stem, content);
    rawPath = join(roundDir, 'raw', `aborted-${outPath.split('/').pop().replace(/\.json$/, '')}.jsonl`);
  } else {
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(finalPath, content);
    outPath = finalPath;
    rawPath = join(roundDir, 'raw', `${stem}.jsonl`);
  }
  if (jsonlText) {
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, scrubSecrets(scrubHome(jsonlText), { needles }).text);
  }
  return { result: finalObj, outPath };
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const { values } = parseArgs({ options: {
    participant: { type: 'string' }, type: { type: 'string' }, seed: { type: 'string' }, round: { type: 'string' },
    smoke: { type: 'boolean', default: false }, 'secret-dir': { type: 'string' }, replace: { type: 'boolean', default: false },
  } });
  if (!values.participant || !values.type || !values.seed || !values.round) {
    process.stderr.write('usage: node harness/run-session.mjs --participant <slug> --type explore|capture --seed <n> --round <name> [--smoke] [--secret-dir <dir>] [--replace]\n');
    process.exit(2);
  }
  try {
    const { result, outPath } = await runSession({
      slug: values.participant, type: /** @type {'explore'|'capture'} */ (values.type), seed: Number(values.seed), round: values.round,
      smoke: values.smoke, secretDir: values['secret-dir'] ?? null, replace: values.replace,
    }, { log: (l) => process.stdout.write(`${l}\n`) });
    process.stdout.write(`${result.status}: ${outPath}\n${result.notes.length ? `notes: ${result.notes.join(' | ')}\n` : ''}`);
  } catch (e) {
    process.stderr.write(`run-session: ${e.message}\n`);
    process.exit(1);
  }
}
