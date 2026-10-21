// capture-check.mjs — Festhalten: einen Test-Befehl (testDir/RUN) gegen eine frische App ausfuehren und
// nachpruefen (zweimal heil gruen, einmal kaputt rot).
//
// Sicherheit: Beendet werden nur (a) die eigene Prozessgruppe des Test-Befehls und (b) Prozesse, die auf
// einem Testport lauschen oder Chrome mit diesem Debug-Port sind UND nicht im Schnappschuss vom
// Sitzungsbeginn stehen. Nie nach Name oder Muster allein. Wer schon vor Sitzungsbeginn lief (z. B. der
// eigene Chrome mit Konten), wird nie beendet; dann wird der Lauf verweigert.
import { spawn } from 'node:child_process';
import { lstatSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { readCaptureCommand } from './report-schema.mjs';
import { chromeProcessesOnPort, killPids, listeningPids, listProcesses, portBusy } from './proc.mjs';
import { scrubSessionEnv, toolchainDir } from './participants.mjs';
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

/** testDir/node_modules -> toolchain/node_modules, falls dort noch nichts liegt. */
function linkToolchainModules(testDir) {
  const link = join(testDir, 'node_modules');
  try { lstatSync(link); return; } catch { /* fehlt */ }
  symlinkSync(join(toolchainDir(), 'node_modules'), link, 'dir');
}

/** @param {number} pid @param {NodeJS.Signals} sig */
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* Gruppe leer */ } };

/**
 * Fuehrt den Test-Befehl in einer eigenen Prozessgruppe aus; raeumt davor und danach die Testports auf.
 * @param {{ testDir: string, command: string, appUrl: string, baselinePids: number[], timeoutMs?: number }} opts
 * @param {{ portBusy?: (port: number) => Promise<boolean>, ports?: number[], cleanup?: object }} [deps]
 * @returns {Promise<{ exit: number|null, ms: number, timedOut: boolean, refused: boolean, killed: number[], output: string }>}
 */
export async function runTestCommand({ testDir, command, appUrl, baselinePids, timeoutMs = 180_000 }, deps = {}) {
  const busy = deps.portBusy ?? portBusy;
  const ports = deps.ports ?? TEST_PORTS;
  const killed = new Set();
  const cleanup = async () => {
    const r = await cleanupTestPorts({ baselinePids, ports }, deps.cleanup);
    for (const pid of r.killed) killed.add(pid);
  };

  await cleanup();
  for (const port of ports) {
    if (await busy(port)) {
      return { exit: null, ms: 0, timedOut: false, refused: true, killed: [...killed], output: REFUSED_TEXT };
    }
  }

  linkToolchainModules(testDir);
  const tc = toolchainDir();
  const env = scrubSessionEnv(process.env);
  env.APP_URL = appUrl;
  env.PATH = [join(tc, 'node_modules', '.bin'), join(tc, '.venv', 'bin'), env.PATH].filter(Boolean).join(delimiter);

  const started = Date.now();
  let output = '';
  const add = (chunk) => { output = (output + chunk).slice(-OUTPUT_LIMIT); };
  const child = spawn('sh', ['-c', command], { cwd: testDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

  await cleanup();
  return { exit: timedOut ? null : exit, ms, timedOut, refused: false, killed: [...killed], output };
}

const skipped = () => ({ exit: null, ms: 0, timedOut: false, refused: false, killed: [], output: 'Skipped: an earlier run was refused or timed out.', skipped: true });

/**
 * Nachpruefung: zweimal heil, einmal kaputt, je frische App.
 * Bricht nach einem verweigerten oder abgelaufenen Lauf ab (die uebrigen Laeufe stehen als skipped da).
 * @param {{ testDir: string, seed: number, secretDir?: string|null, baselinePids?: number[]|null, timeoutMs?: number }} opts
 * @param {{ portBusy?: (port: number) => Promise<boolean>, ports?: number[], cleanup?: object, spawnApp?: typeof spawnAppServer }} [deps]
 */
export async function checkCapture({ testDir, seed, secretDir = null, baselinePids = null, timeoutMs }, deps = {}) {
  const cmd = readCaptureCommand(testDir);
  if (!cmd.ok) return { command: null, healthy: [], broken: null, valid: false, reason: cmd.problems[0] };
  const baseline = baselinePids ?? await snapshotPids();
  const spawnApp = deps.spawnApp ?? spawnAppServer;

  /** @param {'healthy'|'broken'} variant */
  const once = async (variant) => {
    const app = await spawnApp({ seed, session: 'capture', variant, secretDir });
    try {
      return await runTestCommand({ testDir, command: cmd.command, appUrl: app.url, baselinePids: baseline, timeoutMs }, deps);
    } finally { await app.stop(); }
  };
  const runs = [];
  for (const variant of /** @type {const} */ (['healthy', 'healthy', 'broken'])) {
    const prev = runs[runs.length - 1];
    runs.push(prev && (prev.refused || prev.timedOut || prev.skipped) ? skipped() : await once(variant));
  }
  const [h1, h2, broken] = runs;
  let reason = null;
  if (runs.some((r) => r.refused)) reason = 'ports busy';
  else if (runs.some((r) => r.timedOut)) reason = 'timeout';
  else if (h1.exit !== 0 && h2.exit !== 0) reason = 'healthy failed';
  else if (h1.exit !== 0 || h2.exit !== 0) reason = 'healthy flaky';
  else if (broken.exit === 0) reason = 'broken passed';
  return { command: cmd.command, healthy: [h1, h2], broken, valid: reason === null, reason };
}
