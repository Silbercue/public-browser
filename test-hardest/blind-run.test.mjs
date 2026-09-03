import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_TESTS, EXCLUDED, SCORABLE, PARTICIPANTS, score, mcpOnly, mqs,
  nextRunNumber, renderPrompt, compareTable, verifyRunJson,
  mcpCallsFromJsonl, percentile, validateExport,
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

test('renderPrompt substitutes both placeholders and appends smoke suffix only in smoke mode', () => {
  const t = 'Testing {{MCP_NAME}}. Save to {{EXPORT_PATH}}. Again {{MCP_NAME}}.';
  const full = renderPrompt(t, { mcpName: 'Playwright MCP', exportPath: '/tmp/x/run-export.json', smoke: false });
  assert.equal(full, 'Testing Playwright MCP. Save to /tmp/x/run-export.json. Again Playwright MCP.');
  const smoke = renderPrompt(t, { mcpName: 'X', exportPath: '/p', smoke: true });
  assert.match(smoke, /SMOKE MODE/); assert.match(smoke, /T1\.1 and T1\.2/); assert.match(smoke, /echo probe/);
});

test('PARTICIPANTS: four slugs, pinned versions, env is a function', () => {
  assert.deepEqual(Object.keys(PARTICIPANTS), ['public-browser', 'playwright-mcp', 'chrome-devtools-mcp', 'browser-use']);
  assert.equal(PARTICIPANTS['public-browser'].version, '2.10.1');
  assert.ok(PARTICIPANTS['playwright-mcp'].args.join(' ').includes('@playwright/mcp@0.0.80'));
  assert.ok(PARTICIPANTS['chrome-devtools-mcp'].args.join(' ').includes('chrome-devtools-mcp@1.8.0'));
  const env = PARTICIPANTS['public-browser'].env('/tmp/bench-x');
  assert.equal(env.PUBLIC_BROWSER_TELEMETRY, '0'); assert.equal(env.PUBLIC_BROWSER_CHROME_PORT, '9333');
  assert.ok(env.PUBLIC_BROWSER_CORTEX_DIR.startsWith('/'));
});

// A1.5
test('PARTICIPANTS: every entry documents its profile isolation', () => {
  for (const [slug, p] of Object.entries(PARTICIPANTS)) {
    assert.equal(typeof p.profile_isolation, 'string', `${slug} profile_isolation`);
    assert.ok(p.profile_isolation.length > 0, `${slug} profile_isolation empty`);
  }
  assert.match(PARTICIPANTS['playwright-mcp'].profile_isolation, /--isolated/);
  assert.match(PARTICIPANTS['browser-use'].profile_isolation, /not isolated/);
});

test('PARTICIPANTS: browser-use command is overridable via env', async () => {
  assert.equal(PARTICIPANTS['browser-use'].command, '/Users/silbercue/.browser-use-env/bin/browser-use');
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
  assert.equal(calls[1].chars, 5);          // "abc" + "de" aus den text-Teilen
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
});
