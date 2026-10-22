import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandAllowedAny, foreignBrowserRequest, protectedConfigPath, readAllowed, toolLockMulti, writeAllowed } from './guard.mjs';

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

// --- Write nur im Sitzungsordner ---

const writeJsonl = (path, result = 'File created', isError) => [A('2026-10-21T10:00:00Z', 'w', 'Write', { file_path: path }), U('2026-10-21T10:00:01Z', 'w', result, isError)].join('\n');

test('toolLockMulti mit writeRoot: Write ausserhalb ist Verstoss, Write innen (absolut und relativ) nicht', () => {
  const rundir = makeRundir();
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  const lock = (path) => toolLockMulti(writeJsonl(path), { mcpPrefix: 'mcp__pb__', writeRoot: rundir });
  assert.deepEqual(lock(join(outside, 'x.txt')).non_mcp_executed, ['Write'], 'absolut ausserhalb');
  assert.deepEqual(lock(join(rundir, 'report.json')).non_mcp_executed, [], 'innen absolut (Gegenprobe)');
  assert.deepEqual(lock('report.json').non_mcp_executed, [], 'innen relativ (Gegenprobe)');
  assert.deepEqual(lock(join(rundir, 'sub', 'deep', 'a.txt')).non_mcp_executed, [], 'neue Unterordner innen (Gegenprobe)');
  // abgelehntes Write ausserhalb zaehlt als Versuch, nicht als Ausfuehrung
  const denied = toolLockMulti(writeJsonl(join(outside, 'x.txt'), `Claude requested permissions to write to ${join(outside, 'x.txt')}, but you haven't granted it yet.`, true), { mcpPrefix: 'mcp__pb__', writeRoot: rundir });
  assert.deepEqual(denied.non_mcp_executed, []);
  assert.equal(denied.bash_attempted, 1);
});

test('toolLockMulti: Ablehnung nur mit is_error und Ablehnungstext am Anfang, nie per Freitext (Umgehung ueber Dateinamen)', () => {
  const rundir = makeRundir();
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  const lock = (path, result, isError) => toolLockMulti(writeJsonl(path, result, isError), { mcpPrefix: 'mcp__pb__', writeRoot: rundir });
  // Erfolgreicher Write ausserhalb, Pfadname enthaelt die alten Stichwoerter: bleibt Verstoss
  for (const word of ['permission', 'denied', 'blocked', 'not allowed']) {
    const p = join(outside, `${word}.txt`);
    assert.deepEqual(lock(p, `File created successfully at: ${p}`).non_mcp_executed, ['Write'], `Erfolgstext mit ${word}`);
    assert.deepEqual(lock(p, `File created successfully at: ${p}`, false).non_mcp_executed, ['Write'], `is_error false, ${word}`);
  }
  // Auch ein Fehlerergebnis, das nur im Freitext "permission denied" nennt, ist keine Ablehnung der Sperre
  const p = join(outside, 'x.txt');
  assert.deepEqual(lock(p, `EACCES: permission denied, open '${p}'`, true).non_mcp_executed, ['Write'], 'Freitext-Fehler');
  // is_error ohne Ablehnungstext am Anfang: keine Ablehnung, auch wenn der Text ihn weiter hinten enthaelt
  assert.deepEqual(lock(p, `File created. blocked by benchmark harness: ${p}`, true).non_mcp_executed, ['Write'], 'Text nicht am Anfang');
  // Gegenproben: echte Ablehnungen (Claude Code, Hook, gesperrtes Werkzeug) zaehlen als abgelehnt
  assert.deepEqual(lock(p, `Claude requested permissions to write to ${p}, but you haven't granted it yet.`, true).non_mcp_executed, []);
  assert.deepEqual(lock(p, 'Permission to use Write has been denied.', true).non_mcp_executed, []);
  assert.deepEqual(lock(p, 'PreToolUse:Write hook error: blocked by benchmark harness: no', true).non_mcp_executed, []);
  assert.deepEqual(lock(p, '<tool_use_error>Error: No such tool available: Write. Available: x</tool_use_error>', true).non_mcp_executed, []);
  // dieselbe Ablehnung ohne is_error zaehlt nicht
  assert.deepEqual(lock(p, `Claude requested permissions to write to ${p}, but you haven't granted it yet.`).non_mcp_executed, ['Write']);
});

test('writeAllowed: Datei "..x" im Ordner ist innen, nach innen zeigender haengender Symlink ist innen', () => {
  const rundir = makeRundir();
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  symlinkSync(join(rundir, 'later.txt'), join(rundir, 'to-inside'));
  symlinkSync(join(rundir, 'to-inside'), join(rundir, 'chain-inside'));
  symlinkSync(join(outside, 'nothing'), join(rundir, 'to-outside'));
  symlinkSync(join(rundir, 'to-outside'), join(rundir, 'chain-outside'));
  assert.equal(writeAllowed('..x', rundir), true, '..x');
  assert.equal(writeAllowed(join(rundir, '..x', 'a.txt'), rundir), true, '..x/ als Ordner');
  assert.equal(writeAllowed('..', rundir), false, '.. selbst (Gegenprobe)');
  assert.equal(writeAllowed(join('..', 'x'), rundir), false, '../x (Gegenprobe)');
  assert.equal(writeAllowed('to-inside', rundir), true, 'haengender Symlink nach innen');
  assert.equal(writeAllowed('chain-inside', rundir), true, 'Kette nach innen');
  assert.equal(writeAllowed('to-outside', rundir), false, 'haengender Symlink nach aussen (Gegenprobe)');
  assert.equal(writeAllowed('chain-outside', rundir), false, 'Kette nach aussen (Gegenprobe)');
});

test('writeAllowed: haengende Symlinks mit relativem Ziel (ab ihrem Ordner gelesen) und Symlink-Schleife', () => {
  const rundir = makeRundir();
  mkdirSync(join(rundir, 'sub'));
  symlinkSync('../later.txt', join(rundir, 'sub', 'rel-in')); // -> rundir/later.txt, noch nicht da
  symlinkSync('../../cp-outside-nothing', join(rundir, 'sub', 'rel-out')); // -> eine Ebene ueber rundir
  symlinkSync('loop-b', join(rundir, 'loop-a'));
  symlinkSync('loop-a', join(rundir, 'loop-b'));
  // eine Kette aus 10 Gliedern nach innen: ueber der Tiefengrenze, daher verweigert (streng)
  for (let i = 0; i < 10; i++) symlinkSync(i === 9 ? 'end.txt' : `c${i + 1}`, join(rundir, `c${i}`));
  assert.equal(writeAllowed(join('sub', 'rel-in'), rundir), true, 'relatives Ziel nach innen');
  assert.equal(writeAllowed(join('sub', 'rel-out'), rundir), false, 'relatives Ziel nach aussen (Gegenprobe)');
  assert.equal(writeAllowed('loop-a', rundir), false, 'Schleife wird nicht als innen gewertet');
  assert.equal(writeAllowed('c9', rundir), true, 'kurze Kette nach innen (Gegenprobe zur Tiefengrenze)');
  assert.equal(writeAllowed('c0', rundir), false, 'zu lange Kette wird verweigert');
});

test('toolLockMulti mit writeRoot: ../-Ausbruch und Symlinks nach aussen sind Verstoesse', () => {
  const rundir = makeRundir();
  const outside = mkdtempSync(join(tmpdir(), 'cp-guard-out-'));
  symlinkSync(outside, join(rundir, 'link'));
  symlinkSync(join(outside, 'nothing-yet'), join(rundir, 'dangling'));
  const lock = (path) => toolLockMulti(writeJsonl(path), { mcpPrefix: 'mcp__pb__', writeRoot: rundir }).non_mcp_executed;
  assert.deepEqual(lock(join(rundir, '..', 'escape.txt')), ['Write'], '../');
  assert.deepEqual(lock('../escape.txt'), ['Write'], 'relatives ../');
  assert.deepEqual(lock(join(rundir, 'sub', '..', '..', 'escape.txt')), ['Write'], 'ueber Unterordner hinaus');
  assert.deepEqual(lock(join(rundir, 'link', 'x.txt')), ['Write'], 'Symlink-Ordner nach aussen');
  assert.deepEqual(lock(join(rundir, 'dangling')), ['Write'], 'haengender Symlink als Ziel');
  assert.deepEqual(lock(join(rundir, 'sub', '..', 'ok.txt')), [], '.. das im Ordner bleibt (Gegenprobe)');
  assert.deepEqual(lock(undefined), ['Write'], 'ohne file_path');
});

test('R4a: Optionen und Unterbefehle, die an einen fremden Browser/Profil haengen, sind gesperrt; gewoehnliche Aufrufe nicht', () => {
  const heads = ['agent-browser', 'playwright-cli', 'sleep'];
  const blocked = ['agent-browser --cdp 9222 snapshot', 'agent-browser --auto-connect open http://x/', 'agent-browser connect 9222',
    'playwright-cli attach --cdp=http://localhost:9222', 'playwright-cli open --browser=firefox', 'playwright-cli open --profile=/x',
    'playwright-cli --config=other.json open', 'agent-browser open --engine lightpanda http://x/', 'agent-browser --executable-path /bin/x open y'];
  for (const c of blocked) assert.equal(commandAllowedAny(c, heads, '/tmp'), false, c);
  const fine = ['agent-browser open http://127.0.0.1:1234/', 'agent-browser snapshot -i', 'playwright-cli click e5', 'playwright-cli open http://x/',
    'agent-browser fill @e2 "--cdp connect attach"', 'playwright-cli find --regex "profile|config"', 'sleep 2'];
  for (const c of fine) assert.equal(commandAllowedAny(c, heads, '/tmp'), true, c);
  assert.equal(foreignBrowserRequest('run-my-test --browser x'), false, 'Shim ist kein Browser-Werkzeug');
});

const H3 = ['agent-browser', 'playwright-cli', 'sleep', 'mkdir', 'cp'];

test('R4b M1: getarnte Optionen (Anfuehrungszeichen, Backslash, =Wert, Variable, Klammer) sind gesperrt, ehrliche Texte nicht', () => {
  const blocked = ['agent-browser "--cdp" 9222 snapshot', 'agent-browser --c""dp 9222 open', "agent-browser '--auto-connect' open",
    'agent-browser \\-\\-cdp 9222 open', 'playwright-cli open --b""rowser=firefox', 'agent-browser "--cdp=9222" open',
    'agent-browser --c${Z}dp 9222 open', 'agent-browser "--c${Z}dp" 9222 open', 'agent-browser --{cdp,x} 9222 open', 'agent-browser $\'--cdp\' 9222 open'];
  for (const c of blocked) assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  const fine = ['agent-browser --session {SESSION} open {TARGET_URL}', 'playwright-cli find --regex "\\$[0-9]+ Euro"', 'agent-browser fill @e1 "5 $"', 'agent-browser open "http://127.0.0.1:1234/a b"', 'agent-browser fill @e2 "ich bin -p und --cdp mitten im Text"',
    "agent-browser eval 'document.title + \"$x\"'", 'playwright-cli click "e5"', 'agent-browser find text "Warenkorb"'];
  for (const c of fine) assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
});

test('R4b M2: attach/connect und aehnliche Unterbefehle an jeder Wortstelle gesperrt, auch hinter Optionen', () => {
  const blocked = ['agent-browser --session x --headed connect 9222', 'agent-browser --json --headed connect 9222', 'playwright-cli -s=x attach --cdp=http://localhost:9222',
    "agent-browser --json 'connect' 9222", 'agent-browser --json plugin add evil', 'agent-browser --json install', 'agent-browser --json dashboard start',
    'agent-browser --json upgrade', 'agent-browser --json profiles', 'agent-browser --json CONNECT 9222'];
  for (const c of blocked) assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  const fine = ['agent-browser --json snapshot -i', 'agent-browser open http://127.0.0.1:1/connect-me', 'agent-browser wait --url "**/dashboard"', 'playwright-cli --raw snapshot'];
  for (const c of fine) assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
});

test('R4b S2: Kurzoptionen -p (Provider) und -b (Browser) gesperrt, -i und andere Kurzformen nicht', () => {
  for (const c of ['agent-browser -p ios open x', 'agent-browser -b firefox open x', 'playwright-cli -p=ios open', 'agent-browser open x -p ios']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  for (const c of ['agent-browser snapshot -i', 'agent-browser screenshot -f out.png', 'playwright-cli click e5 -d']) assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
});

test('R4b S1: Konfigurationsdateien der Werkzeuge im Sitzungsordner sind nicht schreibbar (Write und cp/mkdir), normale Dateien schon', () => {
  const rundir = makeRundir();
  for (const f of ['agent-browser.json', 'sub/agent-browser.json', '.playwright/cli.config.json', '.playwright', 'x.config.json', '.agent-browser/config.json', 'a/../agent-browser.json']) {
    assert.equal(writeAllowed(f, rundir), false, f);
    assert.equal(protectedConfigPath(f), true, f);
  }
  for (const f of ['report.json', 'notes/config.txt', 'screens/a.png']) assert.equal(writeAllowed(f, rundir), true, f);
  assert.equal(commandAllowedAny('cp x agent-browser.json', H3, rundir), false);
  assert.equal(commandAllowedAny('cp x ag""ent-browser.json', H3, rundir), false);
  assert.equal(commandAllowedAny('mkdir -p .playwright', H3, rundir), false);
  assert.equal(commandAllowedAny('mkdir -p out/screens', H3, rundir), true);
  // der Nachweis zaehlt einen geglueckten Write dorthin als Verstoss (Gegenprobe: normaler Write nicht)
  const lock = (p) => toolLockMulti(writeJsonl(p), { mcpPrefix: 'mcp__pb__', writeRoot: rundir }).non_mcp_executed;
  assert.deepEqual(lock(join(rundir, 'agent-browser.json')), ['Write']);
  assert.deepEqual(lock(join(rundir, 'report.json')), []);
});

test('R4b S1: Hook verweigert Write auf Konfigurationsdateien, erlaubt andere Writes', () => {
  const run = (input) => spawnSync(process.execPath, [join(HERE, 'guard-hook.mjs'), 'agent-browser,sleep', '/tmp'], { input: JSON.stringify(input), encoding: 'utf8' });
  const bad = run({ tool_name: 'Write', tool_input: { file_path: '/tmp/x/agent-browser.json' } });
  assert.match(bad.stdout, /"permissionDecision":"deny"/);
  assert.match(bad.stdout, /blocked by benchmark harness: /);
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: '/tmp/x/report.json' } }).stdout, '');
});

test('R4b S4: Abkoppeln und fremde Starts (nohup, setsid, launchctl, open -a, Hintergrund-Klammer) sind keine erlaubten Befehle', () => {
  for (const c of ['nohup agent-browser open x', 'setsid agent-browser open x', 'launchctl submit -l x /bin/ls', 'open -a "Google Chrome"',
    'agent-browser open x; open -a "Google Chrome"', '(agent-browser open x &)', 'agent-browser open x & disown', 'agent-browser open x | nohup cat',
    'bash -c "agent-browser open x"', 'agent-browser open x > /dev/null']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  assert.equal(commandAllowedAny('agent-browser open x & sleep 1', H3, '/tmp'), true, 'Gegenprobe: & zwischen erlaubten Befehlen');
});

test('R4b Scan 1: ungequotete Platzhalter und ~ sind gesperrt (Datei namens --cdp/connect), Adressen mit ? bleiben erlaubt; Dateien mit Option-/Unterbefehlsnamen sind nicht anlegbar', () => {
  const rundir = makeRundir();
  for (const c of ['agent-browser --c* 9222 open', 'agent-browser con* 9222', 'agent-browser --cd? open x', 'agent-browser [-]-cdp open', 'agent-browser ~/x open', 'agent-browser ~ open', 'agent-browser *']) {
    assert.equal(commandAllowedAny(c, H3, rundir), false, c);
  }
  for (const c of ['agent-browser open "http://127.0.0.1:1/?a=1"', 'agent-browser open http://127.0.0.1:1/?a=1', 'agent-browser fill @e1 "wie viel *?"', 'agent-browser fill @e1 a~b']) {
    assert.equal(commandAllowedAny(c, H3, rundir), true, c);
  }
  for (const f of ['--cdp', '-x', 'connect', 'sub/attach', 'Connect']) {
    assert.equal(writeAllowed(f, rundir), false, f);
    assert.equal(protectedConfigPath(f), true, f);
  }
  assert.equal(commandAllowedAny('mkdir connect', H3, rundir), false);
  assert.equal(commandAllowedAny('mkdir connected', H3, rundir), true, 'gewoehnlicher Name (Gegenprobe)');
  assert.equal(writeAllowed('connect-notes.md', rundir), true);
});

test('R4b Scan 2: gebuendelte Kurzoptionen (-xp, -bp, -pb) und Abkuerzungen verbotener Langoptionen (--prof, --auto, --cd) sind gesperrt, gewoehnliche Optionen nicht', () => {
  for (const c of ['agent-browser -xp ios open x', 'agent-browser -bp open x', 'agent-browser -pb open x', 'agent-browser -P ios open x', 'agent-browser --prof /x open y',
    'agent-browser --auto 9222 open', 'agent-browser --cd 9222 open', 'agent-browser --exec /bin/x open y', 'playwright-cli --conf=x open', 'agent-browser -engine x open y', 'agent-browser eval x -b firefox', 'agent-browser --json eval -b x', 'agent-browser eval x -b y', 'agent-browser eval -b -b x', 'agent-browser --session eval -b x', 'agent-browser --foo eval connect', 'agent-browser connect eval -b x', 'agent-browser open eval -b firefox', 'agent-browser eval y -b x', 'agent-browser -p1 open', 'agent-browser -p. open', 'agent-browser -xp9 open', 'agent-browser -cdpx open', 'agent-browser -b eval', 'agent-browser --PROFILE=x open']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  for (const c of ['agent-browser snapshot -i -c', 'agent-browser screenshot --full', 'agent-browser get text body --json', 'playwright-cli --raw snapshot', 'agent-browser wait --load networkidle',
    'agent-browser eval -b "ZG9j"', 'agent-browser eval --base64 "ZG9j"', 'agent-browser --json eval --stdin', 'agent-browser scroll down -5.5', 'agent-browser scroll down -500', 'agent-browser snapshot -d 3']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
  }
});

test('R4c M1: Zeilenfortsetzung (Backslash + Zeilenumbruch) wird wie in der Shell entfernt, in Einfach-Anfuehrungszeichen bleibt sie Text', () => {
  for (const c of ['agent-browser --c\\\ndp 9222 open x', 'agent-browser "--c\\\ndp" 9222 open x', 'agent-browser conn\\\nect 9222', 'agent-browser --cdp\\\n 9222 open x',
    'playwright-cli open --b\\\nrowser=firefox', 'agent-browser --hea\\\nded open x']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, JSON.stringify(c));
  }
  // Gegenprobe: Fortsetzung zwischen gewoehnlichen Woertern bleibt erlaubt, in '...' bleibt sie literaler Text.
  assert.equal(commandAllowedAny('agent-browser \\\n  open http://x.test', H3, '/tmp'), true);
  assert.equal(commandAllowedAny('agent-browser fill @e1 \'a\\\nb\'', H3, '/tmp'), true);
});

test('R4c S1: eval -b nur bei agent-browser, eval direkt nach dem Kopf und gueltigem Base64, das kein Browsername ist', () => {
  for (const c of ['playwright-cli eval -b x', 'playwright-cli eval -b dGVzdA==', 'agent-browser eval -b firefox', 'agent-browser eval -b Chrome', 'agent-browser eval -b WEBKIT',
    'agent-browser eval -b msedge', 'agent-browser eval -b edge', 'agent-browser eval -b safari', 'agent-browser eval -b chromium', 'agent-browser eval -b "a b"', 'agent-browser eval -b ab=c', 'agent-browser eval -b']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  for (const c of ['agent-browser eval -b dGVzdA==', 'agent-browser eval -b "ZG9jdW1lbnQudGl0bGU="', 'agent-browser eval -b ZG9j']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
  }
});

test('R4c S2: sichtbares Fenster (--headed, --no-headless, --headless=false) ist gesperrt', () => {
  for (const c of ['agent-browser --headed open x', 'agent-browser open x --headed', 'agent-browser --headed=true open x', 'playwright-cli open --headed', 'playwright-cli open x --headed',
    'agent-browser --no-headless open x', 'playwright-cli open --headless=false', 'agent-browser --head open x', 'AGENT_BROWSER_HEADED=1 agent-browser open x']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  // Gegenprobe: --headers ist eine gewoehnliche Option
  assert.equal(commandAllowedAny('agent-browser open x --headers \'{"a":"b"}\'', H3, '/tmp'), true);
});

test('R4c S3: agent-browser --namespace ist gesperrt; --session, --name und playwright-cli -s bleiben erlaubt', () => {
  for (const c of ['agent-browser --namespace x open y', 'agent-browser --namespace=x open y', 'agent-browser open y --namespace x']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  for (const c of ['agent-browser --session s1 open y', 'agent-browser find role button click --name "Submit"', 'playwright-cli -s=auth open https://x.test', 'playwright-cli -s=auth close']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
  }
});

test('R4c batch: verschachtelte Befehle von agent-browser batch werden wie eigene Befehle geprueft', () => {
  for (const c of ['agent-browser batch \'["connect","9222"]\'', 'agent-browser batch \'["open","--cdp","9222"]\'', 'agent-browser batch "connect 9222"', 'agent-browser batch \'["open"]\' \'["--headed"]\'',
    'agent-browser batch \'["batch","[\\"connect\\",\\"9222\\"]"]\'', 'agent-browser batch \'[1]\'', 'agent-browser batch "open \\$X"', 'agent-browser --bail batch \'["plugin","list"]\'',
    'agent-browser Batch \'["connect","9222"]\'', 'agent-browser batch \'["frobnicate","connect"]\'', 'agent-browser batch \'["open --cdp 9222"]\'', 'agent-browser batch \'["--session x","open"]\'',
    'agent-browser batch "fill @e1 \'a b\'"', 'agent-browser batch \'{"cmd":"connect"}\'', 'agent-browser batch \'[]\'', 'agent-browser batch \'["mcp"]\'', 'agent-browser batch "inspect"']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
  for (const c of ['agent-browser batch \'["open"]\' \'["network","route","*","--abort","--resource-type","script"]\' \'["navigate","http://localhost:3000/target"]\'',
    'agent-browser batch --bail "open http://x.test" "snapshot -i"', 'agent-browser batch \'["fill","@e1","connect"]\'']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
  }
});

test('R4c Fairness: Argumente von Bedien-Unterbefehlen sind freier Text, Unterbefehl und Optionen bleiben gesperrt', () => {
  for (const c of ['agent-browser fill @e3 "Connect"', 'agent-browser find text "Dashboard" click', 'playwright-cli fill e5 "chat"', 'agent-browser fill @e1 config',
    'agent-browser type @e2 "install the plugin"', 'agent-browser --session s1 click "Connect"', 'agent-browser --json find label "Profile" fill "x"', 'playwright-cli -s=a type "attach"',
    'playwright-cli --raw eval "connect"', 'agent-browser select @e4 profiles', 'agent-browser press attach', 'agent-browser eval -b dGVzdA== connect', 'agent-browser eval connect']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), true, c);
  }
  // Weiter gesperrt (R4a M1/M2 und R4b): Unterbefehl/Option nach Optionen, Quotes, Escapes, Abkuerzungen, unbekannte Struktur.
  for (const c of ['agent-browser --session x --headed connect 9222', 'agent-browser --session x connect 9222', 'agent-browser --json connect 9222', 'agent-browser --foo connect 9222',
    'agent-browser --foo fill connect', 'agent-browser --restore batch fill \'["connect","9222"]\'', 'agent-browser --session connect open x', 'agent-browser --session batch fill \'["connect","9222"]\'',
    'agent-browser "--cdp" 9222 snapshot', 'agent-browser --c""dp 9222 open', 'agent-browser \\-\\-cdp 9222 open', 'playwright-cli open --b""rowser=firefox', 'agent-browser --prof /x open y',
    'agent-browser fill @e1 --cdp 9222', 'agent-browser fill @e1 x --profile y', 'playwright-cli -s attach', 'playwright-cli -s x attach', 'playwright-cli --json attach x', 'playwright-cli fill e1 x --browser=firefox',
    'agent-browser frobnicate connect', 'playwright-cli --json true attach', 'playwright-cli --raw false attach x', 'agent-browser "fill" @e1 "x" && agent-browser connect 9222', 'playwright-cli -- attach', 'agent-browser -- connect 9222', 'agent-browser con""nect 9222', 'agent-browser Connect 9222']) {
    assert.equal(commandAllowedAny(c, H3, '/tmp'), false, c);
  }
});
