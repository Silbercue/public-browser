import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_TESTS, EXCLUDED, SCORABLE, SUITE_URL, PARTICIPANTS, score, mcpOnly, mqs,
  nextRunNumber, renderPrompt, compareTable, verifyRunJson,
  mcpCallsFromJsonl, percentile, validateExport,
  runParticipant, registerParticipant, probeServerInfo, cortexPatternCount,
  localParticipant, parseRunArgs,
  scrubProviderKeys, cliCommandAllowed, cliCallsFromJsonl, byToolFromCalls, toolLockFromJsonl, browserBinaries,
  usageTotal, RESULT_PATHSPEC,
} from './blind-run.mjs';

// --- Fixture-Session (A1.1/A1.6): 2 MCP-Calls + 1 verweigerter Bash-Call ---
const A = (ts, id, name) => JSON.stringify({
  type: 'assistant', timestamp: ts, uuid: `u-${id}`,
  message: { usage: { output_tokens: 7, input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    content: [{ type: 'tool_use', id, name, input: {} }] },
});
const U = (ts, id, content) => JSON.stringify({
  type: 'user', timestamp: ts, uuid: `r-${id}`,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const FIXTURE_JSONL = [
  A('2026-09-03T20:00:00.000Z', 'tu1', 'mcp__playwright__browser_navigate'),
  U('2026-09-03T20:00:01.500Z', 'tu1', '0123456789'),
  A('2026-09-03T20:00:02.000Z', 'tu2', 'mcp__playwright__browser_click'),
  U('2026-09-03T20:00:02.250Z', 'tu2', [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]),
  A('2026-09-03T20:00:03.000Z', 'tu3', 'Bash'),
  U('2026-09-03T20:00:03.100Z', 'tu3', 'Claude requested permissions to use Bash, but you have not granted it yet.'),
].join('\n');

test('suite constants: 35 tests, 5 excluded, 30 scorable', () => {
  assert.equal(ALL_TESTS.length, 35);
  assert.deepEqual(EXCLUDED, ['T4.7', 'T5.3', 'T5.4', 'T5.5', 'T5.6']);
  assert.equal(SCORABLE.length, 30);
  assert.ok(!SCORABLE.includes('T4.7'));
});

test('score counts only scorable tests; missing = not_run; excluded passes ignored', () => {
  const tests = { 'T1.1': { status: 'pass' }, 'T1.2': { status: 'fail' }, 'T4.7': { status: 'pass' }, 'T5.3': { status: 'pass' } };
  const s = score(tests);
  assert.equal(s.total, 35); assert.equal(s.counted, 30); assert.equal(s.skipped, 5);
  assert.equal(s.passed, 1); assert.equal(s.failed, 1); assert.equal(s.not_run, 28);
  assert.equal(s.pass_rate, 3.3);
});

test('score: 30/30 gives 100', () => {
  const tests = Object.fromEntries(SCORABLE.map((id) => [id, { status: 'pass' }]));
  assert.equal(score(tests).pass_rate, 100);
});

test('mcpOnly filters by prefix and aggregates like the skill jq', () => {
  const byTool = [
    { name: 'mcp__playwright__browser_click', count: 2, total_chars: 200, p95_chars: 150, total_ms: 400, total_output_tokens: 20, total_total_tokens_est: 70 },
    { name: 'mcp__playwright__browser_snapshot', count: 1, total_chars: 6000, p95_chars: 6000, total_ms: 100, total_output_tokens: 10, total_total_tokens_est: 1510 },
    { name: 'Bash', count: 5, total_chars: 99999, p95_chars: 99999, total_ms: 9, total_output_tokens: 9, total_total_tokens_est: 9 },
  ];
  const m = mcpOnly(byTool, 'mcp__playwright__');
  assert.equal(m.by_tool.length, 2);
  assert.equal(m.calls_total, 3);
  assert.equal(m.response_chars_total, 6200);
  assert.equal(m.avg_response_chars, 2066);
  assert.equal(m.p95_response_chars, 6000);
  assert.equal(m.total_ms, 500); assert.equal(m.avg_ms, 166);
  assert.equal(m.total_output_tokens, 30); assert.equal(m.avg_output_tokens, 10);
  assert.equal(m.total_tokens_est, 1580); assert.equal(m.avg_tokens_est, 526);
});

test('mcpOnly with no matching tools is all zeros', () => {
  const m = mcpOnly([{ name: 'Bash', count: 1, total_chars: 5 }], 'mcp__x__');
  assert.equal(m.calls_total, 0); assert.equal(m.avg_response_chars, 0); assert.equal(m.p95_response_chars, 0);
});

test('mqs: baseline values score exactly 50', () => {
  const r = mqs({ chars: 175319, pass_rate: 93.5, calls: 121, duration_s: 563 });
  assert.equal(r.score, 50); assert.equal(r.token_score, 50); assert.equal(r.baseline, 'playwright-mcp-run2-2026-04-09');
});

test('mqs: sub-scores are capped at 100 and zero inputs do not divide by zero', () => {
  const r = mqs({ chars: 1, pass_rate: 100, calls: 1, duration_s: 1 });
  assert.equal(r.token_score, 100); assert.equal(r.call_score, 100); assert.equal(r.speed_score, 100);
  const z = mqs({ chars: 0, pass_rate: 0, calls: 0, duration_s: 0 });
  assert.equal(z.score, 0);
});

test('nextRunNumber: continues per slug, ignores other slugs and prefixes', () => {
  const files = ['playwright-mcp-run4.json', 'playwright-cli-run1.json', 'silbercuechrome-pro-run9.json', 'chrome-devtools-mcp-run2.json'];
  assert.equal(nextRunNumber(files, 'playwright-mcp'), 5);
  assert.equal(nextRunNumber(files, 'chrome-devtools-mcp'), 3);
  assert.equal(nextRunNumber(files, 'public-browser'), 1);
});

test('renderPrompt substitutes all placeholders and appends smoke suffix only in smoke mode', () => {
  const t = 'Testing {{MCP_NAME}}. Save to {{EXPORT_PATH}}. Open {{SUITE_URL}}. Again {{MCP_NAME}}.';
  const full = renderPrompt(t, { mcpName: 'Playwright MCP', exportPath: '/tmp/x/run-export.json', smoke: false });
  assert.equal(full, `Testing Playwright MCP. Save to /tmp/x/run-export.json. Open ${SUITE_URL}. Again Playwright MCP.`);
  assert.ok(!full.includes('{{SUITE_URL}}'));
  const smoke = renderPrompt(t, { mcpName: 'X', exportPath: '/p', smoke: true });
  assert.match(smoke, /SMOKE MODE/); assert.match(smoke, /T1\.1 and T1\.2/); assert.match(smoke, /echo probe/);
});

test('PARTICIPANTS: six slugs, pinned versions, env is a function', () => {
  assert.deepEqual(Object.keys(PARTICIPANTS),
    ['public-browser', 'playwright-mcp', 'chrome-devtools-mcp', 'browser-use', 'agent-browser', 'playwright-cli']);
  assert.equal(PARTICIPANTS['public-browser'].version, '2.10.6');
  assert.ok(PARTICIPANTS['public-browser'].args.join(' ').includes('public-browser@2.10.6'));
  assert.ok(PARTICIPANTS['playwright-mcp'].args.join(' ').includes('@playwright/mcp@0.0.82'));
  assert.equal(PARTICIPANTS['playwright-mcp'].serverVersion, '1.64.0-alpha-1789764292000');
  assert.ok(PARTICIPANTS['chrome-devtools-mcp'].args.join(' ').includes('chrome-devtools-mcp@1.9.0'));
  assert.equal(PARTICIPANTS['chrome-devtools-mcp'].version, '1.9.0');
  const rundir = mkdtempSync(join(tmpdir(), 'blind-run-env-'));
  const env = PARTICIPANTS['public-browser'].env(rundir);
  assert.equal(env.PUBLIC_BROWSER_TELEMETRY, '0'); assert.equal(env.PUBLIC_BROWSER_CHROME_PORT, '9333');
  assert.equal(env.PUBLIC_BROWSER_CORTEX_DIR, join(rundir, 'cortex'));
  assert.ok(existsSync(env.PUBLIC_BROWSER_CORTEX_DIR), 'cortex dir angelegt');
});

// A1.5
test('PARTICIPANTS: every entry documents its profile isolation', () => {
  for (const [slug, p] of Object.entries(PARTICIPANTS)) {
    assert.equal(typeof p.profile_isolation, 'string', `${slug} profile_isolation`);
    assert.ok(p.profile_isolation.length > 0, `${slug} profile_isolation empty`);
  }
  assert.match(PARTICIPANTS['playwright-mcp'].profile_isolation, /--isolated/);
  assert.match(PARTICIPANTS['browser-use'].profile_isolation, /Google Chrome, fresh empty user_data_dir/);
});

// Task 6: browser-use 0.12.5 meldete im Handshake die Wrapper-Version 0.1.0; seit 0.13 die Paketversion.
test('PARTICIPANTS: browser-use pins package 0.13.10, handshake reports the package version', () => {
  assert.equal(PARTICIPANTS['browser-use'].version, '0.13.10');
  assert.equal(PARTICIPANTS['browser-use'].serverVersion, undefined);
  assert.equal(PARTICIPANTS['playwright-mcp'].version, '0.0.82');   // Gegenprobe: gleiches Muster beim Nachbarn
});

test('PARTICIPANTS: browser-use command is overridable via env', async () => {
  // Ohne gesetzte Variable greift der Default; mit gesetzter Variable (der dokumentierte Reproduktionsweg) deren Wert.
  assert.equal(
    PARTICIPANTS['browser-use'].command,
    process.env.BLIND_RUN_BROWSER_USE_BIN || '/Users/silbercue/.browser-use-0.13.10-env/bin/browser-use',
  );
  const before = process.env.BLIND_RUN_BROWSER_USE_BIN;
  process.env.BLIND_RUN_BROWSER_USE_BIN = '/x/fake-bu';
  try {
    const fresh = await import('./blind-run.mjs?override=1');
    assert.equal(fresh.PARTICIPANTS['browser-use'].command, '/x/fake-bu');
  } finally {
    if (before === undefined) delete process.env.BLIND_RUN_BROWSER_USE_BIN;
    else process.env.BLIND_RUN_BROWSER_USE_BIN = before;
  }
});

const fakeRun = (over = {}) => ({
  name: 'Playwright MCP', slug: 'playwright-mcp', mcp_version: '0.0.80', model: 'claude-opus-5', timestamp: '2026-09-03T20:00:00Z',
  snapshot_tool: 'browser_snapshot', run_file: 'playwright-mcp-run5.json', chrome_version: '152.0.7977.65',
  summary: { total: 35, counted: 30, passed: 28, failed: 2, not_run: 0, skipped: 5, pass_rate: 93.3, duration_s: 500 },
  mqs: { score: 51.2 }, cortex: null,
  suite: { url: SUITE_URL, tests: 35, scorable: 30, test_ids: ALL_TESTS },
  harness: { mode: 'blind-print', status: 'ok' },
  tool_efficiency: { calls_total: 110, response_chars_total: 150000, avg_response_chars: 1363, p95_response_chars: 8000,
    by_tool: [{ name: 'mcp__playwright__browser_snapshot', count: 10, avg_chars: 6000, p95_chars: 8000, total_chars: 60000 }, { name: 'mcp__playwright__browser_click', count: 100, avg_chars: 900, p95_chars: 1200, total_chars: 90000 }] },
  tests: {}, ...over,
});

test('compareTable: only blind-print non-smoke runs, one row each, snapshot column from by_tool', () => {
  const md = compareTable([fakeRun(), fakeRun({ harness: { mode: 'blind-print', status: 'smoke' } }), fakeRun({ harness: undefined, name: 'April' })]);
  const rows = md.split('\n').filter((l) => l.startsWith('| Playwright'));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\| 28\/30 \|/); assert.match(rows[0], /\| 500s \|/); assert.match(rows[0], /\| 110 \|/); assert.match(rows[0], /\| 150k \|/);
  assert.match(rows[0], /6000 \(10×\)/);
  assert.match(md, /mcp__playwright__browser_click \| 100/);   // Top-Tools-Liste
});

// A1.4
test('compareTable: Run and Status columns follow Date', () => {
  const md = compareTable([fakeRun()]);
  const header = md.split('\n')[0];
  assert.match(header, /\| Date \| Run \| Status \|/);
  const row = md.split('\n').find((l) => l.startsWith('| Playwright'));
  assert.match(row, /\| 2026-09-03 \| playwright-mcp-run5 \| ok \|/);
});

test('compareTable: aborted runs appear only in the second table', () => {
  const md = compareTable([
    fakeRun(),
    fakeRun({ name: 'browser-use', run_file: 'browser-use-run6.json', harness: { mode: 'blind-print', status: 'aborted' }, notes: 'MCP crashed at T2.3' }),
  ]);
  assert.match(md, /\*\*Aborted or incomplete runs\*\*/);
  const mainRows = md.split('\n').filter((l) => l.startsWith('| Playwright') || l.startsWith('| browser-use |'));
  assert.equal(mainRows.length, 1);           // nur der ok-Lauf steht in der Haupttabelle
  assert.match(md, /\| browser-use-run6 \| browser-use \| aborted \| MCP crashed at T2\.3 \|/);
});

test('verifyRunJson: flags non-MCP tools, inconsistent totals, missing fields', () => {
  assert.deepEqual(verifyRunJson(fakeRun()), []);
  const bad = fakeRun({ tool_efficiency: { ...fakeRun().tool_efficiency, by_tool: [...fakeRun().tool_efficiency.by_tool, { name: 'Bash', count: 1 }] } });
  assert.ok(verifyRunJson(bad).some((m) => /Non-MCP/.test(m)));
  const off = fakeRun({ tool_efficiency: { ...fakeRun().tool_efficiency, calls_total: 999 } });
  assert.ok(verifyRunJson(off).some((m) => /calls_total/.test(m)));
  const pb = fakeRun({ slug: 'public-browser', cortex: null });
  assert.ok(verifyRunJson(pb).some((m) => /cortex/.test(m)));
});

test('verifyRunJson: a missing run object is reported, not thrown', () => {
  assert.deepEqual(verifyRunJson(undefined), ['run is not an object']);
  assert.deepEqual(verifyRunJson([]), ['run is not an object']);
  assert.deepEqual(verifyRunJson(fakeRun()), []);          // Gegenprobe: ein echtes Run-Objekt kommt durch
});

// A1.3
test('verifyRunJson: model must be a claude model and chrome_version must be known', () => {
  assert.ok(verifyRunJson(fakeRun({ model: 'unknown' })).some((m) => /model unknown/.test(m)));
  assert.deepEqual(verifyRunJson(fakeRun({ model: 'claude-sonnet-4-5' })), []);
  assert.ok(verifyRunJson(fakeRun({ chrome_version: null })).some((m) => /chrome_version/.test(m)));
});

test('verifyRunJson: an ok run needs calls and a consistent test count', () => {
  const noCalls = fakeRun({ tool_efficiency: { calls_total: 0, by_tool: [] } });
  assert.ok(verifyRunJson(noCalls).some((m) => /no MCP calls recorded for an ok run/.test(m)));
  const offCount = fakeRun({ summary: { ...fakeRun().summary, not_run: 3 } });
  assert.ok(verifyRunJson(offCount).some((m) => /summary/.test(m)));
});

test('verifyRunJson: public-browser needs a cortex pattern count', () => {
  const okPb = fakeRun({ slug: 'public-browser', cortex: { mode: 'kalt', patternCount: 0 } });
  assert.deepEqual(verifyRunJson(okPb), []);
  const noCount = fakeRun({ slug: 'public-browser', cortex: { mode: 'kalt' } });
  assert.ok(verifyRunJson(noCount).some((m) => /patternCount/.test(m)));
});

// A1.1
test('mcpCallsFromJsonl: only MCP calls, with chars and ms per call', () => {
  const calls = mcpCallsFromJsonl(FIXTURE_JSONL, 'mcp__playwright__');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['mcp__playwright__browser_navigate', 'mcp__playwright__browser_click']);
  assert.equal(calls[0].chars, 10);
  assert.equal(calls[0].ms, 1500);
  // chars folgt measure-tool-calls.sh (`.content | tostring | length`): der Array-Inhalt
  // zaehlt als kompaktes JSON, nicht nur die text-Teile.
  assert.equal(calls[1].chars, 58);
  assert.equal(calls[1].ms, 250);
  assert.equal(calls[0].tool_use_id, 'tu1');
});

test('mcpCallsFromJsonl: a call without result has ms null; result_text is capped', () => {
  const jsonl = [A('2026-09-03T20:00:00.000Z', 'x1', 'mcp__p__go')].join('\n');
  const [c] = mcpCallsFromJsonl(jsonl, 'mcp__p__');
  assert.equal(c.ms, null);
  assert.equal(c.chars, 0);
  const long = [A('2026-09-03T20:00:00.000Z', 'x2', 'mcp__p__go'), U('2026-09-03T20:00:01.000Z', 'x2', 'y'.repeat(500))].join('\n');
  assert.equal(mcpCallsFromJsonl(long, 'mcp__p__')[0].result_text.length, 300);
});

test('mcpCallsFromJsonl: the denied Bash call is visible under its own prefix', () => {
  const bash = mcpCallsFromJsonl(FIXTURE_JSONL, 'Bash');
  assert.equal(bash.length, 1);
  assert.match(bash[0].result_text, /have not granted/);
});

test('mcpCallsFromJsonl: broken and empty lines are skipped', () => {
  const dirty = ['{ kaputte zeile', '', FIXTURE_JSONL, '   '].join('\n');
  assert.equal(mcpCallsFromJsonl(dirty, 'mcp__playwright__').length, 2);
});

test('percentile: nearest rank', () => {
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5, 1, 3], 100), 5);
});

// A1.2
test('validateExport: a well-formed export has no problems', () => {
  assert.deepEqual(validateExport({
    timestamp: '2026-09-03T20:00:00Z', elapsed_s: 412,
    tests: { 'T1.1': { status: 'pass', duration_ms: 120 }, 'T5.10': { status: 'pending' }, 'T2.1': { status: 'fail', duration_ms: null } },
  }), []);
});

test('validateExport: rejects wrong shapes, unknown ids and bad statuses', () => {
  assert.ok(validateExport(null).length > 0);
  assert.ok(validateExport({ tests: [] }).some((m) => /tests/.test(m)));
  assert.ok(validateExport({ tests: { 'T9.9': { status: 'pass' } } }).some((m) => /T9\.9/.test(m)));
  assert.ok(validateExport({ tests: { 'T1.1': { status: 'ok' } } }).some((m) => /status/.test(m)));
  assert.ok(validateExport({ tests: { 'T1.1': { status: 'pass', duration_ms: -1 } } }).some((m) => /duration_ms/.test(m)));
  assert.ok(validateExport({ tests: {}, elapsed_s: 'x' }).some((m) => /elapsed_s/.test(m)));
  assert.ok(validateExport({ tests: {}, timestamp: 'gestern' }).some((m) => /timestamp/.test(m)));
});

// A1.6
test('measure-tool-calls.sh counts all three fixture calls, denied Bash included', () => {
  const home = mkdtempSync(join(tmpdir(), 'blind-run-home-'));
  const uuid = '11111111-2222-3333-4444-555555555555';
  const dir = join(home, '.claude', 'projects', '-fixture-slug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), FIXTURE_JSONL);
  const script = fileURLToPath(new URL('./measure-tool-calls.sh', import.meta.url));
  const out = execFileSync('bash', [script, '-fixture-slug', uuid], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  const m = JSON.parse(out);
  assert.equal(m.summary.tool_calls_total, 3);
  assert.ok(m.by_tool.some((t) => t.name === 'Bash'), 'Bash im by_tool');
  assert.equal(m.by_tool.find((t) => t.name === 'mcp__playwright__browser_navigate').total_ms, 1500);
  // Gegenprobe zur chars-Definition oben: das Skript zaehlt denselben Array-Inhalt als 58 Chars.
  assert.equal(m.by_tool.find((t) => t.name === 'mcp__playwright__browser_click').total_chars, 58);
});

// --- A2.14: Pipeline-Tests gegen Fake-Claude und Fake-MCP ---
const HERE_T = dirname(fileURLToPath(import.meta.url));
const FIXT = join(HERE_T, 'fixtures', 'blind-run');
let fakeRegistered = false;

function registerFakes() {
  if (fakeRegistered) return;
  const base = {
    display: 'Fake MCP', package: 'fake-mcp', command: process.execPath, args: [join(FIXT, 'fake-mcp.mjs')],
    env: (_rundir) => ({}), snapshotTool: 'view_page', profile_isolation: 'none (fake)',
  };
  registerParticipant('fake', { ...base, name: 'fake', version: '9.9.9' });
  registerParticipant('fake-mismatch', { ...base, name: 'fake', version: '1.0.0' });
  registerParticipant('fake-alias', { ...base, name: 'fake', version: '0.0.80', serverVersion: '9.9.9' });
  // Task 6: exakt das browser-use-Paar — Paket 0.12.5, Handshake 0.1.0.
  const bu = { ...base, env: (_rundir) => ({ FAKE_MCP_VERSION: '0.1.0' }) };
  registerParticipant('fake-bu', { ...bu, name: 'fake', version: '0.12.5', serverVersion: '0.1.0' });
  registerParticipant('fake-bu-noalias', { ...bu, name: 'fake', version: '0.12.5' });
  fakeRegistered = true;
}

function pipeEnv(mode) {
  registerFakes();
  const tmp = mkdtempSync(join(tmpdir(), 'blind-run-pipe-'));
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  const results = join(tmp, 'results');
  mkdirSync(results, { recursive: true });
  return {
    tmp,
    rundir: (n = 'run') => join(tmp, n),
    deps: {
      claude: { file: process.execPath, argsPrefix: [join(FIXT, 'fake-claude.mjs')] },
      chromeBin: process.execPath,
      measureDir: HERE_T,
      resultsDir: results,
      projectsDir: join(home, '.claude', 'projects'),
      suiteFetch: async () => ALL_TESTS.join(' '),
      envOverrides: { HOME: home, FAKE_CLAUDE_MODE: mode },
      psList: () => '',
    },
  };
}

const statusOf = (rundir) => JSON.parse(readFileSync(join(rundir, 'status.json'), 'utf8'));

test('probeServerInfo: reads serverInfo and instructions from the fake MCP server', async () => {
  registerFakes();
  const info = await probeServerInfo(PARTICIPANTS['fake'], {}, undefined, { timeoutMs: 20_000 });
  assert.equal(info.name, 'fake');
  assert.equal(info.version, '9.9.9');
  assert.match(info.instructions, /Cortex: 93 patterns loaded/);
  assert.equal(cortexPatternCount(info.instructions), 93);
  assert.equal(cortexPatternCount('no cortex line here'), null);   // Gegenprobe
});

test('the real prompt template renders without any placeholder left', () => {
  const tpl = readFileSync(join(HERE_T, 'blind-prompt.md'), 'utf8');
  const rendered = renderPrompt(tpl, { mcpName: 'Public Browser', exportPath: '/tmp/x/run-export.json', smoke: false });
  assert.ok(tpl.includes('{{'), 'Vorlage enthaelt ueberhaupt Platzhalter');   // Gegenprobe
  assert.ok(!rendered.includes('{{'), `Platzhalter uebrig: ${rendered.match(/\{\{[A-Z_]+\}\}/g)}`);
  assert.ok(rendered.includes(SUITE_URL));
});

test('pipeline: an ok run writes run1.json, counts MCP calls and proves the Bash denial', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const dir = rundir();
  const { run, outPath, problems } = await runParticipant('fake', { rundir: dir }, deps);
  assert.deepEqual(problems, []);
  assert.equal(run.harness.status, 'ok');
  assert.equal(run.summary.passed, 3);
  assert.equal(run.tool_efficiency.calls_total, 2);
  assert.ok(run.tool_efficiency.p95_response_chars > 0, 'p95_response_chars gesetzt');
  assert.equal(run.tool_efficiency.p50_response_chars, 10);
  assert.equal(run.harness.tool_lock.bash_attempted, 1);
  assert.equal(run.harness.tool_lock.bash_denied, true);
  assert.deepEqual(run.harness.tool_lock.non_mcp_executed, []);
  assert.equal(run.mcp_server_info.version, '9.9.9');
  assert.equal(run.model, 'claude-opus-5-20260514');
  assert.equal(run.harness.complete, false);
  assert.match(run.notes, /incomplete: T1\.4/);
  assert.equal(basename(outPath), 'fake-run1.json');
  assert.equal(run.run_file, 'fake-run1.json');
  assert.equal(JSON.parse(readFileSync(outPath, 'utf8')).session_id, run.session_id);
  assert.equal(statusOf(dir).phase, 'ok');
});

test('pipeline: a missing export aborts but still leaves a run JSON and a terminal status', async () => {
  const { deps, rundir } = pipeEnv('noexport');
  const dir = rundir();
  const { run, outPath } = await runParticipant('fake', { rundir: dir }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /no export written/);
  assert.ok(existsSync(outPath), 'Run-JSON existiert');
  assert.equal(statusOf(dir).phase, 'aborted');
});

test('pipeline: an invalid export aborts with the validateExport reason in notes', async () => {
  const { deps, rundir } = pipeEnv('badexport');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /tests is not an object/);
});

test('pipeline: the wall-clock limit aborts the run and kills the process group', async () => {
  const { deps, rundir } = pipeEnv('hang');
  const dir = rundir();
  const { run, childPid } = await runParticipant('fake', { rundir: dir, timeoutMs: 2000 }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.equal(run.harness.timed_out, true);
  assert.match(run.notes, /aborted: wall-clock limit/);
  // Der Kill muss wirklich greifen: das Fake-Claude wuerde sonst 60 s weiterlaufen.
  assert.ok(run.harness.wall_clock_s <= 6, `wall_clock_s ${run.harness.wall_clock_s}`);
  assert.ok(childPid > 0);
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  assert.equal(statusOf(dir).phase, 'aborted');
});

test('pipeline: a second run gets run2.json and does not overwrite run1', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const first = await runParticipant('fake', { rundir: rundir('a') }, deps);
  const second = await runParticipant('fake', { rundir: rundir('b') }, deps);
  assert.equal(basename(first.outPath), 'fake-run1.json');
  assert.equal(basename(second.outPath), 'fake-run2.json');
  assert.notEqual(JSON.parse(readFileSync(first.outPath, 'utf8')).session_id,
    JSON.parse(readFileSync(second.outPath, 'utf8')).session_id);
  assert.equal(JSON.parse(readFileSync(first.outPath, 'utf8')).run_file, 'fake-run1.json');
});

test('pipeline: a server version other than the pinned one aborts before the model starts', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const dir = rundir();
  const { run } = await runParticipant('fake-mismatch', { rundir: dir }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /version mismatch/);
  assert.equal(existsSync(join(dir, 'result.json')), false, 'Claude wurde nicht gestartet');
  assert.equal(statusOf(dir).phase, 'aborted');
});

test('pipeline: serverVersion overrides the package version in the handshake check', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const { run } = await runParticipant('fake-alias', { rundir: rundir() }, deps);
  assert.equal(run.harness.status, 'ok');          // Gegenprobe zum Versions-Mismatch-Test darueber
  assert.equal(run.mcp_version, '0.0.80');         // Paketversion bleibt im Run-JSON
  assert.equal(run.mcp_server_info.version, '9.9.9');
});

test('pipeline: the browser-use pair 0.12.5/0.1.0 passes the handshake check', async () => {
  const a = pipeEnv('ok');
  const ok = await runParticipant('fake-bu', { rundir: a.rundir() }, a.deps);
  assert.equal(ok.run.harness.status, 'ok');
  assert.equal(ok.run.mcp_version, '0.12.5');
  assert.equal(ok.run.mcp_server_info.version, '0.1.0');
  const b = pipeEnv('ok');                                  // Gegenprobe: ohne serverVersion bricht derselbe Server ab
  const bad = await runParticipant('fake-bu-noalias', { rundir: b.rundir() }, b.deps);
  assert.equal(bad.run.harness.status, 'aborted');
  assert.match(bad.run.notes, /reports 0\.1\.0, pinned 0\.12\.5/);
});

test('pipeline: a changed suite page aborts an official run and only warns in a smoke', async () => {
  const short = ALL_TESTS.filter((id) => id !== 'T3.4').join(' ');
  const a = pipeEnv('ok');
  a.deps.suiteFetch = async () => short;
  const official = await runParticipant('fake', { rundir: a.rundir() }, a.deps);
  assert.equal(official.run.harness.status, 'aborted');
  assert.match(official.run.notes, /suite fingerprint mismatch: 34 ids/);
  const b = pipeEnv('ok');
  b.deps.suiteFetch = async () => short;
  const smoke = await runParticipant('fake', { smoke: true, rundir: b.rundir() }, b.deps);
  assert.equal(smoke.run.harness.status, 'smoke');       // Gegenprobe: im Smoke nur eine Notiz
  assert.match(smoke.run.notes, /suite fingerprint not verified/);
  assert.equal(smoke.run.suite.fingerprint_ok, false);
  assert.equal(smoke.run.run_file, 'run.json');          // Smoke-JSON traegt dasselbe Feld wie der offizielle Lauf
});

test('pipeline: the model pin holds on the fallback path (--model opus) too', async () => {
  const { deps, rundir } = pipeEnv('badmodel');
  // Auf dem Fallback-Pfad wird "opus" angefordert; die JSONL muss trotzdem claude-opus-5 melden.
  const { run } = await runParticipant('fake', { rundir: rundir(), model: 'opus' }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /model mismatch: claude-sonnet-4-5/);
});

test('pipeline: a session JSONL without a model aborts with a note', async () => {
  const { deps, rundir } = pipeEnv('nomodel');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.equal(run.model, 'unknown');
  assert.match(run.notes, /model not found in session JSONL/);
});

test('pipeline: an executed non-MCP call breaks fairness and aborts the run', async () => {
  const { deps, rundir } = pipeEnv('bashexec');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.deepEqual(run.harness.tool_lock.non_mcp_executed, ['Bash']);
  assert.equal(run.harness.tool_lock.bash_denied, false);
  assert.match(run.notes, /fairness violated/);
});

test('pipeline: a non-empty rundir is refused', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const dir = rundir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'leftover.txt'), 'x');
  await assert.rejects(() => runParticipant('fake', { rundir: dir }, deps), /not empty/);
});

// --- Abnahme-Fix-Runde 1 (Codex #1, #3, #4, #5, #10, #14) ---

test('verifyRunJson: suite.test_ids must be present and as long as suite.tests', () => {
  assert.deepEqual(verifyRunJson(fakeRun()), []);                       // Gegenprobe: fakeRun traegt die IDs
  const missing = fakeRun({ suite: { ...fakeRun().suite, test_ids: undefined } });
  assert.ok(verifyRunJson(missing).some((m) => /test_ids/.test(m)), 'fehlende test_ids gemeldet');
  const short = fakeRun({ suite: { ...fakeRun().suite, test_ids: ALL_TESTS.slice(0, 34) } });
  assert.ok(verifyRunJson(short).some((m) => /test_ids/.test(m)), 'zu kurze test_ids gemeldet');
});

test('verifyRunJson: chrome_version may be null only for browser-use', () => {
  assert.ok(verifyRunJson(fakeRun({ chrome_version: null })).some((m) => /chrome_version/.test(m)));
  assert.deepEqual(verifyRunJson(fakeRun({ slug: 'browser-use', chrome_version: null })), []);
  assert.deepEqual(verifyRunJson(fakeRun({ chrome_version: '152.0.7977.65' })), []);   // Gegenprobe
});

test('validateExport: an export without timestamp is rejected', () => {
  assert.deepEqual(validateExport({ timestamp: '2026-09-03T20:00:00Z', elapsed_s: 1, tests: {} }), []);
  assert.ok(validateExport({ elapsed_s: 1, tests: {} }).some((m) => /timestamp/.test(m)), 'fehlender Zeitstempel gemeldet');
});

test('pipeline: an export without timestamp aborts the run', async () => {
  const { deps, rundir } = pipeEnv('notimestamp');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /timestamp/);
});

test('pipeline: the run JSON carries the suite test-id manifest', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const { run, outPath } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.deepEqual(run.suite.test_ids, ALL_TESTS);
  assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')).suite.test_ids, ALL_TESTS);
});

test('pipeline: the per-call ledger matches the aggregates and names the source JSONL', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  const ledger = run.harness.calls_ledger;
  assert.equal(ledger.length, run.tool_efficiency.calls_total);
  assert.equal(ledger.reduce((a, c) => a + c.chars, 0), run.tool_efficiency.response_chars_total);
  assert.deepEqual(ledger.map((c) => c.i), [1, 2]);
  assert.deepEqual(ledger.map((c) => c.tool), ['mcp__fake__view_page', 'mcp__fake__click']);
  assert.ok(ledger[0].ms >= 1500 && ledger[0].ms <= 1510, `ms ${ledger[0].ms}`);
  assert.equal(ledger[0].chars, 10);
  assert.equal('result_text' in ledger[0], false, 'keine Ergebnisinhalte im Ledger');
  assert.match(run.harness.session_jsonl_sha256, /^[0-9a-f]{64}$/);
});

test('pipeline: no child_pid is published and the session id appears only once', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const { run, outPath } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal('child_pid' in run.harness, false);
  assert.match(run.harness.flags, /--session-id <session_id>/);
  const raw = readFileSync(outPath, 'utf8');
  assert.equal(raw.split(run.session_id).length - 1, 1, 'Session-ID genau einmal im JSON');
});

test('pipeline: a failure after the guarded section still leaves a terminal status and an abort JSON', async () => {
  const { deps, rundir, tmp } = pipeEnv('ok');
  writeFileSync(join(tmp, 'blocker'), 'x');
  deps.resultsDir = join(tmp, 'blocker', 'results');       // mkdirSync scheitert mit ENOTDIR
  const dir = rundir();
  await assert.rejects(() => runParticipant('fake', { rundir: dir }, deps));
  assert.equal(statusOf(dir).phase, 'aborted');
  assert.ok(existsSync(join(dir, 'run-aborted.json')), 'Abbruch-JSON geschrieben');
});

test('pipeline: an existing result file name is never overwritten', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const taken = join(deps.resultsDir, 'fake-run1.json');
  writeFileSync(taken, 'DO NOT OVERWRITE');
  const { outPath, run } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal(basename(outPath), 'fake-run2.json');
  assert.equal(readFileSync(taken, 'utf8'), 'DO NOT OVERWRITE');
  assert.equal(run.run_file, 'fake-run2.json');
});

// --- Task 1: lokaler Build statt npm-Pin ---

test('localParticipant zeigt auf build/index.js und die package.json-Version', () => {
  const root = join(HERE_T, '..');
  const p = localParticipant(root);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(p.name, 'public-browser');
  assert.equal(p.command, process.execPath);
  assert.deepEqual(p.args, [join(root, 'build', 'index.js')]);
  assert.equal(p.version, pkg.version);
  assert.equal(p.local, true);
  assert.equal(p.snapshotTool, PARTICIPANTS['public-browser'].snapshotTool);
  assert.equal(typeof p.env, 'function');
  assert.match(p.profile_isolation, /local build/);
});

test('localParticipant liest den git-Kopf und den Dirty-Zustand des Repos', () => {
  const root = join(HERE_T, '..');
  const p = localParticipant(root);
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', ...RESULT_PATHSPEC], { cwd: root, encoding: 'utf8' }).trim() !== '';
  assert.equal(p.git_head, head);
  assert.equal(p.git_dirty, dirty);
});

test('localParticipant wirft, wenn build/index.js fehlt', () => {
  assert.throws(() => localParticipant('/nonexistent-root'), /build\/index\.js/);
});

test('parseRunArgs erkennt --local fuer public-browser', () => {
  assert.equal(parseRunArgs(['public-browser', '--local']).local, true);
  assert.equal(parseRunArgs(['public-browser', '--local']).slug, 'public-browser');
});

test('parseRunArgs meldet local=false ohne das Flag', () => {
  assert.equal(parseRunArgs(['public-browser']).local, false);
});

test('parseRunArgs wirft, wenn --local fuer einen anderen Teilnehmer kommt', () => {
  assert.throws(() => parseRunArgs(['playwright-mcp', '--local']), /--local gilt nur fuer public-browser/);
});

test('parseRunArgs liest die uebrigen Optionen weiter', () => {
  const a = parseRunArgs(['fake', '--smoke', '--rundir', '/tmp/x', '--allowed-tools-form', 'glob', '--model', 'opus', '--timeout-min', '3']);
  assert.equal(a.slug, 'fake');
  assert.equal(a.smoke, true);
  assert.equal(a.rundir, '/tmp/x');
  assert.equal(a.allowedToolsForm, 'glob');
  assert.equal(a.model, 'opus');
  assert.equal(a.timeoutMs, 180_000);
});

test('pipeline: ein lokaler Teilnehmer schreibt Herkunft ins Run-JSON', async () => {
  const { deps } = pipeEnv('ok');
  registerParticipant('fake-local', { ...PARTICIPANTS['fake'], local: true, git_head: 'abc1234', git_dirty: false });
  const { run, outPath } = await runParticipant('fake-local', {}, deps);
  assert.equal(run.harness.local_build, true);
  assert.equal(run.harness.git_head, 'abc1234');
  assert.equal(run.harness.git_dirty, false);
  assert.equal(dirname(outPath), deps.resultsDir);
  assert.equal(basename(outPath), 'fake-local-run1.json');
  const written = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(written.harness.local_build, true);
  assert.equal(written.harness.git_head, 'abc1234');
  assert.equal(written.harness.git_dirty, false);
});

test('pipeline: ein normaler Teilnehmer meldet keinen lokalen Build', async () => {
  const { deps } = pipeEnv('ok');
  const { run } = await runParticipant('fake', {}, deps);
  assert.equal(run.harness.local_build, false);
  assert.equal(run.harness.git_head, null);
  assert.equal(run.harness.git_dirty, null);
});

test('parseRunArgs kennt --headless', () => {
  assert.equal(parseRunArgs(['public-browser', '--headless']).headless, true);
  assert.equal(parseRunArgs(['public-browser']).headless, false);
  assert.equal(parseRunArgs(['public-browser', '--local', '--headless']).local, true);
});

test('PARTICIPANTS: nur Public Browser hat einen headless-Schalter', () => {
  assert.deepEqual(PARTICIPANTS['public-browser'].headlessEnv, { SILBERCUE_CHROME_HEADLESS: '1' });
  for (const slug of ['playwright-mcp', 'chrome-devtools-mcp', 'browser-use']) {
    assert.equal(PARTICIPANTS[slug].headlessEnv, undefined, slug);
  }
  assert.deepEqual(localParticipant(join(HERE_T, '..')).headlessEnv, { SILBERCUE_CHROME_HEADLESS: '1' });
});

test('pipeline: --headless setzt die Server-Env und haelt es im Run-JSON fest', async () => {
  const { deps, rundir } = pipeEnv('ok');
  registerParticipant('fake-headless', {
    ...PARTICIPANTS['fake'], headlessEnv: PARTICIPANTS['public-browser'].headlessEnv,
  });
  const dir = rundir('headless');
  const { run } = await runParticipant('fake-headless', { rundir: dir, headless: true }, deps);
  assert.equal(run.harness.headless, true);
  assert.equal(run.harness.headless_requested, true);
  const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['fake'].env.SILBERCUE_CHROME_HEADLESS, '1');
  assert.ok(!run.notes.includes('--headless ignored'), JSON.stringify(run.notes));
});

test('pipeline: ohne --headless bleibt die Server-Env unberuehrt', async () => {
  const { deps, rundir } = pipeEnv('ok');
  registerParticipant('fake-headless2', {
    ...PARTICIPANTS['fake'], headlessEnv: PARTICIPANTS['public-browser'].headlessEnv,
  });
  const dir = rundir('headed');
  const { run } = await runParticipant('fake-headless2', { rundir: dir }, deps);
  assert.equal(run.harness.headless, false);
  assert.equal(run.harness.headless_requested, false);
  const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['fake'].env.SILBERCUE_CHROME_HEADLESS, undefined);
});

test('pipeline: ein Teilnehmer ohne headless-Schalter ignoriert --headless mit Notiz', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const dir = rundir('ignored');
  const { run } = await runParticipant('fake', { rundir: dir, headless: true }, deps);
  assert.equal(run.harness.headless, false);            // ignoriert = es lief headed
  assert.equal(run.harness.headless_requested, true);   // der Wunsch bleibt sichtbar
  const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers['fake'].env.SILBERCUE_CHROME_HEADLESS, undefined);
  assert.ok(run.notes.includes('--headless ignored: participant has no headless switch'),
    JSON.stringify(run.notes));
});

// --- CLI-Teilnehmer (agent-browser, Playwright CLI): Bash nur fuer genau einen Befehl ---

test('cliCommandAllowed: nur Befehle, deren jedes Segment der CLI-Befehl ist', () => {
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
  for (const c of ok) assert.equal(cliCommandAllowed(c, 'agent-browser'), true, `sollte erlaubt sein: ${c}`);
  for (const c of bad) assert.equal(cliCommandAllowed(c, 'agent-browser'), false, `sollte gesperrt sein: ${c}`);
  assert.equal(cliCommandAllowed('playwright-cli click e3', 'playwright-cli'), true);
  assert.equal(cliCommandAllowed('playwright-cli click e3', 'agent-browser'), false);
});

const B = (ts, id, command) => JSON.stringify({
  type: 'assistant', timestamp: ts, uuid: `u-${id}`,
  message: { model: 'claude-opus-5', usage: { output_tokens: 11, input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const CLI_JSONL = [
  B('2026-09-23T10:00:00.000Z', 'c1', 'fakecli open https://x.test'),
  U('2026-09-23T10:00:02.000Z', 'c1', 'opened'),
  B('2026-09-23T10:00:03.000Z', 'c2', 'fakecli --session s1 snapshot'),
  U('2026-09-23T10:00:03.500Z', 'c2', 'x'.repeat(40)),
  B('2026-09-23T10:00:04.000Z', 'c3', 'fakecli click @e1 && fakecli snapshot'),
  U('2026-09-23T10:00:04.100Z', 'c3', 'ok'),
  B('2026-09-23T10:00:05.000Z', 'c4', 'echo probe'),
  U('2026-09-23T10:00:05.050Z', 'c4', 'blocked by benchmark harness: only fakecli commands are allowed'),
  B('2026-09-23T10:00:06.000Z', 'c5', 'fakecli snapshot | head -3'),
  U('2026-09-23T10:00:06.050Z', 'c5', 'blocked by benchmark harness: only fakecli commands are allowed'),
  A('2026-09-23T10:00:07.000Z', 'c6', 'Write'),
  U('2026-09-23T10:00:07.100Z', 'c6', 'File created'),
].join('\n');

test('cliCallsFromJsonl: zaehlt nur erlaubte CLI-Aufrufe, benannt nach Unterbefehl', () => {
  const calls = cliCallsFromJsonl(CLI_JSONL, 'fakecli');
  assert.deepEqual(calls.map((c) => c.name), ['cli__fakecli__open', 'cli__fakecli__snapshot', 'cli__fakecli__batch']);
  assert.equal(calls[0].ms, 2000);
  assert.equal(calls[1].chars, 40);
  assert.equal(calls[1].ms, 500);
  assert.equal(calls[2].output_tokens, 11);
  assert.equal(cliCallsFromJsonl(CLI_JSONL, 'othercli').length, 0);   // Gegenprobe: anderer Befehl
});

test('byToolFromCalls: gruppiert wie measure-tool-calls.sh', () => {
  const rows = byToolFromCalls([
    { name: 'cli__x__snapshot', chars: 100, ms: 10, output_tokens: 4 },
    { name: 'cli__x__snapshot', chars: 300, ms: 30, output_tokens: 8 },
    { name: 'cli__x__open', chars: 7, ms: null, output_tokens: 2 },
  ]);
  assert.deepEqual(rows.map((r) => [r.name, r.count]), [['cli__x__snapshot', 2], ['cli__x__open', 1]]);
  const s = rows[0];
  assert.equal(s.total_chars, 400); assert.equal(s.avg_chars, 200); assert.equal(s.p95_chars, 100);
  assert.equal(s.total_ms, 40); assert.equal(s.avg_ms, 20); assert.equal(s.max_ms, 30);
  assert.equal(s.total_output_tokens, 12); assert.equal(s.avg_output_tokens, 6);
  assert.equal(s.total_total_tokens_est, 12 + 100);
  assert.equal(rows[1].total_ms, 0);
  const agg = mcpOnly(rows, 'cli__x__');
  assert.equal(agg.calls_total, 3); assert.equal(agg.response_chars_total, 407);
});

test('toolLockFromJsonl mit CLI: gesperrte Fremdbefehle zaehlen als Versuch, nicht als Ausfuehrung', () => {
  const lock = toolLockFromJsonl(CLI_JSONL, 'cli__fakecli__', 'fakecli');
  assert.equal(lock.bash_attempted, 2);
  assert.equal(lock.bash_denied, true);
  assert.deepEqual(lock.non_mcp_executed, []);
  const leaked = CLI_JSONL.replace('"blocked by benchmark harness: only fakecli commands are allowed"}]}}', '"probe"}]}}');
  assert.deepEqual(toolLockFromJsonl(leaked, 'cli__fakecli__', 'fakecli').non_mcp_executed, ['Bash']);
});

// Claude Code 2.1.281 weist ein per --tools gesperrtes Werkzeug so ab (gekuerzt aus dem Transkript
// von agent-browser run5, Session 938f367b-…, 23.09.2026 21:56; run9 identisch).
const NO_SUCH_TOOL_READ = '<tool_use_error>Error: No such tool available: Read. Read is disabled for this session, in subagents as well as here.</tool_use_error>';
const R = (ts, id, content, isError) => JSON.stringify({
  type: 'user', timestamp: ts, uuid: `r-${id}`,
  message: { role: 'user', content: [{ type: 'tool_result', content, ...(isError === undefined ? {} : { is_error: isError }), tool_use_id: id }] },
});
const readLockJsonl = (content, isError) => [
  B('2026-09-23T21:56:30.000Z', 'k1', 'fakecli snapshot'),
  U('2026-09-23T21:56:31.000Z', 'k1', 'snapshot'),
  A('2026-09-23T21:56:32.000Z', 'k2', 'Read'),
  R('2026-09-23T21:56:32.840Z', 'k2', content, isError),
].join('\n');
const readLock = (content, isError) => toolLockFromJsonl(readLockJsonl(content, isError), 'cli__fakecli__', 'fakecli');

test('toolLockFromJsonl: Ablehnung „No such tool available … disabled“ (Claude Code 2.1.281) zaehlt nicht als Ausfuehrung', () => {
  const lock = readLock(NO_SUCH_TOOL_READ, true);
  assert.equal(lock.bash_attempted, 1);
  assert.deepEqual(lock.non_mcp_executed, []);
  assert.equal(lock.bash_denied, true);
});

test('toolLockFromJsonl: ausgefuehrtes gesperrtes Read bleibt ein Verstoss (Gegenprobe)', () => {
  assert.deepEqual(readLock('     1\tsnapshot line', undefined).non_mcp_executed, ['Read']);
});

test('toolLockFromJsonl: gesperrtes Read mit eigenem Fehler zaehlt als ausgefuehrt', () => {
  assert.deepEqual(readLock('<tool_use_error>File does not exist.</tool_use_error>', true).non_mcp_executed, ['Read']);
});

test('toolLockFromJsonl: Ablehnungs-Wortlaut ohne is_error zaehlt als ausgefuehrt', () => {
  assert.deepEqual(readLock(NO_SUCH_TOOL_READ, undefined).non_mcp_executed, ['Read']);
});

test('toolLockFromJsonl: Ablehnungs-Wortlaut fuer ein anderes Werkzeug zaehlt als ausgefuehrt', () => {
  assert.deepEqual(readLock(NO_SUCH_TOOL_READ.replaceAll('Read', 'Grep'), true).non_mcp_executed, ['Read']);
});

test('toolLockFromJsonl: Ablehnungs-Wortlaut mitten im Ergebnistext zaehlt als ausgefuehrt', () => {
  assert.deepEqual(readLock(`<tool_use_error>line 1: ${NO_SUCH_TOOL_READ}</tool_use_error>`, true).non_mcp_executed, ['Read']);
});

test('verifyRunJson: cli__-Zeilen sind erlaubt, nackte Bash-Zeilen nicht', () => {
  const mk = (name) => ({
    slug: 'agent-browser', mcp_version: '1', model: 'claude-opus-5', chrome_version: '1', harness: { mode: 'blind-print' },
    summary: { counted: 30 }, mqs: { score: 1 }, suite: { tests: 1, test_ids: ['T1.1'] },
    tool_efficiency: { calls_total: 1, by_tool: [{ name, count: 1 }] },
  });
  assert.deepEqual(verifyRunJson(mk('cli__agent-browser__open')), []);
  assert.ok(verifyRunJson(mk('Bash')).some((m) => /Non-MCP/.test(m)));
});

test('browserBinaries: meldet neue Browser-Prozesse und markiert alles ausser echtem Chrome', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const ps = [
    `  100 ${chrome} --user-data-dir=/Users/x/old`,
    `  200 ${chrome} --remote-debugging-port=0 --user-data-dir=/var/folders/tmp`,
    `  201 ${chrome.replace('Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper')} --type=renderer`,
    '  300 /Users/x/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium --headless',
    '  400 /usr/bin/vim notes-about-chrome.txt',
  ].join('\n');
  const r = browserBinaries(ps, [100], chrome);
  assert.deepEqual(r.binaries.sort(), [chrome, '/Users/x/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium'].sort());
  assert.deepEqual(r.non_chrome, ['/Users/x/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium']);
  assert.deepEqual(r.pids.sort(), [200, 300]);
  const clean = browserBinaries(ps.split('\n').slice(0, 2).join('\n'), [100], chrome);
  assert.deepEqual(clean.non_chrome, []);                 // Gegenprobe: nur echtes Chrome
  assert.deepEqual(clean.binaries, [chrome]);
});

test('PARTICIPANTS: CLI-Teilnehmer agent-browser und Playwright CLI sind gepinnt', () => {
  const ab = PARTICIPANTS['agent-browser'];
  assert.equal(ab.kind, 'cli'); assert.equal(ab.cli, 'agent-browser'); assert.equal(ab.version, '0.38.1');
  assert.equal(ab.snapshotTool, 'snapshot');
  const env = ab.env('/tmp/bench-agent-browser-x', { chromeBin: '/C/chrome' });
  assert.equal(env.AGENT_BROWSER_EXECUTABLE_PATH, '/C/chrome');
  assert.equal(env.AGENT_BROWSER_HEADED, '1');
  assert.equal(env.AGENT_BROWSER_SESSION, 'bench-agent-browser-x');
  const pw = PARTICIPANTS['playwright-cli'];
  assert.equal(pw.kind, 'cli'); assert.equal(pw.cli, 'playwright-cli'); assert.equal(pw.version, '0.1.21');
  const dir = mkdtempSync(join(tmpdir(), 'blind-run-pwcli-'));
  pw.setup(dir);
  const cfg = JSON.parse(readFileSync(join(dir, '.playwright', 'cli.config.json'), 'utf8'));
  assert.equal(cfg.browser.launchOptions.channel, 'chrome');
  assert.equal(cfg.browser.launchOptions.headless, false);
  assert.equal(cfg.browser.isolated, true);
  assert.equal(PARTICIPANTS['playwright-mcp'].kind, undefined);   // Gegenprobe: MCP-Teilnehmer bleiben MCP
});

test('der CLI-Prompt rendert ohne Platzhalter und nennt den Befehl', () => {
  const tpl = readFileSync(join(HERE_T, 'blind-prompt-cli.md'), 'utf8');
  const rendered = renderPrompt(tpl, { mcpName: 'agent-browser', cliCommand: 'agent-browser', exportPath: '/tmp/x/e.json', smoke: false });
  assert.ok(tpl.includes('{{CLI_COMMAND}}'));
  assert.ok(!rendered.includes('{{'), `Platzhalter uebrig: ${rendered.match(/\{\{[A-Z_]+\}\}/g)}`);
  assert.match(rendered, /`agent-browser`/);
  // Gleiche Testliste und gleiches Finish wie der MCP-Prompt
  const mcpTpl = readFileSync(join(HERE_T, 'blind-prompt.md'), 'utf8');
  const tail = (t) => t.slice(t.indexOf('- Work through the tests'), t.indexOf('- For every test'));
  assert.equal(tail(tpl), tail(mcpTpl));
  assert.equal(tpl.slice(tpl.indexOf('Finish')), mcpTpl.slice(mcpTpl.indexOf('Finish')));
});

function registerCliFake() {
  registerFakes();
  const bin = join(FIXT, 'bin');
  const base = {
    kind: 'cli', name: 'fakecli', cli: 'fakecli', display: 'Fake CLI', package: 'fakecli', binDir: bin,
    skillPath: join(FIXT, 'fake-skill.md'), env: (_rundir) => ({ FAKECLI_X: '1' }),
    snapshotTool: 'snapshot', profile_isolation: 'none (fake cli)', cleanupArgs: ['close'],
  };
  registerParticipant('fakecli', { ...base, version: '3.2.1' });
  registerParticipant('fakecli-mismatch', { ...base, version: '3.2.0' });
}

test('pipeline: ein CLI-Lauf zaehlt die CLI-Aufrufe, sperrt Fremdbefehle und reicht den Skill durch', async () => {
  registerCliFake();
  const { deps, rundir } = pipeEnv('cli');
  const dir = rundir('cli');
  const { run, problems } = await runParticipant('fakecli', { rundir: dir }, deps);
  assert.deepEqual(problems, []);
  assert.equal(run.harness.status, 'ok', run.notes);
  assert.equal(run.harness.kind, 'cli');
  assert.equal(run.tool_efficiency.calls_total, 3);
  assert.deepEqual(run.tool_efficiency.by_tool.map((t) => t.name).sort(),
    ['cli__fakecli__batch', 'cli__fakecli__open', 'cli__fakecli__snapshot']);
  assert.equal(run.harness.calls_ledger.length, 3);
  assert.equal(run.harness.tool_lock.bash_attempted, 2);
  assert.deepEqual(run.harness.tool_lock.non_mcp_executed, []);
  assert.deepEqual(run.tool_efficiency.non_mcp_calls, [{ name: 'Bash', count: 2 }]);
  assert.equal(run.mcp_server_info.version, '3.2.1');
  assert.equal(run.mcp_server_info.skill_chars, readFileSync(join(FIXT, 'fake-skill.md'), 'utf8').length);
  assert.match(run.harness.flags, /--tools Bash,Write/);
  assert.match(run.harness.flags, /--allowedTools Bash\(fakecli:\*\) Write/);
  assert.match(run.harness.flags, /--append-system-prompt-file/);
  assert.match(run.harness.flags, /cli-guard\.mjs/);
  const prompt = readFileSync(join(dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /`fakecli`/);
  assert.equal(readFileSync(join(dir, 'skill.md'), 'utf8'), readFileSync(join(FIXT, 'fake-skill.md'), 'utf8'));
  // Die Fake-Claude-Session sieht PATH mit dem CLI-Verzeichnis vorn und die Teilnehmer-Env
  const seen = JSON.parse(readFileSync(join(dir, 'fake-claude-env.json'), 'utf8'));
  assert.equal(seen.PATH.split(':')[0], join(FIXT, 'bin'));
  assert.equal(seen.FAKECLI_X, '1');
  // Aufraeumen: der Harness ruft `fakecli close` im Rundir
  assert.ok(existsSync(join(dir, 'fakecli-closed')), 'cleanup lief');
});

test('pipeline: eine abweichende CLI-Version bricht den Lauf ab', async () => {
  registerCliFake();
  const { deps, rundir } = pipeEnv('cli');
  const { run } = await runParticipant('fakecli-mismatch', { rundir: rundir('clim') }, deps);
  assert.equal(run.harness.status, 'aborted');
  assert.match(run.notes, /version mismatch: fakecli reports 3\.2\.1, pinned 3\.2\.0/);
});

test('cli-guard.mjs: verweigert Fremdbefehle per Hook-JSON und laesst den CLI-Befehl durch', () => {
  const guard = join(HERE_T, 'cli-guard.mjs');
  const run = (command) => execFileSync(process.execPath, [guard, 'agent-browser'],
    { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
  const denied = JSON.parse(run('echo probe'));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /blocked/);
  assert.equal(run('agent-browser open https://x.test'), '');
});

test('pipeline: ein Chromium-Prozess waehrend des Laufs bricht ab, echtes Chrome wird nur protokolliert', async () => {
  const chromium = '/x/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
  const mk = (extra) => {
    let n = 0;
    return () => (n++ === 0 ? '  1 /bin/zsh' : `  1 /bin/zsh\n  77 ${extra} --user-data-dir=/tmp/p`);
  };
  const a = pipeEnv('ok');
  a.deps.chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  a.deps.psList = mk(chromium);
  const bad = await runParticipant('fake', { rundir: a.rundir() }, a.deps);
  assert.equal(bad.run.harness.status, 'aborted');
  assert.match(bad.run.notes, /non-Google-Chrome browser process seen: .*Chromium/);
  assert.deepEqual(bad.run.harness.browser_non_chrome, [chromium]);
  const b = pipeEnv('ok');
  b.deps.chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  b.deps.psList = mk(b.deps.chromeBin);
  const good = await runParticipant('fake', { rundir: b.rundir() }, b.deps);
  assert.equal(good.run.harness.status, 'ok', good.run.notes);
  assert.deepEqual(good.run.harness.browser_binaries, [b.deps.chromeBin]);
  assert.deepEqual(good.run.harness.browser_non_chrome, []);
});

test('scrubProviderKeys: Provider-Keys raus, alles andere bleibt', () => {
  const env = { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', GOOGLE_API_KEY: 'x', GEMINI_API_KEY: 'x',
    BROWSERBASE_PROJECT_ID: 'x', AI_GATEWAY_API_KEY: 'x', MISTRAL_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'x',
    PATH: '/bin', HOME: '/h', CLAUDE_CODE_MESSAGING_TOKEN: 'keep', PUBLIC_BROWSER_TELEMETRY: '0' };
  const out = scrubProviderKeys(env);
  assert.deepEqual(Object.keys(out).sort(), ['CLAUDE_CODE_MESSAGING_TOKEN', 'HOME', 'PATH', 'PUBLIC_BROWSER_TELEMETRY']);
  assert.equal(env.OPENAI_API_KEY, 'x');   // Eingabe unveraendert
});

test('pipeline: die Claude-Session und die Probe sehen keinen OPENAI_API_KEY', async () => {
  registerCliFake();
  const { deps, rundir } = pipeEnv('cli');
  deps.envOverrides.OPENAI_API_KEY = 'sk-should-not-leak';
  const dir = rundir('scrub');
  await runParticipant('fakecli', { rundir: dir }, deps);
  const seen = JSON.parse(readFileSync(join(dir, 'fake-claude-env.json'), 'utf8'));
  assert.equal(seen.OPENAI_API_KEY, null);
  assert.equal(seen.FAKECLI_X, '1');   // Gegenprobe: gewollte Env kommt an
});

// --- M1 (Spec aufschliessen): Token-Summe einmal pro Modellantwort (message.id), nicht pro JSONL-Zeile ---

const costUsage = (input, output, read, create) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: create,
});
// Claude Code schreibt eine Antwort mit mehreren Inhaltsbloecken als mehrere Zeilen: eigene uuid,
// gleiche message.id, identische usage. msg_1 = thinking + tool_use, msg_2 = eine Zeile.
const COST_JSONL = [
  { type: 'assistant', uuid: 'u-1a', message: { id: 'msg_1', model: 'claude-opus-5', usage: costUsage(3, 7, 100, 0),
    content: [{ type: 'thinking', thinking: '' }] } },
  { type: 'assistant', uuid: 'u-1b', message: { id: 'msg_1', model: 'claude-opus-5', usage: costUsage(3, 7, 100, 0),
    content: [{ type: 'tool_use', id: 't1', name: 'mcp__x__click', input: {} }] } },
  { type: 'user', uuid: 'r-1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'u-2', message: { id: 'msg_2', model: 'claude-opus-5', usage: costUsage(1, 5, 200, 50),
    content: [{ type: 'text', text: 'done' }] } },
  // usage ohne message.id zaehlt nicht (Formel aus Spec M1)
  { type: 'assistant', uuid: 'u-3', message: { model: 'claude-opus-5', usage: costUsage(1000, 1000, 1000, 1000), content: [] } },
].map((o) => JSON.stringify(o)).join('\n');

function measureCost(jsonl) {
  const home = mkdtempSync(join(tmpdir(), 'blind-run-cost-'));
  const uuid = '99999999-2222-3333-4444-555555555555';
  const dir = join(home, '.claude', 'projects', '-cost-slug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), jsonl);
  const script = fileURLToPath(new URL('./measure-session-cost.sh', import.meta.url));
  return JSON.parse(execFileSync('bash', [script, '-cost-slug', uuid], { env: { ...process.env, HOME: home }, encoding: 'utf8' }));
}

test('measure-session-cost.sh zaehlt eine mehrzeilige Antwort einmal (Entdopplung ueber message.id)', () => {
  const m = measureCost(COST_JSONL);
  assert.deepEqual(m.total, { input: 4, output: 12, cache_creation: 50, cache_read: 300, all: 366 });
  assert.equal(m.rounds, 2);
  assert.equal(m.dedup, 'message.id');
  assert.deepEqual(m.by_model.map((b) => b.model), ['claude-opus-5']);
});

test('usageTotal: Summe der vier usage-Felder aus Claude Codes Ergebnis-JSON, null ohne usage', () => {
  assert.equal(usageTotal({ input_tokens: 726, output_tokens: 43346, cache_creation_input_tokens: 257216, cache_read_input_tokens: 52567546 }), 52868834);
  assert.equal(usageTotal({ output_tokens: 5 }), 5);
  assert.equal(usageTotal(undefined), null);
  assert.equal(usageTotal(null), null);
});

test('pipeline: tokens kommen entdoppelt aus measure-session-cost.sh, mit Runden und Claude-Code-Gegenprobe', async () => {
  const { deps, rundir } = pipeEnv('ok');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  // fake-claude: 3 Antworten (msg-tu1 als zwei Zeilen thinking + tool_use), je usage 3 + 7 + 100 + 0
  assert.equal(run.tokens.delta, 330);
  assert.equal(run.tokens.end, 330);
  assert.equal(run.tokens.rounds, 3);
  assert.equal(run.tokens.dedup, 'message.id');
  assert.equal(run.tokens.result_usage_total, 330);
});

test('pipeline: ohne Ergebnis-JSON bleibt cost_usd_list leer statt geratener Preise', async () => {
  const { deps, rundir } = pipeEnv('noresult');
  const { run } = await runParticipant('fake', { rundir: rundir() }, deps);
  assert.equal(run.cost_usd_list, null);
  assert.match(run.notes, /cost unknown: no result usage/);
  assert.equal(run.tokens.delta, 330);                 // Token kommen weiter aus dem Transkript
  assert.equal(run.tokens.result_usage_total, null);
  const ok = pipeEnv('ok');                            // Gegenprobe: mit Ergebnis-JSON gilt Claude Codes Preis
  const { run: withResult } = await runParticipant('fake', { rundir: ok.rundir() }, ok.deps);
  assert.equal(withResult.cost_usd_list, 1.23);
  assert.doesNotMatch(withResult.notes, /cost unknown/);
});

test('compareTable: zeigt korrigierte Token und Runden, unkorrigierte als Strich', () => {
  const md = compareTable([fakeRun({ tokens: { start: 0, end: 4885869, delta: 4885869, rounds: 92, dedup: 'message.id' } })]);
  assert.match(md.split('\n')[0], /\| Duration \| Rounds \| Tokens \| MCP calls \|/);
  assert.equal(md.split('\n')[0].split('|').length, md.split('\n')[1].split('|').length);   // Trennzeile passt
  assert.match(md.split('\n').find((l) => l.startsWith('| Playwright')), /\| 500s \| 92 \| 4\.89M \| 110 \|/);
  const old = compareTable([fakeRun({ tokens: { start: 0, end: 7031415, delta: 7031415 } })]);
  assert.match(old.split('\n').find((l) => l.startsWith('| Playwright')), /\| 500s \| — \| — \| 110 \|/);
});

test('localParticipant: Ergebnis-JSONs machen die Arbeitskopie nicht dirty, Quellaenderungen schon', () => {
  const root = mkdtempSync(join(tmpdir(), 'blind-run-git-'));
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'index.js'), '// build\n');
  writeFileSync(join(root, 'package.json'), '{"version":"9.9.9"}\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  assert.equal(localParticipant(root).git_dirty, false);
  for (const d of ['results', 'results-local']) {
    mkdirSync(join(root, 'test-hardest', d), { recursive: true });
    writeFileSync(join(root, 'test-hardest', d, 'public-browser-run8.json'), '{}\n');
  }
  assert.equal(localParticipant(root).git_dirty, false);
  writeFileSync(join(root, 'src.ts'), 'export {};\n');
  assert.equal(localParticipant(root).git_dirty, true);
});
