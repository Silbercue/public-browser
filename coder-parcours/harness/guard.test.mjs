import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandAllowedAny, readAllowed, toolLockMulti } from './guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('commandAllowedAny: jedes Segment darf mit einem beliebigen Kopf beginnen', () => {
  assert.equal(commandAllowedAny('agent-browser open x && sleep 1', ['agent-browser', 'sleep']), true);
  assert.equal(commandAllowedAny('sleep 1 && agent-browser snapshot', ['agent-browser', 'sleep']), true);
  // Gegenprobe: derselbe Befehl ohne sleep in den Koepfen
  assert.equal(commandAllowedAny('agent-browser open x && sleep 1', ['agent-browser']), false);
  assert.equal(commandAllowedAny('cat /etc/passwd', ['agent-browser', 'sleep']), false);
  assert.equal(commandAllowedAny('run-my-test; rm -rf x', ['run-my-test']), false);
  assert.equal(commandAllowedAny('run-my-test', ['run-my-test']), true);
  assert.equal(commandAllowedAny('run-my-test --verbose', ['run-my-test']), true);
  assert.equal(commandAllowedAny('mkdir -p out/screenshots', ['agent-browser', 'mkdir'], makeRundir()), true);
  assert.equal(commandAllowedAny('agent-browser open x', []), false);
  assert.equal(commandAllowedAny('agent-browser open x', undefined), false);
});

test('commandAllowedAny: Faelle aus blind-run.test.mjs (cliCommandAllowed) mit einem Kopf', () => {
  const ok = [
    'agent-browser open https://x.test',
    '  agent-browser snapshot -i',
    'agent-browser click @e1 && agent-browser snapshot',
    'agent-browser eval "a; b | c > d"',
    "agent-browser eval 'x && `y` $(z) > 1'",
    'agent-browser snapshot 2>&1',
    'agent-browser get text @e3 | agent-browser eval --stdin',
    'agent-browser',
  ];
  const bad = [
    'echo probe', 'ls /', '', '   ',
    'agent-browser snapshot | head -5',
    'agent-browser open x; cat /etc/hosts',
    'agent-browser open x & ls',
    'agent-browser open x || rm -rf y',
    'FOO=1 agent-browser open x',
    'agent-browser eval "$(cat secret)"',
    'agent-browser eval `whoami`',
    'agent-browser screenshot > shot.png',
    'agent-browser eval < input.js',
    'agent-browserx open',
    'agent-browser open x\nls',
    'agent-browser eval "unterminated',
  ];
  for (const c of ok) assert.equal(commandAllowedAny(c, ['agent-browser']), true, `sollte erlaubt sein: ${c}`);
  for (const c of bad) assert.equal(commandAllowedAny(c, ['agent-browser']), false, `sollte gesperrt sein: ${c}`);
  // Kommando-Substitution und Umleitungen auch mit erlaubtem zweiten Kopf gesperrt
  for (const c of ['sleep $(cat x)', 'sleep `id`', 'cp a b > c', 'mkdir x < y']) {
    assert.equal(commandAllowedAny(c, ['agent-browser', 'sleep', 'cp', 'mkdir']), false, `sollte gesperrt sein: ${c}`);
  }
  // Regex-Sonderzeichen im Kopf werden wortwoertlich genommen
  assert.equal(commandAllowedAny('playwrightXcli open', ['playwright.cli']), false);
});

// --- toolLockMulti ---

const A = (ts, id, name, input = {}) => JSON.stringify({
  type: 'assistant', timestamp: ts, message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] },
});
const U = (ts, id, content, isError) => JSON.stringify({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] },
});
const DENY_BASH = 'blocked by benchmark harness: only agent-browser, sleep commands are allowed';
const DENY_READ = 'Read is limited to screenshots inside the session folder.';

function fixture(rundir) {
  return [
    A('2026-10-21T10:00:00Z', 'b1', 'Bash', { command: 'agent-browser open http://x && sleep 1' }),
    U('2026-10-21T10:00:01Z', 'b1', 'ok'),
    A('2026-10-21T10:00:02Z', 'b2', 'Bash', { command: 'cat /etc/hosts' }),
    U('2026-10-21T10:00:03Z', 'b2', DENY_BASH, true),
    A('2026-10-21T10:00:04Z', 'r1', 'Read', { file_path: join(rundir, 'shot.png') }),
    U('2026-10-21T10:00:05Z', 'r1', [{ type: 'image', source: {} }]),
    A('2026-10-21T10:00:06Z', 'r2', 'Read', { file_path: join(rundir, 'x.mjs') }),
    U('2026-10-21T10:00:07Z', 'r2', `PreToolUse:Read hook error: ${DENY_READ}`, true),
    A('2026-10-21T10:00:08Z', 'w1', 'Write', { file_path: join(rundir, 'report.json') }),
    U('2026-10-21T10:00:09Z', 'w1', 'File created'),
  ].join('\n');
}

function makeRundir() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-guard-'));
  writeFileSync(join(dir, 'shot.png'), 'png');
  writeFileSync(join(dir, 'x.mjs'), 'js');
  return dir;
}

test('toolLockMulti: erlaubte Koepfe und Bild-Read sind eigen, verweigerte Versuche zaehlen, nichts ausgefuehrt', () => {
  const rundir = makeRundir();
  const lock = toolLockMulti(fixture(rundir), { heads: ['agent-browser', 'sleep'], readRoot: rundir });
  assert.deepEqual(lock, { bash_attempted: 1, bash_denied: true, read_attempted: 1, read_denied: true, non_mcp_executed: [] });
});

test('toolLockMulti: ausgefuehrter Fremdbefehl und ausgefuehrtes verbotenes Read sind Verstoesse', () => {
  const rundir = makeRundir();
  const leaked = fixture(rundir)
    .replace(JSON.stringify(DENY_BASH), JSON.stringify('127.0.0.1 localhost'))
    .replace(JSON.stringify(`PreToolUse:Read hook error: ${DENY_READ}`), JSON.stringify('     1\tconsole.log(1)'));
  const lock = toolLockMulti(leaked, { heads: ['agent-browser', 'sleep'], readRoot: rundir });
  assert.deepEqual(lock.non_mcp_executed.sort(), ['Bash', 'Read']);
  assert.equal(lock.bash_denied, false);
  assert.equal(lock.read_denied, false);
});

test('toolLockMulti: MCP-Sitzung mit run-my-test — MCP-Aufrufe und run-my-test eigen, Bash ausserhalb nicht', () => {
  const jsonl = [
    A('2026-10-21T10:00:00Z', 'm1', 'mcp__pb__view_page', {}),
    U('2026-10-21T10:00:01Z', 'm1', 'page'),
    A('2026-10-21T10:00:02Z', 'b1', 'Bash', { command: 'run-my-test' }),
    U('2026-10-21T10:00:03Z', 'b1', 'exit code: 0'),
    A('2026-10-21T10:00:04Z', 'b2', 'Bash', { command: 'ls' }),
    U('2026-10-21T10:00:05Z', 'b2', 'a b c'),
  ].join('\n');
  const lock = toolLockMulti(jsonl, { mcpPrefix: 'mcp__pb__', heads: ['run-my-test'] });
  assert.equal(lock.bash_attempted, 1);
  assert.deepEqual(lock.non_mcp_executed, ['Bash']);
  // Gegenprobe: ohne mcpPrefix ist der MCP-Aufruf fremd
  assert.deepEqual(toolLockMulti(jsonl, { heads: ['run-my-test'] }).non_mcp_executed, ['mcp__pb__view_page', 'Bash']);
});

test('toolLockMulti: ohne readRoot ist jedes Read fremd (wie blind-run), Ablehnung „No such tool“ zaehlt nicht', () => {
  const jsonl = [
    A('2026-10-21T10:00:00Z', 'r1', 'Read', { file_path: '/x.png' }),
    U('2026-10-21T10:00:01Z', 'r1', '<tool_use_error>Error: No such tool available: Read. Read is disabled for this session.</tool_use_error>', true),
  ].join('\n');
  const lock = toolLockMulti(jsonl, { mcpPrefix: 'mcp__pb__', heads: [] });
  assert.equal(lock.bash_attempted, 1);
  assert.deepEqual(lock.non_mcp_executed, []);
  const ran = jsonl.replace(/<tool_use_error>[^"]*<\/tool_use_error>/, 'content');
  assert.deepEqual(toolLockMulti(ran, { mcpPrefix: 'mcp__pb__', heads: [] }).non_mcp_executed, ['Read']);
});

// --- mkdir/cp nur im Sitzungsordner ---

test('commandAllowedAny: mkdir/cp nur mit Pfaden im Sitzungsordner', () => {
  const rundir = makeRundir();
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  writeFileSync(join(outside, 'a.txt'), 'x');
  writeFileSync(join(rundir, 'tpl.md'), 'x');
  symlinkSync(outside, join(rundir, 'linkdir'));
  const heads = ['agent-browser', 'mkdir', 'cp'];
  const ok = (c) => assert.equal(commandAllowedAny(c, heads, rundir), true, `sollte erlaubt sein: ${c}`);
  const bad = (c) => assert.equal(commandAllowedAny(c, heads, rundir), false, `sollte gesperrt sein: ${c}`);
  // innen: erlaubt
  ok('mkdir -p out/screenshots');
  ok(`mkdir -p ${join(rundir, 'out')}`);
  ok('cp tpl.md out/report.md');
  ok('cp -R tpl.md copy.md');
  ok('agent-browser open x && mkdir -p out');
  // aussen / Ausbruch / Symlink: gesperrt
  bad(`mkdir -p ${outside}/x`);
  bad('mkdir -p /tmp/cp-guard-abs');
  bad(`cp ${outside}/a.txt .`);
  bad('cp tpl.md /etc/x');
  bad('mkdir -p ../ausbruch');
  bad('mkdir -p out/../../ausbruch');
  bad('mkdir -p linkdir/neu');
  bad('cp tpl.md linkdir/stolen.md');
  bad('cp linkdir/a.txt got.txt');
  bad('mkdir');
  bad('mkdir -p $HOME/x');
  bad('mkdir -p ~/x');
  bad('mkdir -p out/*');
  bad('cp --target-directory=/etc tpl.md');
  bad('cp -t /etc tpl.md');
  bad('mkdir -p out && mkdir -p /tmp/cp-guard-abs');
  // ohne Wurzel sind mkdir/cp gesperrt, andere Koepfe nicht
  assert.equal(commandAllowedAny('mkdir -p out', heads), false);
  assert.equal(commandAllowedAny('agent-browser open x', heads), true);
});

test('toolLockMulti: mkdir ausserhalb des Sitzungsordners zaehlt als fremd, innerhalb als eigen', () => {
  const rundir = makeRundir();
  const mk = (cmd) => [A('2026-10-21T10:00:01Z', 'b1', 'Bash', { command: cmd })].join('\n');
  const inside = toolLockMulti(mk('mkdir -p out'), { heads: ['mkdir'], readRoot: rundir });
  assert.equal(inside.bash_attempted, 0);
  const outside = toolLockMulti(mk('mkdir -p /tmp/cp-guard-abs'), { heads: ['mkdir'], readRoot: rundir });
  assert.equal(outside.bash_attempted, 1);
});

// --- readAllowed ---

test('readAllowed: nur Bilder innerhalb des Sitzungsordners', () => {
  const rundir = makeRundir();
  writeFileSync(join(rundir, 'shot.PNG'), 'png');
  for (const ext of ['jpg', 'jpeg', 'webp']) writeFileSync(join(rundir, `a.${ext}`), 'x');
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  writeFileSync(join(outside, 'x.png'), 'png');
  mkdirSync(join(rundir, 'sub'));
  writeFileSync(join(rundir, 'sub', 'deep.png'), 'png');

  assert.equal(readAllowed(join(rundir, 'shot.PNG'), rundir), true);
  assert.equal(readAllowed(join(rundir, 'sub', 'deep.png'), rundir), true);
  for (const ext of ['jpg', 'jpeg', 'webp']) assert.equal(readAllowed(join(rundir, `a.${ext}`), rundir), true);
  assert.equal(readAllowed(join(rundir, 'x.mjs'), rundir), false);
  assert.equal(readAllowed('/etc/x.png', rundir), false);
  assert.equal(readAllowed(`${rundir}/../${outside.split('/').pop()}/x.png`, rundir), false);
  assert.equal(readAllowed(join(rundir, '..', 'x.png'), rundir), false);
  assert.equal(readAllowed(join(rundir, 'missing.png'), rundir), false);
  assert.equal(readAllowed(undefined, rundir), false);
  assert.equal(readAllowed(join(rundir, 'shot.png'), undefined), false);
});

test('readAllowed: Verzeichnis namens x.png, relativer Pfad, Symlink auf Datei innen', () => {
  const rundir = makeRundir();
  mkdirSync(join(rundir, 'x.png'));
  writeFileSync(join(rundir, 'real.png'), 'png');
  symlinkSync(join(rundir, 'real.png'), join(rundir, 'inner.png'));
  assert.equal(readAllowed(join(rundir, 'x.png'), rundir), false);
  assert.equal(readAllowed('real.png', rundir), true);
  assert.equal(readAllowed('../real.png', rundir), false);
  assert.equal(readAllowed(join(rundir, 'inner.png'), rundir), true);
});

test('readAllowed: Symlink im Sitzungsordner auf ein Bild ausserhalb wird verweigert', () => {
  const rundir = makeRundir();
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  writeFileSync(join(outside, 'secret.png'), 'png');
  symlinkSync(join(outside, 'secret.png'), join(rundir, 'link.png'));
  assert.equal(readAllowed(join(rundir, 'link.png'), rundir), false);
  assert.equal(readAllowed(join(rundir, 'shot.png'), rundir), true);
});

// --- guard-hook.mjs als Kindprozess ---

function hook(input, heads, rundir) {
  const r = spawnSync(process.execPath, [join(HERE, 'guard-hook.mjs'), heads, rundir ?? ''], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test('guard-hook: Read auf Bild im Sitzungsordner erlaubt, auf .mjs verweigert', () => {
  const rundir = makeRundir();
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(rundir, 'shot.png') } }, 'agent-browser', rundir), null);
  const denied = hook({ tool_name: 'Read', tool_input: { file_path: join(rundir, 'x.mjs') } }, 'agent-browser', rundir);
  assert.equal(denied.permissionDecision, 'deny');
  assert.equal(denied.permissionDecisionReason, DENY_READ);
});

test('guard-hook: Bash nach Kopfliste, kaputte Eingabe verweigert', () => {
  const rundir = makeRundir();
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'agent-browser open x && sleep 1' } }, 'agent-browser,sleep', rundir), null);
  const denied = hook({ tool_name: 'Bash', tool_input: { command: 'cat /etc/passwd' } }, 'agent-browser,sleep', rundir);
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /blocked by benchmark harness/);
  const r = spawnSync(process.execPath, [join(HERE, 'guard-hook.mjs'), 'agent-browser', rundir], { input: 'not json', encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('guard-hook: Read ohne Sitzungsordner, Read ohne file_path, leere Kopfliste, Fremdwerkzeug', () => {
  const rundir = makeRundir();
  writeFileSync(join(rundir, 'shot.png'), 'png');
  // Read ohne Wurzel (argv[3] leer): verweigert, obwohl die Datei ein Bild ist; mit Wurzel erlaubt (Gegenprobe)
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(rundir, 'shot.png') } }, 'agent-browser', '').permissionDecision, 'deny');
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: join(rundir, 'shot.png') } }, 'agent-browser', rundir), null);
  // Read ohne file_path
  assert.equal(hook({ tool_name: 'Read', tool_input: {} }, 'agent-browser', rundir).permissionDecision, 'deny');
  // leere Kopfliste: jede Bash-Zeile verweigert
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'agent-browser open x' } }, '', rundir).permissionDecision, 'deny');
  // Fremdwerkzeug wird vom Hook nicht angefasst
  assert.equal(hook({ tool_name: 'Grep', tool_input: { pattern: 'x' } }, 'agent-browser', rundir), null);
});

test('guard-hook: mkdir/cp mit Pfad ausserhalb verweigert, innerhalb erlaubt', () => {
  const rundir = makeRundir();
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'mkdir -p out' } }, 'agent-browser,mkdir,cp', rundir), null);
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'cp /etc/hosts out' } }, 'agent-browser,mkdir,cp', rundir).permissionDecision, 'deny');
});
