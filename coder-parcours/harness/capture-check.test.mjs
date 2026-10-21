// Tests fuer Festhalten-Pruefung und run-my-test. Nie gegen 9222/9223: jeder Lauf bekommt zwei frei
// ermittelte Wegwerf-Ports per deps.ports; Fixtures werden in einen Tempordner kopiert.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { TEST_PORTS, cleanupTestPorts, checkCapture, runTestCommand, snapshotPids } from './capture-check.mjs';
import { runMyTest } from './run-my-test.mjs';
import { listeningPids, portBusy } from './proc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'fixtures', 'capture');
process.env.CODER_PARCOURS_PUBLIC_DIR = 'fixtures/bugs';
const SEED = 1;

const freePort = async () => {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
  s.close();
  await once(s, 'close');
  return port;
};
/** @type {number[]} */
let PORTS = [];
before(async () => { PORTS = [await freePort(), await freePort()]; });
const noBusy = () => ({ portBusy: async () => false, ports: PORTS });

const tmp = () => mkdtempSync(join(tmpdir(), 'cp-capture-'));
const copyFixture = (name) => { const d = join(tmp(), name); cpSync(join(FIX, name), d, { recursive: true }); return d; };
const withRun = (text) => { const d = tmp(); writeFileSync(join(d, 'RUN'), `${text}\n`); return d; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Unbeteiligter: eigener Kindprozess, optional als Lauscher auf `port`. */
async function bystander(port = null) {
  const code = port
    ? `require('node:net').createServer(s=>s.end()).listen(${port},'127.0.0.1',()=>console.log('up'))`
    : `setInterval(()=>{},1000);console.log('up')`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  return child;
}

test('TEST_PORTS sind 9222 und 9223', () => {
  assert.deepEqual(TEST_PORTS, [9222, 9223]);
});

test('snapshotPids enthaelt den eigenen Prozess', async () => {
  const pids = await snapshotPids();
  assert.ok(pids.includes(process.pid));
});

test('cleanupTestPorts beendet nur PIDs ausserhalb des Schnappschusses', async () => {
  const killedArgs = [];
  const res = await cleanupTestPorts({ baselinePids: [111], ports: [PORTS[0]] }, {
    listeningPids: async () => [111, 222],
    listProcesses: () => [],
    killPids: async (pids) => { killedArgs.push(...pids); return pids; },
  });
  assert.deepEqual(killedArgs, [222]);
  assert.deepEqual(res, { killed: [222], blockedBy: [111] });
});

test('cleanupTestPorts erfasst Chrome-Hauptprozesse mit dem Debug-Port, nicht andere Ports', async () => {
  const killedArgs = [];
  const res = await cleanupTestPorts({ baselinePids: [], ports: [PORTS[0]] }, {
    listeningPids: async () => [],
    listProcesses: () => [
      { pid: 333, command: `/x/chrome --remote-debugging-port=${PORTS[0]} --user-data-dir=/x` },
      { pid: 334, command: `/x/chrome --type=renderer --remote-debugging-port=${PORTS[0]}` },
      { pid: 335, command: `/x/chrome --remote-debugging-port=${PORTS[1]}` },
    ],
    killPids: async (pids) => { killedArgs.push(...pids); return pids; },
  });
  assert.deepEqual(killedArgs, [333]);
  assert.deepEqual(res, { killed: [333], blockedBy: [] });
});

test('good: heil gruen, kaputt rot -> valid', { timeout: 120_000 }, async () => {
  const r = await checkCapture({ testDir: copyFixture('good'), seed: SEED, secretDir: null, baselinePids: await snapshotPids() }, noBusy());
  assert.equal(r.command, 'playwright test --reporter=line');
  assert.deepEqual(r.healthy.map((x) => x.exit), [0, 0], r.healthy.map((x) => x.output).join('\n'));
  assert.notEqual(r.broken.exit, 0);
  assert.equal(r.valid, true);
  assert.equal(r.reason, null);
});

test('always-pass -> broken passed', { timeout: 60_000 }, async () => {
  const r = await checkCapture({ testDir: copyFixture('always-pass'), seed: SEED, secretDir: null, baselinePids: [] }, noBusy());
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'broken passed');
});

test('flaky -> healthy flaky', { timeout: 60_000 }, async () => {
  const r = await checkCapture({ testDir: copyFixture('flaky'), seed: SEED, secretDir: null, baselinePids: [] }, noBusy());
  assert.deepEqual(r.healthy.map((x) => x.exit), [0, 1]);
  assert.equal(r.reason, 'healthy flaky');
});

test('beide heil rot -> healthy failed', { timeout: 60_000 }, async () => {
  const r = await checkCapture({ testDir: withRun('exit 3'), seed: SEED, secretDir: null, baselinePids: [] }, noBusy());
  assert.equal(r.reason, 'healthy failed');
});

test('leerer Ordner -> RUN missing, leere RUN -> RUN empty', async () => {
  let r = await checkCapture({ testDir: tmp(), seed: SEED, secretDir: null, baselinePids: [] }, noBusy());
  assert.deepEqual([r.valid, r.reason, r.command], [false, 'RUN missing', null]);
  const d = tmp();
  writeFileSync(join(d, 'RUN'), '\n  \n');
  r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: [] }, noBusy());
  assert.deepEqual([r.valid, r.reason], [false, 'RUN empty']);
});

test('sleep 999 mit timeoutMs 2000 -> timeout, Prozessgruppe beendet', { timeout: 60_000 }, async () => {
  const d = withRun('echo $$ > shell.pid; sleep 999');
  const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: [], timeoutMs: 2000 }, noBusy());
  assert.equal(r.reason, 'timeout');
  assert.equal(r.healthy[0].timedOut, true);
  const pid = Number(readFileSync(join(d, 'shell.pid'), 'utf8'));
  assert.equal(alive(pid), false);
});

test('portBusy immer true -> refused, RUN nicht ausgefuehrt', async () => {
  const d = withRun('touch ran');
  const r = await runTestCommand({ testDir: d, command: 'touch ran', appUrl: 'http://127.0.0.1:1/', baselinePids: [] },
    { portBusy: async () => true, ports: PORTS });
  assert.equal(r.refused, true);
  assert.equal(r.exit, null);
  assert.match(r.output, /^Refused: port 9222 or 9223 was already in use before this session started\./);
  assert.equal(existsSync(join(d, 'ran')), false);
  // Gegenprobe: ohne belegten Port laeuft derselbe Befehl.
  const ok = await runTestCommand({ testDir: d, command: 'touch ran', appUrl: 'http://127.0.0.1:1/', baselinePids: [] }, noBusy());
  assert.deepEqual([ok.refused, ok.exit], [false, 0]);
  assert.equal(existsSync(join(d, 'ran')), true);
});

test('runTestCommand: APP_URL, PATH mit Werkzeugkette vorn, node_modules-Symlink, Provider-Keys entfernt', async () => {
  const d = tmp();
  process.env.OPENAI_API_KEY = 'leak';
  try {
    const r = await runTestCommand({ testDir: d, command: 'echo "url=$APP_URL"; echo "path=$PATH"; echo "key=${OPENAI_API_KEY:-none}"',
      appUrl: 'http://127.0.0.1:9/', baselinePids: [] }, noBusy());
    assert.equal(r.exit, 0);
    assert.match(r.output, /url=http:\/\/127\.0\.0\.1:9\//);
    assert.match(r.output, /path=[^\n]*toolchain\/node_modules\/\.bin:[^\n]*toolchain\/\.venv\/bin:/);
    assert.match(r.output, /key=none/);
  } finally { delete process.env.OPENAI_API_KEY; }
  const link = execFileSync('readlink', [join(d, 'node_modules')], { encoding: 'utf8' }).trim();
  assert.equal(link, join(ROOT, 'harness', 'toolchain', 'node_modules'));
});

test('runTestCommand kuerzt die Ausgabe auf die letzten 4000 Zeichen', async () => {
  const r = await runTestCommand({ testDir: tmp(), command: `node -e "process.stdout.write('a'.repeat(5000)+'END')"`,
    appUrl: 'http://127.0.0.1:9/', baselinePids: [] }, noBusy());
  assert.equal(r.output.length, 4000);
  assert.ok(r.output.endsWith('END'));
});

test('leaves-listener: Lauscher wird nach jedem Lauf beendet, Ergebnis valid, Port danach frei', { timeout: 120_000 }, async () => {
  const d = copyFixture('leaves-listener');
  writeFileSync(join(d, 'PORT'), String(PORTS[0]));
  const outsider = await bystander(); // nach dem Schnappschuss gestartet, aber nicht auf einem Testport
  try {
    const baselinePids = await snapshotPids();
    const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids }, { portBusy, ports: PORTS });
    const runs = [...r.healthy, r.broken];
    assert.deepEqual(runs.map((x) => x.refused), [false, false, false]);
    for (const x of runs) assert.equal(x.killed.length, 1, x.output);
    assert.deepEqual(runs.map((x) => x.exit === 0), [true, true, false]);
    assert.equal(r.valid, true);
    assert.deepEqual(await listeningPids(PORTS[0]), []);
    assert.equal(alive(outsider.pid), true);
  } finally { outsider.kill('SIGKILL'); }
});

test('Unbeteiligter vor dem Schnappschuss auf einem Testport -> ports busy, RUN nicht ausgefuehrt, Lauscher lebt', { timeout: 60_000 }, async () => {
  const keeper = await bystander(PORTS[1]);
  try {
    const d = withRun('touch ran; exit 0');
    const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: null }, { portBusy, ports: PORTS });
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'ports busy');
    assert.equal(existsSync(join(d, 'ran')), false);
    assert.equal(alive(keeper.pid), true);
    assert.equal(await portBusy(PORTS[1]), true);
    assert.deepEqual(await listeningPids(PORTS[1]), [keeper.pid]);
  } finally { keeper.kill('SIGKILL'); }
});

test('run-my-test ohne RUN: Exit 1, Meldung, Zeile im Log', () => {
  const ctl = tmp();
  const testDir = join(ctl, 'test');
  mkdirSync(testDir);
  writeFileSync(join(ctl, 'session.json'), JSON.stringify({ seed: SEED, testDir, baselinePids: [] }));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [join(ROOT, 'harness', 'run-my-test.mjs'), '--ctl', ctl], { encoding: 'utf8' });
  } catch (e) { status = e.status; stdout = e.stdout; }
  assert.equal(status, 1);
  assert.match(stdout, new RegExp(`No RUN file in ${testDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  assert.match(readFileSync(join(ctl, 'run-my-test.log'), 'utf8'), /No RUN file in /);
});

test('runMyTest mit RUN: heile App, exit code und Ausgabe, Log angehaengt', { timeout: 60_000 }, async () => {
  const ctl = tmp();
  const testDir = withRun('echo "hello $APP_URL"; exit 4');
  writeFileSync(join(ctl, 'session.json'), JSON.stringify({ seed: SEED, testDir, baselinePids: [] }));
  const a = await runMyTest({ ctl }, noBusy());
  assert.equal(a.code, 4);
  assert.match(a.text, /^exit code: 4\nhello http:\/\/127\.0\.0\.1:\d+\//);
  await runMyTest({ ctl }, noBusy());
  const log = readFileSync(join(ctl, 'run-my-test.log'), 'utf8');
  assert.equal(log.match(/exit code: 4/g)?.length, 2);
});
