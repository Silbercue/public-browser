// Tests fuer den Sitzungslaeufer. Nie echte Sitzungen: Claude ist fixtures/fake-claude-cp.mjs, der MCP-Server
// der Fake aus test-hardest, das Shim ruft statt run-my-test denselben Fake. Ports 9222/9223 werden nie
// beruehrt: portBusy per deps auf false, Aufraeumen und Nachpruefung auf zwei frei ermittelten Wegwerf-Ports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { captureOutsideAccess, runSession } from './run-session.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { toolchainDir } from './participants.mjs';
import { symlinkSync } from 'node:fs';
import { registerCpParticipant } from './participants.mjs';
import { validateSessionResult } from './result-schema.mjs';
import { listeningPids } from './proc.mjs';
import { isAlive } from './blind-run-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FAKE = join(ROOT, 'fixtures', 'fake-claude-cp.mjs');
const BR_FIX = join(ROOT, '..', 'test-hardest', 'fixtures', 'blind-run');
process.env.CODER_PARCOURS_PUBLIC_DIR = 'fixtures/bugs';
const SEED = 1;

registerCpParticipant('fake-mcp', {
  kind: 'mcp', name: 'fake', display: 'Fake MCP', package: 'fake-mcp', version: '9.9.9',
  command: process.execPath, args: [join(BR_FIX, 'fake-mcp.mjs')],
  env: () => ({}), skillFiles: [], extraCommands: [], profile_isolation: 'test',
});
registerCpParticipant('fake-cli', {
  kind: 'cli', name: 'fakecli', cli: 'fakecli', display: 'Fake CLI', package: 'fakecli', version: '3.2.1',
  binDir: join(BR_FIX, 'bin'), vendoredDir: BR_FIX, skillFiles: ['fake-skill.md'], extraCommands: ['sleep'],
  env: () => ({}), cleanupArgs: ['close'], profile_isolation: 'test',
});

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

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); cleanup.push(d); return d; };

/** deps fuer einen Lauf mit Fake-Claude im Modus `mode`. */
function fakeDeps(mode, extra = {}) {
  const home = tmp('cp-rs-home-');
  const resultsRoot = tmp('cp-rs-results-');
  return {
    cp: { claude: { file: process.execPath, argsPrefix: [FAKE] } },
    envOverrides: { HOME: home, FAKE_CP_MODE: mode },
    resultsRoot,
    portBusy: async () => false,
    listProcesses: () => [],
    chromeVersion: () => 'test-chrome',
    runMyTestCmd: [process.execPath, FAKE],
    captureDeps: { portBusy: async () => false, ports: PORTS },
    ...extra,
  };
}
const run = (opts, deps) => runSession({ seed: SEED, round: 'r-test', ...opts }, deps);
const rundirOf = (result) => result.harness.run_dir.replace(/^~/, homedir());
const track = (result) => { cleanup.push(rundirOf(result)); return result; };

test('ok: Status ok, gueltig, Datei am Platz, kein Heimatpfad, raw-JSONL, session.json nur im Steuerordner', async () => {
  let ctlSeen = null;
  const deps = fakeDeps('ok', {
    inspectCtl: (ctl, rundir) => {
      ctlSeen = {
        session: JSON.parse(readFileSync(join(ctl, 'session.json'), 'utf8')),
        inRundir: existsSync(join(rundir, 'session.json')),
        events: existsSync(join(ctl, 'events.jsonl')),
      };
    },
  });
  const { result, outPath } = await run({ slug: 'fake-mcp', type: 'explore' }, deps);
  track(result);
  assert.equal(result.status, 'ok', result.notes.join(' | '));
  assert.deepEqual(validateSessionResult(result), []);
  assert.equal(outPath, join(deps.resultsRoot, 'r-test', 'sessions', `fake-mcp-explore-seed${SEED}.json`));
  const text = readFileSync(outPath, 'utf8');
  assert.ok(!text.includes(homedir()), 'kein Heimatpfad in der Ergebnisdatei');
  const raw = join(deps.resultsRoot, 'r-test', 'raw', `fake-mcp-explore-seed${SEED}.jsonl`);
  assert.ok(existsSync(raw));
  assert.ok(!readFileSync(raw, 'utf8').includes(homedir()));
  assert.ok(ctlSeen, 'inspectCtl wurde aufgerufen');
  assert.equal(ctlSeen.inRundir, false);
  assert.equal(ctlSeen.session.seed, SEED);
  assert.ok(Array.isArray(ctlSeen.session.baselinePids) && ctlSeen.session.baselinePids.length > 0);
  assert.equal('secretDir' in ctlSeen.session, false);
  assert.equal(result.model, 'claude-opus-5-20260514');
  assert.equal(result.report.ok, true);
  assert.equal(result.report.normalized.findings.length, 1);
  assert.equal(result.harness.integrity.read_bug_script, false);
  assert.equal(result.harness.integrity.capture_outside_access, false);
  assert.ok(result.events.some((e) => e.type === 'api'), 'Ereignisse der App eingelesen');
  assert.deepEqual(result.cost_usd_list, [0.5]);
  assert.equal(typeof result.tokens.delta, 'number');
  assert.ok(result.harness.flags.includes('--tools Write'));
  assert.ok(result.harness.flags.includes('--max-turns 160'));
});

test('halfreport: ok mit report.ok false und 0 Funden', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('halfreport'));
  track(result);
  assert.equal(result.status, 'ok');
  assert.equal(result.report.ok, false);
  assert.equal(result.report.normalized.findings.length, 0);
});

test('noreport: ok mit report.ok false', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('noreport'));
  track(result);
  assert.equal(result.status, 'ok');
  assert.equal(result.report.ok, false);
});

test('maxturns: budget', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('maxturns'));
  track(result);
  assert.equal(result.status, 'budget');
});

test('hang mit Wanduhr 2 s: timeout', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('hang', { wallMs: 2000 }));
  track(result);
  assert.equal(result.status, 'timeout');
  assert.equal(result.harness.timed_out, true);
});

test('lockviolation: aborted unter aborted/, nichts unter sessions/', async () => {
  const deps = fakeDeps('lockviolation');
  const { result, outPath } = await run({ slug: 'fake-mcp', type: 'explore' }, deps);
  track(result);
  assert.equal(result.status, 'aborted');
  assert.equal(outPath, join(deps.resultsRoot, 'r-test', 'aborted', `fake-mcp-explore-seed${SEED}-1.json`));
  assert.ok(existsSync(outPath));
  assert.equal(existsSync(join(deps.resultsRoot, 'r-test', 'sessions', `fake-mcp-explore-seed${SEED}.json`)), false);
  assert.deepEqual(result.harness.tool_lock.non_mcp_executed, ['Bash']);
  // zweiter Abbruch bekommt die naechste Nummer
  const second = await run({ slug: 'fake-mcp', type: 'explore' }, deps);
  track(second.result);
  assert.ok(second.outPath.endsWith(`seed${SEED}-2.json`));
});

test('crash: App-Prozess danach beendet, Status aborted', async () => {
  let appPid = null;
  const deps = fakeDeps('crash', { onAppStarted: async (app) => { [appPid] = await listeningPids(app.port); } });
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, deps);
  track(result);
  assert.ok(appPid, 'App-PID ermittelt');
  assert.equal(result.status, 'aborted');
  assert.equal(isAlive(appPid), false);
});

test('readruntime und resultruntime setzen read_bug_script', async () => {
  for (const mode of ['readruntime', 'resultruntime']) {
    const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps(mode));
    track(result);
    assert.equal(result.harness.integrity.read_bug_script, true, mode);
    assert.equal(result.status, 'ok', `${mode}: Flag aendert den Status nicht`);
  }
});

test('capture: Shim gerufen, reason broken passed, kein Fremdzugriff', async () => {
  let ctlSeen = null;
  const deps = fakeDeps('capture', {
    inspectCtl: (ctl) => { ctlSeen = readFileSync(join(ctl, 'run-my-test.log'), 'utf8'); },
  });
  const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, deps);
  track(result);
  assert.equal(result.status, 'ok', result.notes.join(' | '));
  assert.deepEqual(validateSessionResult(result), []);
  assert.match(ctlSeen ?? '', /fake run-my-test --ctl /);
  assert.equal(result.capture.reason, 'broken passed');
  assert.match(result.capture.command, /exit 0$/);
  assert.equal(result.capture.order.length, 3);
  assert.match(result.capture.salt, /^[0-9a-f]{32}$/, 'salt wird im Ergebnis gespeichert');
  assert.equal(result.harness.integrity.capture_outside_access, false);
  assert.ok(result.harness.flags.includes('--tools Bash,Write'));
  assert.ok(result.harness.flags.includes('--max-turns 80'));
});

test('capturepeek: capture_outside_access', async () => {
  const deps = fakeDeps('capturepeek');
  const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, deps);
  track(result);
  assert.equal(result.harness.integrity.capture_outside_access, true);
  assert.notEqual(result.status, 'aborted');
  // Der RUN-Text (in der Write-Eingabe) nennt den Repo-Pfad unter dem Heimatordner: im raw-Protokoll steht ~.
  const raw = readFileSync(join(deps.resultsRoot, 'r-test', 'raw', `fake-mcp-capture-seed${SEED}.jsonl`), 'utf8');
  assert.ok(raw.includes('"~/'), 'Heimatpfad im Protokoll ersetzt (Gegenprobe: es gab ihn)');
  assert.ok(!raw.includes(homedir()));
});

test('capture: belegte Ports 9222/9223 brechen vor dem Claude-Start ab', async () => {
  const deps = fakeDeps('capture', { portBusy: async (port) => port === 9223 });
  const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, deps);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('ports 9222/9223 busy')));
  assert.equal(result.harness.session_jsonl_sha256, null, 'Claude lief nicht');
  assert.equal(existsSync(join(deps.envOverrides.HOME, '.claude')), false);
});

test('zweiter Lauf ohne --replace wirft vor dem Start, mit --replace laeuft er', async () => {
  const deps = fakeDeps('ok');
  track((await run({ slug: 'fake-mcp', type: 'explore' }, deps)).result);
  await assert.rejects(run({ slug: 'fake-mcp', type: 'explore' }, deps), /already exists/);
  const again = await run({ slug: 'fake-mcp', type: 'explore', replace: true }, deps);
  track(again.result);
  assert.equal(again.result.status, 'ok');
});

test('Browser ausser Google Chrome: aborted', async () => {
  const deps = fakeDeps('ok', {
    listProcesses: () => [{ pid: 999_999, command: '/usr/bin/chromium --remote-debugging-port=1234' }],
  });
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, deps);
  track(result);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('/usr/bin/chromium')));
});

test('F1: Browser des Tests unter dem Arbeitsordner eines Laufs (cp-run-) zaehlt nicht, derselbe Browser ausserhalb schon', async () => {
  const inRun = `/opt/pw/chrome-headless-shell --remote-debugging-pipe --user-data-dir=${join(tmpdir(), 'cp-run-abc123', 'tmp', 'pw-profile')}`;
  const outside = '/opt/pw/chrome-headless-shell --remote-debugging-pipe --user-data-dir=/var/tmp/other-profile';
  const ok = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('ok', { listProcesses: () => [{ pid: 999_998, command: inRun }] }));
  track(ok.result);
  assert.equal(ok.result.status, 'ok', ok.result.notes.join(' | '));
  assert.deepEqual(ok.result.harness.browser_binaries, [], 'Test-Browser steht nicht unter den Browsern des Teilnehmers');
  const bad = await run({ slug: 'fake-mcp', type: 'explore', replace: true }, fakeDeps('ok', { listProcesses: () => [{ pid: 999_998, command: outside }] }));
  track(bad.result);
  assert.equal(bad.result.status, 'aborted', 'Gegenprobe: ohne cp-run- bleibt es ein fremder Browser');
  assert.ok(bad.result.notes.some((n) => n.includes('chrome-headless-shell')));
});

test('F2: Sitzungsende beendet keinen Lauscher auf den Testports, der nicht zu eigenen Prozessen gehoert', async () => {
  let stranger = null;
  const deps = fakeDeps('capture', {
    // Nach dem Schnappschuss, waehrend der Sitzung: ein fremder Prozess belegt einen Testport (wie Julians Chrome).
    onAppStarted: async () => {
      stranger = spawn(process.execPath, ['-e', `require('node:net').createServer(s=>s.end()).listen(${PORTS[0]},'127.0.0.1',()=>console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
      await once(stranger.stdout, 'data');
    },
  });
  try {
    const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, deps);
    track(result);
    assert.equal(result.capture.reason, 'ports busy', 'Gegenprobe: der Fremde war auf dem Testport (Nachpruefung verweigert)');
    assert.equal(isAlive(stranger.pid), true, 'Fremder Prozess lebt nach der Sitzung');
  } finally { stranger?.kill('SIGKILL'); }
});

test('F12: Rest aus run-my-test (eingetragen) wird am Sitzungsende beendet, ein nicht eingetragener bleibt', async () => {
  const pidsFile = join(tmp('cp-rs-pids-'), 'pids.json');
  const base = fakeDeps('orphan');
  const deps = { ...base, envOverrides: { ...base.envOverrides, FAKE_CP_PIDS_FILE: pidsFile } };
  let pids = null;
  try {
    const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, deps);
    track(result);
    pids = JSON.parse(readFileSync(pidsFile, 'utf8'));
    await new Promise((r) => { setTimeout(r, 300); });
    assert.equal(isAlive(pids.other), true, 'nicht eingetragener Rest lebt (Gegenprobe: es gab ihn)');
    assert.equal(isAlive(pids.mine), false, 'eingetragener Rest beendet');
  } finally {
    if (pids) for (const pid of [pids.mine, pids.other]) { try { process.kill(-pid, 'SIGKILL'); } catch { /* weg */ } }
  }
});

test('CLI-Teilnehmer: --tools Bash,Read,Write, Hook Bash|Read mit Sitzungsordner, Skill-Dateien im Sitzungsordner', async () => {
  const { result } = await run({ slug: 'fake-cli', type: 'explore' }, fakeDeps('ok'));
  track(result);
  assert.equal(result.status, 'ok', result.notes.join(' | '));
  const flags = result.harness.flags;
  assert.ok(flags.includes('--tools Bash,Read,Write'));
  assert.ok(flags.includes('"~/'), 'Hook-Pfad unter dem Heimatordner wurde durch ~ ersetzt (Gegenprobe: es gab ihn)');
  assert.ok(!JSON.stringify(result).includes(homedir()));
  assert.ok(flags.includes('"matcher":"Bash|Read"'), 'Hook steht in den Claude-Argumenten');
  const hook = result.harness.tool_setup.hook.hooks.PreToolUse[0];
  assert.equal(hook.matcher, 'Bash|Read');
  const rundir = result.harness.run_dir;
  assert.ok(hook.hooks[0].command.endsWith(` fakecli,sleep "${rundir}"`), hook.hooks[0].command);
  assert.ok(existsSync(join(rundirOf(result), 'skill', 'fake-skill.md')), 'Skill-Datei liegt im Sitzungsordner');
  const skill = readFileSync(join(rundirOf(result), 'skill.md'), 'utf8');
  assert.ok(skill.includes(join(rundirOf(result), 'skill')), 'Skill-Text nennt den Ordner der Skill-Dateien');
  assert.ok(existsSync(join(rundirOf(result), 'fakecli-closed')), 'cleanupArgs liefen');
  assert.equal(result.harness.calls_ledger.length, 1);
  assert.equal(result.harness.calls_ledger[0].tool, 'cli__fakecli__open');
});

test('CLI capture: Kopf run-my-test dazu', async () => {
  const { result } = await run({ slug: 'fake-cli', type: 'capture' }, fakeDeps('capture'));
  track(result);
  assert.equal(result.status, 'ok', result.notes.join(' | '));
  assert.ok(result.harness.flags.includes('--tools Bash,Read,Write'));
  assert.ok(result.harness.flags.includes('fakecli,sleep,run-my-test'));
});

test('smoke: --max-turns 15', async () => {
  const deps = fakeDeps('ok');
  const { result, outPath } = await run({ slug: 'fake-mcp', type: 'explore', smoke: true }, deps);
  track(result);
  assert.ok(result.harness.flags.includes('--max-turns 15'));
  assert.ok(readdirSync(dirname(outPath)).length >= 1);
});

test('captureOutsideAccess: Treffer je Spur, Gegenproben', () => {
  const resultsRoot = tmp('cp-rs-res-');
  const secret = tmp('cp-rs-secret-');
  const check = (runText, logText = '') => {
    const dir = tmp('cp-rs-peek-');
    const testDir = join(dir, 'test');
    mkdirSync(testDir);
    writeFileSync(join(testDir, 'RUN'), runText);
    writeFileSync(join(dir, 'log'), logText);
    return captureOutsideAccess({ testDir, logFile: join(dir, 'log'), secretDir: secret, resultsRoot });
  };
  assert.equal(check('npx playwright test'), false, 'harmloser RUN');
  assert.equal(check(`cat ${secret}/x`), true, 'secretDir');
  assert.equal(check(`ls ${resultsRoot}`), true, 'Ergebnisordner');
  assert.equal(check('node x --secret-dir y'), true, '--secret-dir');
  assert.equal(check('ps -ef | grep run-my-test'), true, 'ps');
  assert.equal(check('npx playwright test --reporter=list'), false, 'ps nur als eigenes Wort (Gegenprobe)');
  assert.equal(check(`cat ${homedir()}/.ssh/x`), true, 'Heimatpfad im RUN');
  assert.equal(check('exit 0', `at ${homedir()}/Library/Caches/ms-playwright/x`), false, 'Heimatpfad nur im Protokoll zaehlt nicht');
  assert.equal(check('exit 0', `at ${toolchainDir()}/node_modules/@playwright/test/x.js`), false, 'Werkzeugkette im Protokoll zaehlt nicht');
  assert.equal(check('exit 0', `read ${join(ROOT, 'bugs')}/x`), true, 'Parcours-Pfad im Protokoll');
});

test('Write ausserhalb des Sitzungsordners: aborted (MCP und CLI), Write innen bleibt ok', async () => {
  const outside = tmp('cp-rs-wout-');
  for (const slug of ['fake-mcp', 'fake-cli']) {
    const target = join(outside, `${slug}.txt`);
    const { result } = await run({ slug, type: 'explore' }, fakeDeps('writeoutside', { envOverrides: { ...fakeDeps('x').envOverrides, FAKE_CP_MODE: 'writeoutside', FAKE_CP_WRITE_TO: target } }));
    track(result);
    assert.equal(result.status, 'aborted', slug);
    assert.deepEqual(result.harness.tool_lock.non_mcp_executed, ['Write'], slug);
  }
  // Pfadname mit "permission"/"denied": der Erfolgstext nennt das Wort, das ist keine Ablehnung -> weiter aborted
  const sneaky = join(outside, 'permission-denied.txt');
  const s2 = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('writeoutside', { envOverrides: { ...fakeDeps('x').envOverrides, FAKE_CP_MODE: 'writeoutside', FAKE_CP_WRITE_TO: sneaky } }));
  track(s2.result);
  assert.equal(s2.result.status, 'aborted', 'permission im Pfad');
  assert.deepEqual(s2.result.harness.tool_lock.non_mcp_executed, ['Write'], 'permission im Pfad');
  // Gegenprobe: der normale Lauf schreibt report.json im Sitzungsordner und bleibt ok
  const ok = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('ok'));
  track(ok.result);
  assert.equal(ok.result.status, 'ok');
  assert.deepEqual(ok.result.harness.tool_lock.non_mcp_executed, []);
});

test('session.json im Steuerordner veraendert: aborted', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, fakeDeps('tamper'));
  track(result);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('session.json')), result.notes.join(' | '));
  // Gegenprobe: der unveraenderte capture-Lauf meldet das nicht
  const clean = await run({ slug: 'fake-mcp', type: 'capture' }, fakeDeps('capture'));
  track(clean.result);
  assert.equal(clean.result.notes.some((n) => n.includes('session.json')), false);
});

test('session.json im Steuerordner geloescht: aborted', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'capture' }, fakeDeps('delsession'));
  track(result);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('session.json')), result.notes.join(' | '));
});

test('Exit != 0 mit vorhandener JSONL und Erfolgs-Ergebnis: aborted mit Exit-Notiz', async () => {
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, fakeDeps('exitcode'));
  track(result);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('exited with code 3')), result.notes.join(' | '));
  assert.ok(result.harness.session_jsonl_sha256, 'JSONL war vorhanden');
});

test('Modell weicht vom Pin ab: aborted', async () => {
  const deps = fakeDeps('ok');
  deps.envOverrides.FAKE_CP_MODEL = 'claude-sonnet-5-5';
  const { result } = await run({ slug: 'fake-mcp', type: 'explore' }, deps);
  track(result);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('model mismatch')), result.notes.join(' | '));
});

test('Versions-Mismatch des Teilnehmers: aborted', async () => {
  registerCpParticipant('fake-badver', {
    kind: 'mcp', name: 'fake', display: 'Fake MCP', package: 'fake-mcp', version: '1.0.0',
    command: process.execPath, args: [join(BR_FIX, 'fake-mcp.mjs')], env: () => ({}), skillFiles: [], extraCommands: [], profile_isolation: 'test',
  });
  const { result } = await run({ slug: 'fake-badver', type: 'explore' }, fakeDeps('ok'));
  track(result);
  assert.equal(result.status, 'aborted');
  assert.ok(result.notes.some((n) => n.includes('version mismatch')), result.notes.join(' | '));
});

test('captureOutsideAccess: Toolchain-Umgehung, Steuerordner, Log-Spuren', () => {
  const resultsRoot = tmp('cp-rs-res-');
  const secret = tmp('cp-rs-secret-');
  const ctl = tmp('cp-rs-ctl-');
  const tc = toolchainDir();
  const check = (runText, logText = '', extra = {}) => {
    const dir = tmp('cp-rs-peek-');
    const testDir = join(dir, 'test');
    mkdirSync(testDir);
    writeFileSync(join(testDir, 'RUN'), runText);
    writeFileSync(join(dir, 'log'), logText);
    return captureOutsideAccess({ testDir, logFile: join(dir, 'log'), secretDir: secret, resultsRoot, ctl, ...extra });
  };
  // Umgehung: Pfad ueber die Werkzeugkette hinaus in geschuetzte Ordner
  assert.equal(check(`cat ${tc}/../../bugs/x`), true, 'toolchain/../.. im RUN');
  assert.equal(check(`cat ${tc}/node_modules/../../bugs/x`), true, 'toolchain/node_modules/../.. im RUN');
  assert.equal(check(`cat ${tc}/package.json`), true, 'Werkzeugkette ausserhalb node_modules im RUN');
  assert.equal(check(`at ${tc}/node_modules/@playwright/test/x.js:3:4`), false, 'Stacktrace der Bibliothek im RUN (Gegenprobe)');
  assert.equal(check('exit 0', `at ${tc}/../../bugs/x`), true, 'Umgehung auch im Protokoll');
  // Steuerordner
  assert.equal(check(`ls ${ctl}`), true, 'Steuerordner im RUN');
  assert.equal(check(`ls /tmp/other`), false, 'anderer Pfad (Gegenprobe)');
  // Spuren im Protokoll
  assert.equal(check('exit 0', `cat ${secret}/x`), true, 'secretDir im Protokoll');
  assert.equal(check('exit 0', 'node x --secret-dir y'), true, '--secret-dir im Protokoll');
  assert.equal(check('exit 0', 'ps -ef'), false, 'ps im Protokoll zaehlt nicht (Gegenprobe: im RUN schon)');
  assert.equal(check('ps -ef'), true, 'ps im RUN');
  assert.equal(check('exit 0', `ran in ${ctl}`), false, 'Steuerordner im Protokoll zaehlt nicht (eigener Aufruf)');
});
