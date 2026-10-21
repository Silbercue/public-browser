// Tests fuer Festhalten-Pruefung und run-my-test. Nie gegen 9222/9223: jeder Lauf bekommt zwei frei
// ermittelte Wegwerf-Ports per deps.ports; Fixtures werden in einen Tempordner kopiert.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { spawnAppServer } from '../server/spawn.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { TEST_PORTS, RUN_ENV_KEYS, captureOrder, cleanupTestPorts, checkCapture, runTestCommand, snapshotPids } from './capture-check.mjs';
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
/** RUN-Zeile: App ansprechen, dann mit Exit `n` enden. */
const contact = (n) => `node -e "fetch(process.env.APP_URL+'api/classes').then(()=>process.exit(${n}))"`;
const spawnSyncNode = (args) => spawnSync(process.execPath, args, { encoding: 'utf8' });
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

test('cleanupTestPorts: Chrome-Hauptprozess aus der Baseline wird nie beendet (blockedBy), ein neuer schon', async () => {
  const killedArgs = [];
  const res = await cleanupTestPorts({ baselinePids: [333], ports: [PORTS[0]] }, {
    listeningPids: async () => [],
    listProcesses: () => [
      { pid: 333, command: `/x/chrome --remote-debugging-port=${PORTS[0]} --user-data-dir=/x` },
      { pid: 444, command: `/x/chrome --remote-debugging-port=${PORTS[0]} --user-data-dir=/y` },
    ],
    killPids: async (pids) => { killedArgs.push(...pids); return pids; },
  });
  assert.deepEqual(killedArgs, [444]);
  assert.deepEqual(res, { killed: [444], blockedBy: [333] });
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

test('Zaehldatei im testDir ("scheitert nur beim dritten Mal") zaehlt nicht: frische Kopie je Lauf -> nicht gueltig', { timeout: 60_000 }, async () => {
  const d = copyFixture('flaky');
  const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: await snapshotPids() }, noBusy());
  assert.deepEqual([r.healthy[0].exit, r.healthy[1].exit, r.broken.exit], [0, 0, 0], r.broken.output);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'broken passed');
  assert.equal(existsSync(join(d, '.count')), false, 'das Original-testDir bleibt unberuehrt');
});

test('echt unstabil (Zaehler ausserhalb des testDir, mittlerer Lauf heil) -> healthy flaky', { timeout: 60_000 }, async () => {
  const seed = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((x) => captureOrder(x)[1] === 'healthy');
  assert.ok(seed, 'ein Seed mit heilem mittlerem Lauf');
  const counter = join(tmp(), 'count');
  const d = withRun(`echo x >> ${counter}; n=$(wc -l < ${counter}); ${contact('$((n == 2 ? 1 : 0))')}`);
  const r = await checkCapture({ testDir: d, seed, secretDir: null, baselinePids: await snapshotPids() }, noBusy());
  assert.equal(r.reason, 'healthy flaky');
  assert.deepEqual(r.healthy.map((x) => x.exit).sort(), [0, 1]);
  assert.equal(r.broken.exit, 0);
});

test('beide heil rot (App erreicht) -> healthy failed', { timeout: 60_000 }, async () => {
  const r = await checkCapture({ testDir: withRun(contact(3)), seed: SEED, secretDir: null, baselinePids: [] }, noBusy());
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

test('sleep 999 mit timeoutMs 2000 -> timeout, Prozessgruppe beendet, restliche Laeufe skipped', { timeout: 60_000 }, async () => {
  const out = tmp();
  const d = withRun(`echo $$ >> ${out}/shell.pids; echo x >> ${out}/count; sleep 999`);
  const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: await snapshotPids(), timeoutMs: 2000 }, noBusy());
  assert.equal(r.reason, 'timeout');
  const all = [...r.healthy, r.broken];
  assert.equal(all.filter((x) => x.timedOut).length, 1);
  assert.equal(all.filter((x) => x.skipped).length, 2);
  assert.equal(readFileSync(join(out, 'count'), 'utf8').trim().split('\n').length, 1, 'RUN lief genau einmal');
  const pid = Number(readFileSync(join(out, 'shell.pids'), 'utf8'));
  assert.equal(alive(pid), false);
});

test('portBusy immer true -> refused, RUN nicht ausgefuehrt', async () => {
  const out = tmp();
  const cmd = `touch ${out}/ran`;
  const r = await runTestCommand({ testDir: withRun(cmd), command: cmd, appUrl: 'http://127.0.0.1:1/', baselinePids: [] },
    { portBusy: async () => true, ports: PORTS });
  assert.equal(r.refused, true);
  assert.equal(r.exit, null);
  assert.match(r.output, /^Refused: port 9222 or 9223 was already in use before this session started\./);
  assert.equal(existsSync(join(out, 'ran')), false);
  // Gegenprobe: ohne belegten Port laeuft derselbe Befehl.
  const ok = await runTestCommand({ testDir: withRun(cmd), command: cmd, appUrl: 'http://127.0.0.1:1/', baselinePids: [] }, noBusy());
  assert.deepEqual([ok.refused, ok.exit], [false, 0]);
  assert.equal(existsSync(join(out, 'ran')), true);
});

test('nach refused: die uebrigen Laeufe sind skipped, RUN lief nie', { timeout: 60_000 }, async () => {
  const out = tmp();
  const d = withRun(`touch ${out}/ran`);
  const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: await snapshotPids() },
    { portBusy: async () => true, ports: PORTS });
  const all = [...r.healthy, r.broken];
  assert.equal(r.reason, 'ports busy');
  assert.equal(all.filter((x) => x.refused).length, 1);
  assert.equal(all.filter((x) => x.skipped).length, 2);
  assert.equal(existsSync(join(out, 'ran')), false);
});

test('runTestCommand: Env nur Whitelist, eigenes HOME/TMPDIR, PATH mit Werkzeugkette vorn, Symlink, Provider-Keys weg', async () => {
  process.env.OPENAI_API_KEY = 'leak';
  process.env.GH_TOKEN = 'leak2';
  process.env.SSH_AUTH_SOCK = '/leak/sock';
  try {
    const r = await runTestCommand({ testDir: tmp(), appUrl: 'http://127.0.0.1:9/', baselinePids: [],
      command: `node -e "console.log(JSON.stringify(process.env))"; readlink node_modules; pwd -P` }, noBusy());
    assert.equal(r.exit, 0, r.output);
    const [json, link, cwd] = r.output.trim().split('\n');
    const env = JSON.parse(json);
    const shellExtras = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);
    const extra = Object.keys(env).filter((k) => !RUN_ENV_KEYS.includes(k) && !shellExtras.has(k));
    assert.deepEqual(extra, []);
    assert.equal(env.APP_URL, 'http://127.0.0.1:9/');
    assert.match(env.PATH, /^[^:]*toolchain\/node_modules\/\.bin:[^:]*toolchain\/\.venv\/bin:/);
    assert.notEqual(env.HOME, homedir());
    assert.ok(existsSync(env.HOME) === false, 'HOME-Ordner ist nach dem Lauf weg');
    assert.ok(env.TMPDIR.startsWith(tmpdir()) && env.TMPDIR !== tmpdir() && env.TMPDIR !== `${tmpdir()}/`);
    assert.equal(link, join(ROOT, 'harness', 'toolchain', 'node_modules'));
    assert.ok(cwd.includes('cp-run-'), 'cwd ist die Kopie');
    // Gegenprobe: die Whitelist enthaelt, was der Plan braucht
    for (const k of ['PATH', 'HOME', 'TMPDIR', 'APP_URL', 'PLAYWRIGHT_BROWSERS_PATH']) assert.ok(k in env, k);
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.GH_TOKEN; delete process.env.SSH_AUTH_SOCK; }
});

test('runTestCommand arbeitet in einer frischen Kopie: Original unberuehrt, Datei aus dem ersten Lauf fehlt im zweiten', async () => {
  const d = withRun('test -e marker && echo SEEN; touch marker; ls');
  const first = await runTestCommand({ testDir: d, command: 'test -e marker && echo SEEN; touch marker', appUrl: 'http://x/', baselinePids: [] }, noBusy());
  const second = await runTestCommand({ testDir: d, command: 'test -e marker && echo SEEN; touch marker; test -e RUN && echo HAS_RUN', appUrl: 'http://x/', baselinePids: [] }, noBusy());
  assert.doesNotMatch(first.output, /SEEN/);
  assert.doesNotMatch(second.output, /SEEN/);
  assert.match(second.output, /HAS_RUN/, 'Gegenprobe: Inhalt des testDir ist in der Kopie');
  assert.equal(existsSync(join(d, 'marker')), false);
});

test('captureOrder: deterministisch je Seed, 2x heil + 1x kaputt, alle drei Positionen kommen vor', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const o = captureOrder(seed);
    assert.deepEqual(o, captureOrder(seed));
    assert.deepEqual([...o].sort(), ['broken', 'healthy', 'healthy']);
    seen.add(o.indexOf('broken'));
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test('checkCapture haelt die gespeicherte Reihenfolge ein und nennt sie im Ergebnis', { timeout: 60_000 }, async () => {
  const seen = [];
  const spawnApp = async (o) => { seen.push(o.variant); return spawnAppServer(o); };
  const r = await checkCapture({ testDir: withRun(contact(0)), seed: 7, baselinePids: await snapshotPids() }, { ...noBusy(), spawnApp });
  assert.deepEqual(seen, captureOrder(7));
  assert.deepEqual(r.order, captureOrder(7));
});

test('Lauf ohne App-Kontakt (Exit 1 ohne Anfrage) -> test did not exercise the app', { timeout: 60_000 }, async () => {
  const r = await checkCapture({ testDir: withRun('exit 1'), seed: SEED, secretDir: null, baselinePids: await snapshotPids() }, noBusy());
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'test did not exercise the app');
  assert.ok([...r.healthy, r.broken].every((x) => x.appRequests === 0));
});

test('Kontakt nur im kaputten Lauf reicht nicht: heil ohne Anfrage -> did not exercise', { timeout: 60_000 }, async () => {
  // Anfrage nur, wenn die App kaputt ist (erkennbar am Verhalten waere nicht fair); hier: Anfrage nur im ersten Lauf.
  const mark = join(tmp(), 'first');
  const d = withRun(`if [ -e ${mark} ]; then exit 0; else touch ${mark}; ${contact(0)}; fi`);
  const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids: await snapshotPids() }, noBusy());
  assert.equal(r.reason, 'test did not exercise the app');
  assert.deepEqual([...r.healthy, r.broken].map((x) => x.appRequests > 0).sort(), [false, false, true]);
});

test('spawnAppServer: secretDir und Variante stehen in keiner argv, die App kennt sie trotzdem', async () => {
  const secretDir = mkdtempSync(join(tmpdir(), 'cp-secret-argv-'));
  mkdirSync(join(secretDir, 'bugs'));
  writeFileSync(join(secretDir, 'decoys.json'), '[]');
  const app = await spawnAppServer({ seed: SEED, session: 'capture', variant: 'broken', secretDir, noBugs: true });
  try {
    const pids = await listeningPids(app.port);
    assert.ok(pids.length >= 1);
    const args = execFileSync('ps', ['-o', 'args=', '-p', pids.join(',')], { encoding: 'utf8' });
    assert.match(args, /start\.mjs/);
    assert.match(args, /--seed/, 'Gegenprobe: argv wird gelesen');
    assert.equal(args.includes(secretDir), false);
    assert.doesNotMatch(args, /secret-dir|broken|healthy/);
    assert.equal((await fetch(`${app.url}api/classes`)).status, 200);
  } finally { await app.stop(); }
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

test('Fremder Prozess startet NACH dem Schnappschuss, VOR dem Lauf, auf einem Testport -> refused, lebt weiter', { timeout: 60_000 }, async () => {
  const baselinePids = await snapshotPids();
  const keeper = await bystander(PORTS[0]); // z. B. Julians Chrome/Harness, spaeter gestartet
  try {
    const out = tmp();
    const d = withRun(`touch ${out}/ran`);
    const r = await checkCapture({ testDir: d, seed: SEED, secretDir: null, baselinePids }, { portBusy, ports: PORTS });
    assert.equal(r.reason, 'ports busy');
    assert.equal(existsSync(join(out, 'ran')), false);
    assert.equal(alive(keeper.pid), true);
    assert.deepEqual(await listeningPids(PORTS[0]), [keeper.pid]);
    assert.deepEqual([...r.healthy, r.broken].flatMap((x) => x.killed), []);
  } finally { keeper.kill('SIGKILL'); }
});

test('Reste der eigenen Prozessgruppe (sleep &) sind nach dem Lauf beendet; ein Unbeteiligter ausserhalb lebt', async () => {
  const out = tmp();
  const outsider = await bystander();
  try {
    const r = await runTestCommand({ testDir: tmp(), command: `sleep 997 & echo $! > ${out}/bg.pid; exit 0`, appUrl: 'http://x/', baselinePids: [] }, noBusy());
    assert.equal(r.exit, 0);
    const bg = Number(readFileSync(join(out, 'bg.pid'), 'utf8'));
    assert.ok(bg > 1);
    assert.equal(alive(bg), false);
    assert.equal(alive(outsider.pid), true);
  } finally { outsider.kill('SIGKILL'); }
});

test('run-my-test ohne RUN: Exit 1, Meldung, Zeile im Log', () => {
  const ctl = tmp();
  const testDir = join(ctl, 'test');
  mkdirSync(testDir);
  writeFileSync(join(ctl, 'session.json'), JSON.stringify({ seed: SEED, testDir, baselinePids: [1] }));
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [join(ROOT, 'harness', 'run-my-test.mjs'), '--ctl', ctl], { encoding: 'utf8' });
  } catch (e) { status = e.status; stdout = e.stdout; }
  assert.equal(status, 1);
  assert.match(stdout, new RegExp(`No RUN file in ${testDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`));
  assert.match(readFileSync(join(ctl, 'run-my-test.log'), 'utf8'), /No RUN file in /);
});

const sessionFile = (ctl, o) => writeFileSync(join(ctl, 'session.json'), JSON.stringify(o));

test('runMyTest mit RUN: heile App, exit code und Ausgabe, Log angehaengt', { timeout: 60_000 }, async () => {
  const ctl = tmp();
  const testDir = withRun(`echo "hello $APP_URL"; ${contact(4)}`);
  sessionFile(ctl, { seed: SEED, testDir, baselinePids: await snapshotPids() });
  const a = await runMyTest({ ctl }, noBusy());
  assert.equal(a.code, 4);
  assert.match(a.text, /^exit code: 4\nhello http:\/\/127\.0\.0\.1:\d+\//);
  await runMyTest({ ctl }, noBusy());
  const log = readFileSync(join(ctl, 'run-my-test.log'), 'utf8');
  assert.equal(log.match(/exit code: 4/g)?.length, 2);
});

test('runMyTest: Test ohne App-Kontakt bekommt den Hinweis; mit Kontakt nicht', { timeout: 60_000 }, async () => {
  const ctl = tmp();
  sessionFile(ctl, { seed: SEED, testDir: withRun('exit 0'), baselinePids: await snapshotPids() });
  assert.match((await runMyTest({ ctl }, noBusy())).text, /test did not exercise the app/);
  sessionFile(ctl, { seed: SEED, testDir: withRun(contact(0)), baselinePids: await snapshotPids() });
  assert.doesNotMatch((await runMyTest({ ctl }, noBusy())).text, /did not exercise/);
});

for (const [name, baselinePids] of [['fehlt', undefined], ['leer', []], ['nicht ganzzahlig', ['1', 2.5]], ['kein Array', 'x']]) {
  test(`runMyTest: baselinePids ${name} -> Exit 1 invalid session, RUN nicht ausgefuehrt`, async () => {
    const ctl = tmp();
    const out = tmp();
    sessionFile(ctl, { seed: SEED, testDir: withRun(`touch ${out}/ran`), ...(baselinePids === undefined ? {} : { baselinePids }) });
    const r = await runMyTest({ ctl }, noBusy());
    assert.equal(r.code, 1);
    assert.match(r.text, /invalid session: baselinePids/);
    assert.equal(existsSync(join(out, 'ran')), false);
  });
}

test('runMyTest: Kopfzeile exit code: refused bzw. timeout', { timeout: 60_000 }, async () => {
  const ctl = tmp();
  sessionFile(ctl, { seed: SEED, testDir: withRun('sleep 999'), baselinePids: await snapshotPids() });
  const refused = await runMyTest({ ctl }, { portBusy: async () => true, ports: PORTS });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /^exit code: refused\nRefused: /);
  const timeout = await runMyTest({ ctl, timeoutMs: 1500 }, noBusy());
  assert.equal(timeout.code, 1);
  assert.match(timeout.text, /^exit code: timeout\n/);
});

test('runMyTest: secretDir kommt nicht in die argv (run-my-test hat keine --secret-dir-Option mehr)', () => {
  const r = spawnSyncNode([join(ROOT, 'harness', 'run-my-test.mjs'), '--ctl', tmp(), '--secret-dir', '/x']);
  assert.notEqual(r.status, 0);
});
