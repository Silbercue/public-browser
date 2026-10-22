// proc.mjs — Prozess- und Portfunktionen fuer macOS und Linux. Eigene Umsetzung: die Gegenstuecke in
// test-hardest/blind-run.mjs sind an macOS und den /Applications-Chrome gebunden und bleiben unberuehrt.
import { execFileSync, execFile } from 'node:child_process';
import { connect } from 'node:net';
import { basename } from 'node:path';

/** @typedef {{ pid: number, command: string }} Proc */

/**
 * @param {{ platform?: string, psText?: string }} [opts]
 * @returns {Proc[]}
 */
export function listProcesses({ platform = process.platform, psText } = {}) {
  const text = psText ?? execFileSync('ps', platform === 'linux' ? ['-eo', 'pid=,args='] : ['-axo', 'pid=,command='],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
    if (m) out.push({ pid: Number(m[1]), command: m[2] });
  }
  return out;
}

/**
 * Wie listProcesses, dazu die Elternkennung (ppid) fuer die Zuordnung zu einer Sitzung.
 * @param {{ platform?: string, psText?: string }} [opts]
 * @returns {Array<Proc & { ppid: number }>}
 */
export function listProcessTree({ platform = process.platform, psText } = {}) {
  const text = psText ?? execFileSync('ps', platform === 'linux' ? ['-eo', 'pid=,ppid=,args='] : ['-axo', 'pid=,ppid=,command='],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

/**
 * Prozesse einer Sitzung: Wurzeln (PIDs oder Befehlszeilen mit einer Kennung der Sitzung, z. B. Sitzungs-ID von claude,
 * Arbeitsordnername im Daemon-Aufruf) plus alle ihre Nachkommen ueber die Elternkennung. Fremde Prozesse (auch neue
 * Browser anderer Programme auf demselben Rechner) gehoeren nicht dazu. Der eigene Prozess ist nie dabei.
 * @param {Array<Proc & { ppid?: number }>} procs
 * @param {{ rootPids?: number[], markers?: string[], selfPid?: number }} [o]
 * @returns {Array<Proc & { ppid?: number }>}
 */
export function sessionProcesses(procs, { rootPids = [], markers = [], selfPid = process.pid } = {}) {
  const marks = markers.filter((m) => typeof m === 'string' && m.length >= 8);
  const roots = new Set(rootPids.filter(Number.isInteger));
  for (const p of procs || []) if (marks.some((m) => p.command.includes(m))) roots.add(p.pid);
  roots.delete(selfPid);
  const owned = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs || []) {
      if (!owned.has(p.pid) && p.pid !== selfPid && Number.isInteger(p.ppid) && owned.has(p.ppid)) { owned.add(p.pid); grew = true; }
    }
  }
  return (procs || []).filter((p) => owned.has(p.pid));
}

const startsWithProgram = (command, program) => command === program || command.startsWith(`${program} `);

/**
 * Chrome-Hauptprozesse: Befehlszeile beginnt mit dem Chrome-Pfad, keine Kindprozesse (--type=).
 * @param {Proc[]} procs
 * @param {string} chromePath
 */
export function chromeMainProcesses(procs, chromePath) {
  return (procs || []).filter((p) => startsWithProgram(p.command, chromePath) && !p.command.includes('--type='));
}

const BROWSER_NAME = /^(Google Chrome( Beta| Dev| Canary| for Testing)?|Chromium|chrome|chromium|chromium-browser|google-chrome(-stable|-beta|-unstable)?|chrome-headless-shell|headless_shell)$/;

/**
 * Laufende Browser-Hauptprozesse mit Remote-Debugging (Port oder Pipe) und ihr Programmpfad.
 * @param {Proc[]} procs
 * @returns {{ pid: number, binary: string }[]}
 */
export function browserBinaries(procs) {
  const out = [];
  for (const p of procs || []) {
    if (p.command.includes('--type=') || !/--remote-debugging-(port|pipe)/.test(p.command)) continue;
    const app = p.command.match(/^(.*?\.app\/Contents\/MacOS\/[^/]+?)(?=\s+-|\s*$)/);
    const binary = app ? app[1] : p.command.split(/\s+/)[0];
    if (BROWSER_NAME.test(basename(binary))) out.push({ pid: p.pid, binary });
  }
  return out;
}

/**
 * Hauptprozesse (ohne --type=) mit genau diesem Debug-Port.
 * @param {number} port
 * @param {Proc[]} procs
 */
export function chromeProcessesOnPort(port, procs) {
  const re = new RegExp(`--remote-debugging-port=${Number(port)}(\\s|$)`);
  return (procs || []).filter((p) => re.test(p.command) && !p.command.includes('--type='));
}

/** @param {number} port */
export async function killChromeOnPort(port) {
  return killPids(chromeProcessesOnPort(port, listProcesses()).map((p) => p.pid));
}

/**
 * true, wenn eine TCP-Verbindung auf 127.0.0.1:<port> gelingt.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portBusy(port, { timeoutMs = 1000 } = {}) {
  return new Promise((resolveBusy) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolveBusy(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const parsePids = (text) => [...new Set(String(text).split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number))];

/**
 * PIDs, die auf dem TCP-Port lauschen (lsof; Exit 1 = keine Treffer).
 * @param {number} port
 * @param {{ lsofText?: string }} [opts]
 * @returns {Promise<number[]>}
 */
export function listeningPids(port, { lsofText } = {}) {
  if (lsofText !== undefined) return Promise.resolve(parsePids(lsofText));
  return new Promise((resolvePids, reject) => {
    execFile('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }, (err, stdout) => {
      if (err && err.code === 1) { resolvePids([]); return; }
      if (err) { reject(new Error(`lsof failed for port ${port}: ${err.message}`)); return; }
      resolvePids(parsePids(stdout));
    });
  });
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Erst SIGTERM, nach graceMs SIGKILL fuer Ueberlebende. Bereits beendete PIDs werden still uebergangen.
 * @param {number[]} pids
 * @param {{ graceMs?: number }} [opts]
 * @returns {Promise<number[]>} PIDs, denen ein Signal zugestellt wurde
 */
export async function killPids(pids, { graceMs = 2000 } = {}) {
  const signaled = [];
  for (const pid of [...new Set(pids || [])]) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try { process.kill(pid, 'SIGTERM'); signaled.push(pid); } catch { /* schon weg oder fremd */ }
  }
  const deadline = Date.now() + graceMs;
  while (signaled.some(alive) && Date.now() < deadline) await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  for (const pid of signaled) {
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* inzwischen weg */ } }
  }
  return signaled;
}
