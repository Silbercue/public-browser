// capture-check.mjs — Festhalten: einen Test-Befehl (testDir/RUN) gegen eine frische App ausfuehren und
// nachpruefen (zweimal heil gruen, einmal kaputt rot).
//
// Sicherheit: VOR dem Lauf wird nie etwas beendet: ist ein Testport belegt (Lauscher oder Chrome mit diesem
// Debug-Port), wird der Lauf verweigert. NACH dem Lauf werden beendet (a) die eigene Prozessgruppe des
// Test-Befehls und (b) Lauscher/Chrome auf den Testports, die nicht im Schnappschuss vom Sitzungsbeginn
// stehen (der vorher geprueft leer war). Nie nach Name oder Muster allein. Restfenster: ein Browser, den der
// Nutzer genau waehrend des Laufs auf einem Testport startet, ist von einem Rest des Tests nicht zu
// unterscheiden.
// Der Test-Befehl laeuft in einer frischen Kopie des testDir, mit Env-Whitelist und eigenem HOME/TMPDIR.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readCaptureCommand } from './report-schema.mjs';
import { chromeProcessesOnPort, killPids, listeningPids, listProcesses, portBusy } from './proc.mjs';
import { toolchainDir } from './participants.mjs';
import { prng } from './seed.mjs';
import { spawnAppServer } from '../server/spawn.mjs';

/** Ports, die das publicbrowser-Paket fest nutzt (Chrome 9222, Server 9223). */
export const TEST_PORTS = [9222, 9223];
const OUTPUT_LIMIT = 4000;
const GROUP_GRACE_MS = 2000;
export const REFUSED_TEXT = 'Refused: port 9222 or 9223 was already in use before this session started. '
  + 'Python tests with publicbrowser would connect to that browser. Close it and start a new session.';

/** @returns {Promise<number[]>} alle PIDs, die gerade laufen */
export async function snapshotPids() {
  return listProcesses().map((p) => p.pid);
}

/**
 * Beendet auf den Testports lauschende Prozesse und Chrome-Hauptprozesse mit diesem Debug-Port,
 * sofern sie nicht in baselinePids stehen. Solche aus baselinePids landen in blockedBy.
 * @param {{ baselinePids: number[], ports?: number[] }} opts
 * @param {{ listeningPids?: typeof listeningPids, listProcesses?: typeof listProcesses, killPids?: typeof killPids }} [deps]
 * @returns {Promise<{ killed: number[], blockedBy: number[] }>}
 */
export async function cleanupTestPorts({ baselinePids, ports = TEST_PORTS }, deps = {}) {
  const d = { listeningPids, listProcesses, killPids, ...deps };
  const baseline = new Set(baselinePids || []);
  const procs = await d.listProcesses();
  const candidates = new Set();
  for (const port of ports) {
    for (const pid of await d.listeningPids(port)) candidates.add(pid);
    for (const p of chromeProcessesOnPort(port, procs)) candidates.add(p.pid);
  }
  candidates.delete(process.pid);
  const toKill = [...candidates].filter((pid) => !baseline.has(pid));
  const blockedBy = [...candidates].filter((pid) => baseline.has(pid));
  const killed = toKill.length ? await d.killPids(toKill) : [];
  return { killed, blockedBy };
}

/** Env-Schluessel, die ein Test-Befehl bekommt (alles andere wird nicht vererbt). */
export const RUN_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'APP_URL', 'PLAYWRIGHT_BROWSERS_PATH'];

/** Wo Playwright seine Browser ablegt, wenn HOME der echte waere (HOME zeigt im Lauf auf einen Tempordner). */
function playwrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
    : join(homedir(), '.cache', 'ms-playwright');
}

/** @param {string} appUrl @param {string} home @param {string} tmpDir */
function runEnv(appUrl, home, tmpDir) {
  const tc = toolchainDir();
  /** @type {Record<string, string>} */
  const env = {
    PATH: [join(tc, 'node_modules', '.bin'), join(tc, '.venv', 'bin'), process.env.PATH].filter(Boolean).join(delimiter),
    HOME: home,
    TMPDIR: tmpDir,
    APP_URL: appUrl,
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
  };
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

/** @param {number} pid @param {NodeJS.Signals} sig */
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* Gruppe leer */ } };

/** Lauscher auf den Testports und Chrome-Hauptprozesse mit diesem Debug-Port (ohne den eigenen Prozess). */
async function portHolders(ports, deps = {}) {
  const d = { listeningPids, listProcesses, ...deps };
  const procs = await d.listProcesses();
  const found = new Set();
  for (const port of ports) {
    for (const pid of await d.listeningPids(port)) found.add(pid);
    for (const p of chromeProcessesOnPort(port, procs)) found.add(p.pid);
  }
  found.delete(process.pid);
  return [...found];
}

/**
 * Fuehrt den Test-Befehl in einer eigenen Prozessgruppe aus, in einer frischen Kopie von testDir (cwd),
 * mit Env-Whitelist und eigenem HOME/TMPDIR je Lauf. Davor wird nie etwas beendet: belegter Testport = refused.
 * Danach: Reste der eigenen Gruppe und neue Lauscher auf den Testports beenden.
 * @param {{ testDir: string, command: string, appUrl: string, baselinePids: number[], timeoutMs?: number }} opts
 * @param {{ portBusy?: (port: number) => Promise<boolean>, ports?: number[], cleanup?: object }} [deps]
 * @returns {Promise<{ exit: number|null, ms: number, timedOut: boolean, refused: boolean, killed: number[], output: string }>}
 */
export async function runTestCommand({ testDir, command, appUrl, baselinePids, timeoutMs = 180_000 }, deps = {}) {
  const busy = deps.portBusy ?? portBusy;
  const ports = deps.ports ?? TEST_PORTS;
  const refusedRun = { exit: null, ms: 0, timedOut: false, refused: true, killed: [], output: REFUSED_TEXT };

  // (1) Vorher nichts beenden: belegt = verweigern.
  const before = await portHolders(ports, deps.cleanup);
  if (before.length) return refusedRun;
  for (const port of ports) if (await busy(port)) return refusedRun;

  // (2) Frische Kopie, eigenes HOME/TMPDIR.
  const runRoot = mkdtempSync(join(tmpdir(), 'cp-run-'));
  const work = join(runRoot, 'work');
  const home = join(runRoot, 'home');
  const tmpDir = join(runRoot, 'tmp');
  for (const dir of [home, tmpDir]) mkdirSync(dir);
  const nodeModules = join(testDir, 'node_modules');
  cpSync(testDir, work, { recursive: true, filter: (src) => src !== nodeModules });
  if (!existsSync(join(work, 'node_modules'))) symlinkSync(join(toolchainDir(), 'node_modules'), join(work, 'node_modules'), 'dir');

  const started = Date.now();
  let output = '';
  const add = (chunk) => { output = (output + chunk).slice(-OUTPUT_LIMIT); };
  const child = spawn('sh', ['-c', command], { cwd: work, env: runEnv(appUrl, home, tmpDir), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', add);
  child.stderr.on('data', add);

  let timedOut = false;
  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGTERM');
      setTimeout(() => signalGroup(child.pid, 'SIGKILL'), GROUP_GRACE_MS).unref();
    }, timeoutMs);
    child.once('error', (e) => { clearTimeout(timer); add(`\n${e.message}`); resolveExit(null); });
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
  const ms = Date.now() - started;
  // Zurueckgebliebene Mitglieder der eigenen Gruppe (z. B. `sleep &`) gehoeren zu diesem Lauf.
  signalGroup(child.pid, 'SIGTERM');
  await new Promise((r) => { setTimeout(r, 50); });
  signalGroup(child.pid, 'SIGKILL');
  child.stdout.destroy();
  child.stderr.destroy();

  // (3) Danach: was jetzt auf den Testports haengt, war vorher nicht da (before war leer).
  const after = await cleanupTestPorts({ baselinePids, ports }, deps.cleanup);
  rmSync(runRoot, { recursive: true, force: true });
  return { exit: timedOut ? null : exit, ms, timedOut, refused: false, killed: after.killed, output };
}

/** Zahl der Anfragen an /api, die der Server in seine Ereignisdatei geschrieben hat. */
function countApiRequests(eventsFile) {
  try {
    return readFileSync(eventsFile, 'utf8').split('\n').filter((l) => l.includes('"type":"api"')).length;
  } catch { return 0; }
}

/**
 * Eine frische App (eigene Ereignisdatei), den Test-Befehl dagegen, App stoppen, Anfragen zaehlen.
 * @param {{ testDir: string, command: string, seed: number, variant: 'healthy'|'broken', secretDir?: string|null,
 *   baselinePids: number[], timeoutMs?: number }} opts
 * @param {{ spawnApp?: typeof spawnAppServer }} [deps]
 */
export async function runOnFreshApp({ testDir, command, seed, variant, secretDir = null, baselinePids, timeoutMs }, deps = {}) {
  const eventsDir = mkdtempSync(join(tmpdir(), 'cp-events-'));
  const eventsFile = join(eventsDir, 'events.jsonl');
  try {
    const app = await (deps.spawnApp ?? spawnAppServer)({ seed, session: 'capture', variant, secretDir, eventsFile });
    let r;
    try {
      r = await runTestCommand({ testDir, command, appUrl: app.url, baselinePids, timeoutMs }, /** @type {any} */ (deps));
    } finally { await app.stop(); }
    return { ...r, appRequests: countApiRequests(eventsFile) };
  } finally { rmSync(eventsDir, { recursive: true, force: true }); }
}

/**
 * Reihenfolge der drei Laeufe: zweimal heil, einmal kaputt, die Stelle des kaputten Laufs aus dem Seed.
 * @param {number} seed
 * @returns {Array<'healthy'|'broken'>}
 */
export function captureOrder(seed) {
  const at = Math.floor(prng(`capture-order:${seed}`)() * 3);
  return /** @type {any} */ ([0, 1, 2].map((i) => (i === at ? 'broken' : 'healthy')));
}

const skipped = () => ({ exit: null, ms: 0, timedOut: false, refused: false, killed: [], appRequests: 0, output: 'Skipped: an earlier run was refused or timed out.', skipped: true });

/**
 * Nachpruefung: zweimal heil, einmal kaputt, je frische App.
 * Bricht nach einem verweigerten oder abgelaufenen Lauf ab (die uebrigen Laeufe stehen als skipped da).
 * @param {{ testDir: string, seed: number, secretDir?: string|null, baselinePids?: number[]|null, timeoutMs?: number }} opts
 * @param {{ portBusy?: (port: number) => Promise<boolean>, ports?: number[], cleanup?: object, spawnApp?: typeof spawnAppServer }} [deps]
 */
export async function checkCapture({ testDir, seed, secretDir = null, baselinePids = null, timeoutMs }, deps = {}) {
  const cmd = readCaptureCommand(testDir);
  if (!cmd.ok) return { command: null, healthy: [], broken: null, valid: false, reason: cmd.problems[0], order: [] };
  const baseline = baselinePids ?? await snapshotPids();

  const order = captureOrder(seed);
  /** @type {any[]} */
  const runs = [];
  for (const variant of order) {
    const prev = runs[runs.length - 1];
    runs.push(prev && (prev.refused || prev.timedOut || prev.skipped)
      ? skipped()
      : await runOnFreshApp({ testDir, command: cmd.command, seed, variant, secretDir, baselinePids: baseline, timeoutMs }, deps));
  }
  const healthy = runs.filter((_, i) => order[i] === 'healthy');
  const broken = runs[order.indexOf('broken')];
  const [h1, h2] = healthy;
  const executed = runs.filter((r) => !r.refused && !r.timedOut && !r.skipped);
  let reason = null;
  if (runs.some((r) => r.refused)) reason = 'ports busy';
  else if (runs.some((r) => r.timedOut)) reason = 'timeout';
  else if (executed.some((r) => r.appRequests === 0)) reason = 'test did not exercise the app';
  else if (h1.exit !== 0 && h2.exit !== 0) reason = 'healthy failed';
  else if (h1.exit !== 0 || h2.exit !== 0) reason = 'healthy flaky';
  else if (broken.exit === 0) reason = 'broken passed';
  return { command: cmd.command, healthy: [h1, h2], broken, valid: reason === null, reason, order };
}
