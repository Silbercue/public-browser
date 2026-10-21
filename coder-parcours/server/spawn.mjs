// Starts server/start.mjs as a child process (own process group) and waits for `READY <port>`.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = join(dirname(fileURLToPath(import.meta.url)), 'start.mjs');
const READY_TIMEOUT_MS = 20_000;

/**
 * @param {{ seed: number, session?: 'explore'|'capture', variant?: 'healthy'|'broken'|null, secretDir?: string|null,
 *   eventsFile?: string|null, reportsFile?: string|null, staticDir?: string|null,
 *   activate?: Array<{ id: string, station: string, width: string }>|string|null, noBugs?: boolean, countRequests?: boolean }} opts
 * countRequests (optional): the server counts requests it really served in memory and reports them over a private pipe
 * (fd 3) that only this process holds; `requests()` returns the count (final after stop()). Without it requests() is 0.
 * @returns {Promise<{ url: string, port: number, stop: () => Promise<void>, requests: () => number }>}
 */
export function spawnAppServer({ seed, session = 'explore', variant = null, secretDir = null, eventsFile = null, reportsFile = null, staticDir = null, activate = null, noBugs = false, countRequests = false }) {
  const args = [START, '--seed', String(seed), '--session', session, '--port', '0'];
  // Variante und secretDir gehen per stdin an start.mjs, nicht in die argv (ps zeigt sie sonst jedem Prozess).
  const viaStdin = Boolean(variant || secretDir);
  if (viaStdin) args.push('--stdin-config');
  if (eventsFile) args.push('--events', eventsFile);
  if (reportsFile) args.push('--reports', reportsFile);
  if (staticDir) args.push('--static', staticDir);
  if (activate && activate.length) {
    args.push('--activate', typeof activate === 'string' ? activate : activate.map((a) => `${a.id}@${a.station}:${a.width}`).join(','));
  }
  if (noBugs) args.push('--no-bugs');
  if (countRequests) args.push('--count-fd', '3');

  const stdio = /** @type {any} */ ([viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe', ...(countRequests ? ['pipe'] : [])]);
  /** @type {import('node:child_process').ChildProcessByStdio<any, any, any>} */
  const child = spawn(process.execPath, args, { detached: true, stdio });
  let counted = 0;
  /** @type {Promise<void>} */
  let countClosed = Promise.resolve();
  if (countRequests) {
    const pipe = child.stdio[3];
    pipe.on('data', (d) => { counted += d.length; });
    pipe.on('error', () => { /* Leitung weg */ });
    countClosed = new Promise((r) => { pipe.once('close', () => r()); });
  }
  if (viaStdin) {
    child.stdin.on('error', () => { /* Kind schon weg: der exit-Handler meldet es */ });
    child.stdin.end(`${JSON.stringify({ variant: variant || null, secretDir: secretDir || null })}\n`);
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let exitedFlag = false;
  child.once('exit', () => { exitedFlag = true; });

  /** @param {NodeJS.Signals} sig */
  const killGroup = (sig) => {
    try { process.kill(-child.pid, sig); } catch { /* already gone */ }
  };
  const stop = async () => {
    if (exitedFlag) return;
    killGroup('SIGTERM');
    const timer = setTimeout(() => killGroup('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    await Promise.race([countClosed, new Promise((r) => { setTimeout(r, 1000); })]);
  };

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => {
      killGroup('SIGKILL');
      reject(new Error(`spawnAppServer: no READY line within ${READY_TIMEOUT_MS / 1000} s. stderr: ${err.trim()}`));
    }), READY_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const m = /^READY (\d+)$/m.exec(out);
      if (m) {
        const port = Number(m[1]);
        finish(() => resolve({ url: `http://127.0.0.1:${port}/`, port, stop, requests: () => counted }));
      }
    });
    child.once('exit', (code, signal) => finish(() => {
      reject(new Error(`spawnAppServer: start.mjs exited (${code ?? signal}) before READY. stderr: ${err.trim()}`));
    }));
    child.once('error', (e) => finish(() => reject(e)));
  });
}
