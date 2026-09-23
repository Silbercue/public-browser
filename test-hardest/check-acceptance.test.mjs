import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  median, summarizeBenchmark, summarizeProbe, selectStageRuns, buildBaseline, evaluateStage, accepted, formatReport,
  runCodeChecks, parseCheckArgs, LIMITS, BASELINE_FILE, versionsOf, versionDrift, verdict, defaultPython,
  EXIT_CODES, VENV_PYTHON,
} from './check-acceptance.mjs';
import { RESULT_PATHSPEC } from './blind-run.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-acceptance.mjs');
const M = 1_000_000;
const CHROME = '153.0.8010.53';
const CC = '2.1.280';
let seq = 0;
// Benchmark-Lauf: Token in Mio., Runden, bestandene Tests; Rest wie ein echtes Run-JSON von blind-run.mjs.
const bench = (tokM, rounds, { passed = 30, status = 'ok', slug = 'public-browser', version = '2.10.6', head = null, dirty = false, calls = rounds - 2, chrome = CHROME, cc = CC } = {}) => ({
  run_file: `${slug}-run${++seq}.json`, slug, mcp_version: version, notes: status === 'ok' ? '' : 'aborted: wall-clock limit',
  chrome_version: chrome,
  harness: { mode: 'blind-print', status, local_build: head !== null, git_head: head, git_dirty: head === null ? null : dirty, claude_code_version: cc },
  summary: { passed, counted: 30 },
  tokens: { start: 0, end: tokM * M, delta: tokM * M, rounds, dedup: 'message.id' },
  tool_efficiency: { calls_total: calls },
});
const probe = (task, rounds, { pass = true, status = 'ok', head = null, version = '2.10.6', dirty = false, chrome = CHROME, cc = CC } = {}) => ({
  run_file: `real-sites-public-browser-run${++seq}.json`, slug: 'public-browser', mcp_version: version, task, notes: '',
  chrome_version: chrome,
  harness: { mode: 'real-sites-probe', status, local_build: head !== null, git_head: head, git_dirty: head === null ? null : dirty, claude_code_version: cc },
  probe: { pass, problems: pass ? [] : ['P2-DRAG: expected B,A, got A,B'] },
  tokens: { start: 0, end: rounds * 30_000, delta: rounds * 30_000, rounds, dedup: 'message.id' },
});
const probeSet = (r1, r2, r3, opts) => [probe('P1', r1, opts), probe('P1', r1, opts), probe('P2', r2, opts), probe('P2', r2, opts), probe('P3', r3, opts), probe('P3', r3, opts)];
const CODE_OK = [{ name: 'npm test', ok: true }, { name: 'lint', ok: true }, { name: 'build', ok: true }, { name: 'pytest', ok: true }];

// Baseline wie nach A3: PB 2.10.6 mit 5 Laeufen (Median 4,89 M / 92 Runden), agent-browser 5 Laeufe (Median 4,22 M)
function baselineFixture() {
  const runs = [
    bench(4.89, 92), bench(7.92, 123), bench(4.51, 90), bench(4.60, 95), bench(5.10, 99),
    bench(4.45, 103, { slug: 'agent-browser', version: '0.38.1', passed: 29 }), bench(4.22, 96, { slug: 'agent-browser', version: '0.38.1', passed: 29 }),
    bench(3.95, 94, { slug: 'agent-browser', version: '0.38.1', passed: 29 }), bench(4.30, 99, { slug: 'agent-browser', version: '0.38.1', passed: 29 }),
    bench(4.10, 97, { slug: 'agent-browser', version: '0.38.1', passed: 29 }),
    bench(4.53, 85, { version: '2.10.1', chrome: '152.0.7977.65', cc: '2.1.259' }),   // 03.09., andere Version: zaehlt nicht
    bench(1.00, 50, { head: 'lll0000' }),                                             // lokaler Build 2.10.6: zaehlt nicht
    ...probeSet(12, 20, 8),
  ];
  return buildBaseline(runs, new Date('2026-09-24T12:00:00Z'));
}
// Stufe-1-Serie am Head aaa1111: Token-Median 3,90 M, Runden-Median 88, Probe-Runden 12 / 22 / 9
const stage1Current = () => selectStageRuns([
  bench(3.70, 85, { head: 'aaa1111' }), bench(3.90, 88, { head: 'aaa1111' }), bench(4.05, 90, { head: 'aaa1111' }),
  bench(3.60, 84, { head: 'aaa1111' }), bench(4.10, 91, { head: 'aaa1111' }),
  ...probeSet(12, 22, 9, { head: 'aaa1111' }),
], 'aaa1111');

test('median: ungerade, gerade, leer, Nicht-Zahlen ignoriert', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null, 7, undefined]), 7);
  assert.equal(median([null, 1, 9, undefined, NaN]), 5);   // Nicht-Zahlen fallen vor dem Sortieren heraus
});

test('summarizeBenchmark: Mediane nur ueber ok-Laeufe, Abbrueche und 29/30 als Fehler, Maximum mit Laufname', () => {
  const runs = [bench(4.0, 90), bench(5.0, 100, { passed: 29 }), bench(3.0, 80), bench(9.0, 150, { status: 'aborted' })];
  const s = summarizeBenchmark(runs);
  assert.equal(s.n, 4);
  assert.equal(s.n_ok, 3);
  assert.equal(s.tokens.median, 4 * M);
  assert.equal(s.tokens.max, 5 * M);
  assert.equal(s.tokens.max_run, runs[1].run_file);
  assert.equal(s.rounds.median, 90);
  assert.deepEqual(s.failures.map((f) => f.reason), ['29/30', 'status aborted: aborted: wall-clock limit']);
});

test('summarizeBenchmark: unkorrigierte Token brechen hart ab', () => {
  const old = bench(7.03, 92);
  delete old.tokens.dedup;
  assert.throws(() => summarizeBenchmark([old]), /not counted by message\.id/);
});

test('summarizeProbe: je Aufgabe Zahl, bestanden, Runden-Median; nicht bestanden mit Grund', () => {
  const s = summarizeProbe([probe('P2', 20), probe('P2', 24, { pass: false }), probe('P1', 10)]);
  assert.equal(s.P2.n, 2);
  assert.equal(s.P2.passed, 1);
  assert.equal(s.P2.rounds.median, 22);
  assert.match(s.P2.failures[0].reason, /P2-DRAG/);
  assert.equal(s.P1.passed, 1);
  assert.equal(s.P3.n, 0);
  assert.equal(s.P3.rounds.median, null);
});

test('buildBaseline: PB 2.10.6 und agent-browser 0.38.1 je n = 5, andere Versionen und lokale Builds zaehlen nicht', () => {
  const { baseline, problems, warnings } = baselineFixture();
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.equal(baseline.public_browser.n, 5);
  assert.equal(baseline.public_browser.tokens.median, 4.89 * M);
  assert.equal(baseline.public_browser.rounds.median, 95);
  assert.equal(baseline.agent_browser.tokens.median, 4.22 * M);
  assert.equal(baseline.probe.P2.rounds.median, 20);
  assert.deepEqual(baseline.versions, { chrome: [CHROME], claude_code: [CC] });   // der 2.10.1-Lauf zaehlt nicht mit
  const short = buildBaseline([bench(4.89, 92), ...probeSet(12, 20, 8).slice(0, 5)]);
  assert.match(short.problems.join(), /public-browser 2\.10\.6: 1 ok runs, need 5/);
  assert.match(short.problems.join(), /agent-browser 0\.38\.1: 0 ok runs/);
  assert.match(short.problems.join(), /probe P3: 1 ok runs, need 2/);
});

test('Stufe 1: alles im Rahmen -> jedes Kriterium PASS', () => {
  const { baseline } = baselineFixture();
  const results = evaluateStage({ stage: 1, current: stage1Current(), baseline, code: CODE_OK });
  assert.deepEqual(results.map((r) => [r.id, r.pass]),
    [['benchmark', true], ['rounds', true], ['tokens_median', true], ['tokens_max', true], ['probe', true], ['code', true]]);
  assert.equal(accepted(results), true);
  assert.equal(verdict(results), 'PASS');
  assert.match(formatReport({ stage: 1, head: 'aaa1111', results }), /Urteil: PASS$/);
});

test('Stufe 1: jedes Kriterium faellt einzeln', () => {
  const { baseline } = baselineFixture();
  const verdict = (current, code = CODE_OK) => Object.fromEntries(
    evaluateStage({ stage: 1, current, baseline, code }).map((r) => [r.id, r.pass]));
  const h = { head: 'bbb2222' };
  const five = (tok, rounds, extra = {}) => [0, 1, 2, 3, 4].map((i) => bench(tok[i], rounds[i], { ...h, ...extra[i] }));
  const probes = probeSet(12, 22, 9, h);
  // Token-Median 4,23 M > agent-browser 4,22 M
  assert.equal(verdict(selectStageRuns([...five([4.23, 4.23, 4.23, 4.0, 4.0], [90, 90, 90, 90, 90]), ...probes], 'bbb2222')).tokens_median, false);
  // Einzellauf 4,95 M > 4,9 M
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.95], [90, 90, 90, 90, 90]), ...probes], 'bbb2222')).tokens_max, false);
  // Runden-Median 96 > Baseline 95
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [96, 96, 96, 90, 90]), ...probes], 'bbb2222')).rounds, false);
  // Runden-Median genau 95 = Baseline 95 -> PASS (Grenze gehoert dazu)
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [95, 95, 95, 90, 90]), ...probes], 'bbb2222')).rounds, true);
  // ein Lauf 29/30
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [90, 90, 90, 90, 90], { 2: { passed: 29 } }), ...probes], 'bbb2222')).benchmark, false);
  // nur 4 Laeufe
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [90, 90, 90, 90, 90]).slice(0, 4), ...probes], 'bbb2222')).benchmark, false);
  // Probe: P2 einmal nicht bestanden
  const p2fail = [...probeSet(12, 22, 9, h).filter((r) => r.task !== 'P2'), probe('P2', 20, h), probe('P2', 20, { ...h, pass: false })];
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [90, 90, 90, 90, 90]), ...p2fail], 'bbb2222')).probe, false);
  // Probe: P2 allein 25 > 20 x 1,2, aber Summe der Mediane 12 + 25 + 9 = 46 ≤ 40 x 1,2 = 48 -> kein FAIL (Plancheck P7)
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [90, 90, 90, 90, 90]), ...probeSet(12, 25, 9, h)], 'bbb2222')).probe, true);
  // Probe: P3 nur einmal gelaufen
  assert.equal(verdict(selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [90, 90, 90, 90, 90]), ...probeSet(12, 22, 9, h).slice(0, 5)], 'bbb2222')).probe, false);
  // Code rot bzw. nicht geprueft
  const ok = selectStageRuns([...five([3.7, 3.8, 3.9, 4.0, 4.1], [90, 90, 90, 90, 90]), ...probes], 'bbb2222');
  assert.equal(verdict(ok, [...CODE_OK.slice(0, 3), { name: 'pytest', ok: false, detail: '1 failed' }]).code, false);
  const skipped = evaluateStage({ stage: 1, current: ok, baseline, code: null });
  assert.equal(skipped.find((r) => r.id === 'code').pass, null);
  assert.equal(accepted(skipped), false);
  assert.match(formatReport({ stage: 1, head: 'bbb2222', results: skipped }), /\[OFFEN\] npm test.*nicht geprueft/);
  assert.match(formatReport({ stage: 1, head: 'bbb2222', results: skipped }), /Urteil: FAIL — nicht erfuellt: code$/);
});

test('Stufe 2: feste Grenzen 3,4 M / 4,2 M, Runden und Probe gegen Stufe 1', () => {
  const s1 = stage1Current();                                   // Runden-Median 88, Probe P2 22
  const h = { head: 'ccc3333' };
  const runs = (tok, rounds, probes) => selectStageRuns([...tok.map((t, i) => bench(t, rounds[i], h)), ...probes], 'ccc3333');
  const v = (current) => Object.fromEntries(evaluateStage({ stage: 2, current, stage1: s1, code: CODE_OK }).map((r) => [r.id, r.pass]));
  assert.deepEqual(v(runs([3.2, 3.3, 3.4, 3.1, 3.0], [85, 86, 88, 84, 83], probeSet(12, 26, 10, h))),
    { benchmark: true, rounds: true, tokens_median: true, tokens_max: true, tokens_vs_stage1: true, probe: true, code: true });
  assert.equal(v(runs([3.5, 3.5, 3.5, 3.1, 3.0], [85, 86, 88, 84, 83], probeSet(12, 22, 9, h))).tokens_median, false);
  assert.equal(v(runs([3.2, 3.3, 3.4, 3.1, 4.25], [85, 86, 88, 84, 83], probeSet(12, 22, 9, h))).tokens_max, false);
  assert.equal(v(runs([3.2, 3.3, 3.4, 3.1, 3.0], [89, 89, 89, 84, 83], probeSet(12, 22, 9, h))).rounds, false);
  // P2 allein 27 > 22 x 1,2, aber Summe 12 + 27 + 9 = 48 ≤ (12 + 22 + 9) x 1,2 = 51,6 -> kein FAIL (Plancheck P7)
  assert.equal(v(runs([3.2, 3.3, 3.4, 3.1, 3.0], [85, 86, 88, 84, 83], probeSet(12, 27, 9, h))).probe, true);
  // Summe 12 + 32 + 9 = 53 > 51,6 -> FAIL
  assert.equal(v(runs([3.2, 3.3, 3.4, 3.1, 3.0], [85, 86, 88, 84, 83], probeSet(12, 32, 9, h))).probe, false);
  assert.equal(LIMITS[2].tokensMedian, 3_400_000);
  assert.throws(() => evaluateStage({ stage: 2, current: s1, code: CODE_OK }), /stage-1 runs/);
});

test('selectStageRuns: nur lokaler Build am Head; git_dirty und Ausschluesse als Hinweis, Ausschluss nur fuer Abbrueche', () => {
  const h = { head: 'ddd4444' };
  const aborted = bench(9, 150, { ...h, status: 'aborted' });
  const dirty = bench(3, 80, { ...h, dirty: true });
  const other = bench(3, 80, { head: 'eee5555' });
  const npmRun = bench(3, 80);
  const s = selectStageRuns([bench(3.5, 85, h), aborted, dirty, other, npmRun], 'ddd4444', { [aborted.run_file]: 'Seite 5 min offline' });
  assert.equal(s.benchmark.n, 1);
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings.join(), /git_dirty=true/);
  assert.match(s.warnings.join(), /ausgeschlossen — Seite 5 min offline/);
  const okRun = bench(3.5, 85, h);
  assert.throws(() => selectStageRuns([okRun], 'ddd4444', { [okRun.run_file]: 'passt mir nicht' }), /only aborted runs/);
  assert.throws(() => selectStageRuns([okRun], 'ddd4444', { 'x-run9.json': 'gibt es nicht' }), /no run at head/);
  // git_dirty unbekannt (kein git) wird ebenfalls nicht gewertet, git_dirty false schon
  const unknown = selectStageRuns([bench(3, 80, { ...h, dirty: null }), bench(3.5, 85, h)], 'ddd4444');
  assert.equal(unknown.benchmark.n, 1);
  assert.match(unknown.warnings.join(), /git_dirty=null, nicht gewertet/);
});

test('runCodeChecks: prueft nur den gemessenen Head und meldet rote Schritte mit Grund', () => {
  const fake = (over = {}) => (cmd, args) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${over.head ?? 'fff6666'}\n` };
    if (cmd === 'git') return { status: 0, stdout: over.dirty ?? '' };
    const name = `${cmd} ${args.join(' ')}`;
    return over.fail === name ? { status: 1, stdout: 'x\nTests: 1 failed', stderr: '' } : { status: 0, stdout: '', stderr: '' };
  };
  const PY = '/venv/bin/python';
  assert.deepEqual(runCodeChecks('/r', 'fff6666', fake(), PY).map((c) => [c.name, c.ok]),
    [['npm test', true], ['lint', true], ['build', true], ['pytest', true]]);
  assert.deepEqual(runCodeChecks('/r', 'fff6666', fake({ head: 'abc0000' }), PY),
    [{ name: 'Arbeitskopie', ok: false, detail: 'HEAD ist abc0000, gemessen wurde fff6666' }]);
  assert.equal(runCodeChecks('/r', 'fff6666', fake({ dirty: ' M src/registry.ts' }), PY)[0].detail, 'ungesicherte Aenderungen');
  const red = runCodeChecks('/r', 'fff6666', fake({ fail: 'npm run lint' }), PY);
  assert.deepEqual(red.find((c) => c.name === 'lint'), { name: 'lint', ok: false, detail: 'x / Tests: 1 failed' });
});

test('runCodeChecks: pytest nur mit PYTHON oder dem venv, nie mit python3; uebersprungene Tests sind rot (Plancheck P18)', () => {
  const calls = [];
  const fake = (pyOut) => (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'fff6666\n' };
    if (cmd === 'git') return { status: 0, stdout: '' };
    return { status: 0, stdout: cmd === '/venv/bin/python' ? pyOut : '', stderr: '' };
  };
  const none = runCodeChecks('/r', 'fff6666', fake(''), null).find((c) => c.name === 'pytest');
  assert.equal(none.ok, false);
  assert.match(none.detail, /Task 5, Step 0/);
  assert.ok(!calls.some((c) => /python/.test(c)), `kein Python-Aufruf erwartet: ${calls.join(', ')}`);
  const skipped = runCodeChecks('/r', 'fff6666', fake('213 passed, 24 skipped, 12 deselected in 3.10s'), '/venv/bin/python')
    .find((c) => c.name === 'pytest');
  assert.equal(skipped.ok, false);
  assert.match(skipped.detail, /uebersprungene Tests, pytest-asyncio fehlt\?/);
  const green = runCodeChecks('/r', 'fff6666', fake('237 passed, 12 deselected in 3.10s'), '/venv/bin/python')
    .find((c) => c.name === 'pytest');
  assert.deepEqual(green, { name: 'pytest', ok: true, detail: '' });
});

test('defaultPython: PYTHON vor dem venv, ohne beides null', () => {
  assert.equal(defaultPython({ PYTHON: '/x/python' }, '/v/python', () => true), '/x/python');
  assert.equal(defaultPython({}, '/v/python', (p) => p === '/v/python'), '/v/python');
  assert.equal(defaultPython({}, '/v/python', () => false), null);
  assert.match(VENV_PYTHON, /\.cache\/public-browser-venv\/bin\/python$/);
});

test('Probe-Runden: Summe der Mediane je Aufgabe gegen Referenz x 1,2, bestanden je Aufgabe (Plancheck P7)', () => {
  const { baseline } = baselineFixture();                   // Probe-Mediane 12 / 20 / 8: Summe 40, Grenze 48
  const h = { head: 'ggg7777' };
  const five = [3.7, 3.8, 3.9, 4.0, 4.1].map((t) => bench(t, 90, h));
  const probeOf = (runs) => evaluateStage({ stage: 1, current: selectStageRuns([...five, ...runs], 'ggg7777'), baseline, code: CODE_OK })
    .find((r) => r.id === 'probe');
  assert.equal(probeOf(probeSet(12, 26, 9, h)).pass, true);            // knapp unter: 47 ≤ 48
  assert.equal(probeOf(probeSet(12, 27, 9, h)).pass, true);            // auf der Grenze: 48 ≤ 48
  // knapp ueber: P2-Laeufe 27 und 28 -> Median 27,5, Summe 48,5 > 48
  const over = probeOf([probe('P1', 12, h), probe('P1', 12, h), probe('P2', 27, h), probe('P2', 28, h), probe('P3', 9, h), probe('P3', 9, h)]);
  assert.equal(over.pass, false);
  assert.match(over.detail, /Summe der Runden-Mediane 48\.5 \(P1 12 \+ P2 27\.5 \+ P3 9\), Grenze 48 = Baseline 40 × 1,2/);
  // eine Aufgabe mit vielen Runden bei Summe im Rahmen: P2 30 > 20 x 1,2, aber 10 + 30 + 7 = 47 ≤ 48 -> kein FAIL
  assert.equal(probeOf(probeSet(10, 30, 7, h)).pass, true);
  // bestanden bleibt je Aufgabe: ein nicht bestandener P3-Lauf ist FAIL, auch mit wenigen Runden
  const p3fail = [...probeSet(10, 20, 7, h).filter((r) => r.task !== 'P3'), probe('P3', 7, h), probe('P3', 7, { ...h, pass: false })];
  const f = probeOf(p3fail);
  assert.equal(f.pass, false);
  assert.match(f.detail, /P3 1\/2 bestanden \(.*P2-DRAG/);
});

test('verdict: PASS, FAIL, TOKENS-ONLY, INCONCLUSIVE und die Exit-Codes (Plancheck P11/P12)', () => {
  const r = (over = {}) => ['benchmark', 'rounds', 'tokens_median', 'tokens_max', 'probe', 'code'].map((id) => ({ id, pass: id in over ? over[id] : true }));
  assert.equal(verdict(r()), 'PASS');
  assert.equal(verdict(r({ tokens_median: false })), 'TOKENS-ONLY');
  assert.equal(verdict(r({ tokens_median: false, tokens_max: false })), 'TOKENS-ONLY');
  assert.equal(verdict(r({ tokens_median: false, rounds: false })), 'FAIL');
  assert.equal(verdict(r({ tokens_median: false, code: null })), 'FAIL');       // --skip-code: OFFEN ist kein Token-Kriterium
  assert.equal(verdict([...r({ tokens_median: false }), { id: 'tokens_vs_stage1', pass: false }]), 'FAIL');
  assert.equal(verdict(r({ rounds: false }), ['Chrome 154.0.7000.1 statt 153.0.8010.53 (Baseline)']), 'INCONCLUSIVE (version drift)');
  assert.deepEqual(EXIT_CODES, { PASS: 0, FAIL: 1, 'TOKENS-ONLY': 3, 'INCONCLUSIVE (version drift)': 4 });
  // Stufe 1 real: nur der Token-Median verfehlt (4,23 M > 4,22 M), alles andere gruen
  const { baseline } = baselineFixture();
  const h = { head: 'iii9999' };
  const results = evaluateStage({ stage: 1, baseline, code: CODE_OK,
    current: selectStageRuns([...[4.23, 4.23, 4.23, 4.0, 4.0].map((t) => bench(t, 90, h)), ...probeSet(12, 22, 9, h)], 'iii9999') });
  assert.equal(verdict(results), 'TOKENS-ONLY');
  assert.match(formatReport({ stage: 1, head: 'iii9999', results }), /Urteil: TOKENS-ONLY — nicht erfuellt: tokens_median$/);
});

test('Stufe 2: Token schlechter als Stufe 1 ist FAIL (tokens_vs_stage1), nur verfehltes Ziel ist TOKENS-ONLY', () => {
  const s1 = stage1Current();                                  // Token-Median 3,90 M, groesster Lauf 4,10 M
  const h = { head: 'ccc3333' };
  const ev = (tok) => evaluateStage({ stage: 2, stage1: s1, code: CODE_OK,
    current: selectStageRuns([...tok.map((t) => bench(t, 85, h)), ...probeSet(12, 22, 9, h)], 'ccc3333') });
  const miss = ev([3.5, 3.5, 3.5, 3.1, 3.0]);                  // Median 3,5 M > Ziel 3,4 M, aber besser als Stufe 1
  assert.equal(miss.find((r) => r.id === 'tokens_vs_stage1').pass, true);
  assert.equal(verdict(miss), 'TOKENS-ONLY');
  const worseMedian = ev([3.95, 3.95, 3.95, 3.1, 3.0]);         // Median 3,95 M > Stufe 1 3,90 M
  const t = worseMedian.find((r) => r.id === 'tokens_vs_stage1');
  assert.equal(t.pass, false);
  assert.equal(t.detail, 'Median 3.95M gegen 3.90M, Einzellauf max 3.95M gegen 4.10M');
  assert.equal(verdict(worseMedian), 'FAIL');
  const worseMax = ev([3.2, 3.3, 3.3, 3.1, 4.15]);              // Median besser, ein Lauf 4,15 M > 4,10 M (unter 4,2 M)
  assert.equal(worseMax.find((r) => r.id === 'tokens_max').pass, true);
  assert.equal(worseMax.find((r) => r.id === 'tokens_vs_stage1').pass, false);
  assert.equal(verdict(worseMax), 'FAIL');
});

test('Versionen: Drift gegen Baseline und Stufe 1, Mischung in einer Stufe (Plancheck P10)', () => {
  const same = { chrome: [CHROME], claude_code: [CC] };
  assert.deepEqual(versionsOf([bench(4, 90), probe('P1', 12, { chrome: null })]),
    { chrome: [CHROME, 'unknown'], claude_code: [CC] });
  assert.deepEqual(versionDrift(same, [{ label: 'Baseline', versions: same }]), []);
  assert.deepEqual(versionDrift({ chrome: ['154.0.7000.1'], claude_code: [CC] }, [{ label: 'Baseline', versions: same }]),
    ['Chrome 154.0.7000.1 statt 153.0.8010.53 (Baseline)']);
  assert.deepEqual(versionDrift({ chrome: [CHROME], claude_code: ['2.1.281'] },
    [{ label: 'Baseline', versions: same }, { label: 'Stufe 1', versions: same }]),
  ['Claude Code 2.1.281 statt 2.1.280 (Baseline)', 'Claude Code 2.1.281 statt 2.1.280 (Stufe 1)']);
  assert.deepEqual(versionDrift({ chrome: [CHROME, '154.0.7000.1'], claude_code: [CC] }, [{ label: 'Baseline', versions: { chrome: ['154.0.7000.1'], claude_code: [CC] } }]),
    ['Chrome gemischt in dieser Stufe: 153.0.8010.53, 154.0.7000.1', 'Chrome 153.0.8010.53 statt 154.0.7000.1 (Baseline)']);
  // selectStageRuns sammelt die Versionen der gewerteten Laeufe
  const h = { head: 'jjj1010' };
  const s = selectStageRuns([bench(3.5, 85, h), bench(3.5, 85, { ...h, cc: '2.1.281' }), probe('P1', 12, h)], 'jjj1010');
  assert.deepEqual(s.versions, { chrome: [CHROME], claude_code: [CC, '2.1.281'] });
  // formatReport nennt die Abweichung und urteilt INCONCLUSIVE
  const { baseline } = baselineFixture();
  const results = evaluateStage({ stage: 1, current: stage1Current(), baseline, code: CODE_OK });
  const drift = ['Chrome 154.0.7000.1 statt 153.0.8010.53 (Baseline)'];
  const report = formatReport({ stage: 1, head: 'aaa1111', results, drift });
  assert.match(report, /^Versionsdrift: Chrome 154\.0\.7000\.1 statt 153\.0\.8010\.53 \(Baseline\)$/m);
  assert.match(report, /Urteil: INCONCLUSIVE \(version drift\)$/);
});

test('buildBaseline: gemischte Versionen sind ein Problem, --chrome-version/--claude-code-version waehlen aus', () => {
  const NEW = '154.0.7000.1';
  const set = (chrome, cc) => [
    ...[4.89, 7.92, 4.51, 4.60, 5.10].map((t) => bench(t, 92, { chrome, cc })),
    ...[4.45, 4.22, 3.95, 4.30, 4.10].map((t) => bench(t, 96, { slug: 'agent-browser', version: '0.38.1', passed: 29, chrome, cc })),
    ...probeSet(12, 20, 8, { chrome, cc }),
  ];
  const runs = [...set(CHROME, CC), ...set(NEW, '2.1.290')];
  const mixed = buildBaseline(runs);
  assert.match(mixed.problems.join(), /gemischte Versionen: Chrome 153\.0\.8010\.53, 154\.0\.7000\.1; Claude Code 2\.1\.280, 2\.1\.290 — mit --chrome-version\/--claude-code-version waehlen/);
  const chromeOnly = buildBaseline(runs, new Date(), { chrome: NEW });
  assert.deepEqual(chromeOnly.problems, []);
  assert.deepEqual(chromeOnly.baseline.versions, { chrome: [NEW], claude_code: ['2.1.290'] });
  assert.deepEqual(chromeOnly.baseline.version_filter, { chrome: NEW, claude_code: null });
  assert.equal(chromeOnly.baseline.public_browser.n_ok, 5);
  assert.equal(chromeOnly.baseline.probe.P1.n, 2);
  const both = buildBaseline(runs, new Date(), { chrome: CHROME, claudeCode: CC });
  assert.deepEqual(both.problems, []);
  assert.deepEqual(both.baseline.versions, { chrome: [CHROME], claude_code: [CC] });
  const none = buildBaseline(runs, new Date(), { chrome: NEW, claudeCode: CC });   // keine Kombination vorhanden
  assert.match(none.problems.join(), /public-browser 2\.10\.6: 0 ok runs, need 5/);
});

test('parseCheckArgs: Stufe, Head, Stufe-1-Head und Ausschluesse', () => {
  assert.deepEqual(parseCheckArgs(['--stage', '2', '--head', 'b', '--stage1-head', 'a', '--exclude', 'public-browser-run9.json=Netz weg', '--skip-code']),
    { stage: 2, head: 'b', stage1Head: 'a', exclusions: { 'public-browser-run9.json': 'Netz weg' }, skipCode: true });
  assert.throws(() => parseCheckArgs(['--stage', '3', '--head', 'x']), /--stage must be 1 or 2/);
  assert.throws(() => parseCheckArgs(['--stage', '1']), /--head/);
  assert.throws(() => parseCheckArgs(['--stage', '2', '--head', 'b']), /--stage1-head/);
  assert.throws(() => parseCheckArgs(['--stage', '1', '--head', 'b', '--exclude', 'ohne-grund.json']), /<run_file>=<grund>/);
});

test('CLI: baseline schreibt die Datei genau einmal, check --stage 1 gibt PASS/FAIL je Kriterium und Exit-Code', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acceptance-'));
  const results = join(tmp, 'results');
  const local = join(tmp, 'results-local');
  mkdirSync(results);
  mkdirSync(local);
  const put = (dir, runs) => runs.forEach((r) => writeFileSync(join(dir, r.run_file), `${JSON.stringify(r, null, 2)}\n`));
  put(results, [
    bench(4.89, 92), bench(7.92, 123), bench(4.51, 90), bench(4.60, 95), bench(5.10, 99),
    ...[4.45, 4.22, 3.95, 4.30, 4.10].map((t) => bench(t, 96, { slug: 'agent-browser', version: '0.38.1', passed: 29 })),
    ...probeSet(12, 20, 8),
  ]);
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--results', results, '--local-results', local], { encoding: 'utf8' });
  const b = cli('baseline');
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /agent-browser 0\.38\.1: n=5, Token-Median 4\.22M/);
  assert.equal(JSON.parse(readFileSync(join(results, BASELINE_FILE), 'utf8')).public_browser.rounds.median, 95);
  assert.equal(cli('baseline').status, 2, 'zweites Schreiben wird verweigert');
  put(local, [...[3.7, 3.9, 4.05, 3.6, 4.1].map((t) => bench(t, 88, { head: 'aaa1111' })), ...probeSet(12, 22, 9, { head: 'aaa1111' })]);
  const pass = cli('check', '--stage', '1', '--head', 'aaa1111', '--skip-code');
  assert.equal(pass.status, 1, 'ohne Code-Pruefung kein Gesamt-PASS');
  assert.match(pass.stdout, /\[PASS\] Token \(Median\) ≤ Median agent-browser — 3\.90M gegen 4\.22M/);
  assert.match(pass.stdout, /\[OFFEN\] npm test/);
  assert.match(pass.stdout, /^Urteil: FAIL — nicht erfuellt: code$/m);
  const report = JSON.parse(readFileSync(join(local, 'acceptance-stage1-aaa1111.json'), 'utf8'));
  assert.equal(report.accepted, false);
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.exit_code, 1);
  assert.deepEqual(report.version_drift, []);
  const none = cli('check', '--stage', '1', '--head', 'zzz9999', '--skip-code');
  assert.equal(none.status, 1);
  assert.match(none.stdout, /\[FAIL\] Benchmark 30\/30 in 5 von 5 Laeufen — 0 Laeufe, 0 ok/);
  // Chrome hat sich seit der Baseline aktualisiert: kein PASS/FAIL, sondern Exit 4
  put(local, [...[3.7, 3.9, 4.05, 3.6, 4.1].map((t) => bench(t, 88, { head: 'hhh8888', chrome: '154.0.7000.1' })),
    ...probeSet(12, 22, 9, { head: 'hhh8888', chrome: '154.0.7000.1' })]);
  const drift = cli('check', '--stage', '1', '--head', 'hhh8888', '--skip-code');
  assert.equal(drift.status, 4, drift.stderr);
  assert.match(drift.stdout, /^Versionsdrift: Chrome 154\.0\.7000\.1 statt 153\.0\.8010\.53 \(Baseline\)$/m);
  assert.match(drift.stdout, /^Urteil: INCONCLUSIVE \(version drift\)$/m);
  assert.equal(JSON.parse(readFileSync(join(local, 'acceptance-stage1-hhh8888.json'), 'utf8')).verdict, 'INCONCLUSIVE (version drift)');
});

test('CLI: baseline mit gemischten Versionen endet mit Exit 1, --chrome-version waehlt die neuen Laeufe', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acceptance-mixed-'));
  const results = join(tmp, 'results');
  mkdirSync(results);
  const NEW = '154.0.7000.1';
  const set = (chrome) => [
    ...[4.89, 7.92, 4.51, 4.60, 5.10].map((t) => bench(t, 92, { chrome })),
    ...[4.45, 4.22, 3.95, 4.30, 4.10].map((t) => bench(t, 96, { slug: 'agent-browser', version: '0.38.1', passed: 29, chrome })),
    ...probeSet(12, 20, 8, { chrome }),
  ];
  [...set(CHROME), ...set(NEW)].forEach((r) => writeFileSync(join(results, r.run_file), `${JSON.stringify(r, null, 2)}\n`));
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, 'baseline', '--results', results, ...args], { encoding: 'utf8' });
  const mixed = cli();
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /gemischte Versionen: Chrome 153\.0\.8010\.53, 154\.0\.7000\.1 — mit --chrome-version\/--claude-code-version waehlen/);
  const picked = cli('--chrome-version', NEW);
  assert.equal(picked.status, 0, picked.stderr);
  assert.match(picked.stdout, /^Versionen: Chrome 154\.0\.7000\.1, Claude Code 2\.1\.280$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(results, BASELINE_FILE), 'utf8')).versions, { chrome: [NEW], claude_code: [CC] });
});

test('runCodeChecks: Dirty-Pruefung nutzt RESULT_PATHSPEC aus blind-run.mjs (V9)', () => {
  const gitCalls = [];
  const fake = (cmd, args) => {
    if (cmd === 'git') gitCalls.push(args);
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'fff6666\n' };
    if (cmd === 'git') return { status: 0, stdout: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  runCodeChecks('/r', 'fff6666', fake, '/venv/bin/python');
  const status = gitCalls.find((a) => a[0] === 'status');
  assert.ok(status, `git status erwartet: ${JSON.stringify(gitCalls)}`);
  assert.deepEqual(status, ['status', '--porcelain', ...RESULT_PATHSPEC]);
});

test('selectStageRuns: Versionsfilter wertet nur passende Laeufe, ohne Filter unveraendert (V4)', () => {
  const NEW = '154.0.7000.1';
  const h = { head: 'kkk1212' };
  const runs = [bench(3.5, 85, h), bench(3.6, 86, { ...h, chrome: NEW }), probe('P1', 12, h), probe('P1', 13, { ...h, chrome: NEW })];
  const all = selectStageRuns(runs, 'kkk1212');
  assert.equal(all.benchmark.n, 2);
  assert.equal(all.probe.P1.n, 2);
  assert.deepEqual(all.versions.chrome, [CHROME, NEW]);
  assert.deepEqual(all.warnings, []);
  const picked = selectStageRuns(runs, 'kkk1212', {}, { chrome: NEW });
  assert.equal(picked.benchmark.n, 1);
  assert.equal(picked.benchmark.tokens.median, 3.6 * M);
  assert.equal(picked.probe.P1.n, 1);
  assert.equal(picked.probe.P1.rounds.median, 13);
  assert.deepEqual(picked.versions, { chrome: [NEW], claude_code: [CC] });
  assert.match(picked.warnings.join(), /2 Laeufe mit anderer Version nicht gewertet \(Filter Chrome 154\.0\.7000\.1\)/);
  const byCc = selectStageRuns([bench(3.5, 85, h), bench(3.6, 86, { ...h, cc: '2.1.290' })], 'kkk1212', {}, { claudeCode: '2.1.290' });
  assert.deepEqual(byCc.versions, { chrome: [CHROME], claude_code: ['2.1.290'] });
  assert.match(byCc.warnings.join(), /1 Laeufe mit anderer Version nicht gewertet \(Filter Claude Code 2\.1\.290\)/);
});

test('CLI: check --chrome-version wertet nur die neuen Laeufe am selben Head, auch in Stufe 1 fuer Stufe 2 (V4)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acceptance-filter-'));
  const results = join(tmp, 'results');
  const local = join(tmp, 'results-local');
  mkdirSync(results);
  mkdirSync(local);
  const NEW = '154.0.7000.1';
  const put = (dir, runs) => runs.forEach((r) => writeFileSync(join(dir, r.run_file), `${JSON.stringify(r, null, 2)}\n`));
  const ref = (chrome) => [
    ...[4.89, 7.92, 4.51, 4.60, 5.10].map((t) => bench(t, 92, { chrome })),
    ...[4.45, 4.22, 3.95, 4.30, 4.10].map((t) => bench(t, 96, { slug: 'agent-browser', version: '0.38.1', passed: 29, chrome })),
    ...probeSet(12, 20, 8, { chrome }),
  ];
  put(results, [...ref(CHROME), ...ref(NEW)]);
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--results', results, '--local-results', local], { encoding: 'utf8' });
  assert.equal(cli('baseline', '--chrome-version', NEW).status, 0);
  // Stufe 1 am Head aaa: erst mit altem Chrome gemessen (billig), nach der Drift mit neuem Chrome neu (Median 3,90 M)
  const s1 = (chrome, tok) => [...tok.map((t) => bench(t, 88, { head: 'aaa1111', chrome })), ...probeSet(12, 22, 9, { head: 'aaa1111', chrome })];
  put(local, [...s1(CHROME, [2.0, 2.0, 2.0, 2.0, 2.0]), ...s1(NEW, [3.7, 3.9, 4.05, 3.6, 4.1])]);
  const mixed = cli('check', '--stage', '1', '--head', 'aaa1111', '--skip-code');
  assert.equal(mixed.status, 4, mixed.stderr);
  assert.match(mixed.stdout, /^Versionsdrift: Chrome gemischt in dieser Stufe: 153\.0\.8010\.53, 154\.0\.7000\.1$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(local, 'acceptance-stage1-aaa1111.json'), 'utf8')).version_filter, { chrome: null, claude_code: null });
  const one = cli('check', '--stage', '1', '--head', 'aaa1111', '--skip-code', '--chrome-version', NEW);
  assert.equal(one.status, 1, one.stderr);                       // --skip-code: FAIL nur wegen code
  assert.doesNotMatch(one.stdout, /Versionsdrift/);
  assert.match(one.stdout, /^Urteil: FAIL — nicht erfuellt: code$/m);
  assert.match(one.stdout, /\[PASS\] Token \(Median\) ≤ Median agent-browser — 3\.90M gegen 4\.22M/);
  const rep1 = JSON.parse(readFileSync(join(local, 'acceptance-stage1-aaa1111.json'), 'utf8'));
  assert.deepEqual(rep1.version_filter, { chrome: NEW, claude_code: null });
  assert.equal(rep1.benchmark.n, 5);
  // Stufe 2 am Head bbb mit neuem Chrome: Vergleich gegen die gefilterten Stufe-1-Laeufe (3,90 M), nicht gegen die alten (2,0 M)
  put(local, [...[3.2, 3.3, 3.4, 3.1, 3.0].map((t) => bench(t, 85, { head: 'bbb2222', chrome: NEW })), ...probeSet(12, 22, 9, { head: 'bbb2222', chrome: NEW })]);
  const s2 = cli('check', '--stage', '2', '--head', 'bbb2222', '--stage1-head', 'aaa1111', '--skip-code', '--chrome-version', NEW);
  assert.equal(s2.status, 1, s2.stderr);
  assert.doesNotMatch(s2.stdout, /Versionsdrift/);
  assert.match(s2.stdout, /\[PASS\] Token nicht schlechter als Stufe 1 \(Median und groesster Einzellauf\) — Median 3\.20M gegen 3\.90M, Einzellauf max 3\.40M gegen 4\.10M/);
  assert.match(s2.stdout, /^Urteil: FAIL — nicht erfuellt: code$/m);
  const s2raw = cli('check', '--stage', '2', '--head', 'bbb2222', '--stage1-head', 'aaa1111', '--skip-code');
  assert.equal(s2raw.status, 4, s2raw.stderr);
  assert.match(s2raw.stdout, /^Versionsdrift: Chrome gemischt in Stufe 1: 153\.0\.8010\.53, 154\.0\.7000\.1$/m);
});

test('CLI: Stufe 2 ohne gewertete Stufe-1-Laeufe ist ein Fehler (Exit 2), keine Versionsdrift (I1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acceptance-nostage1-'));
  const results = join(tmp, 'results');
  const local = join(tmp, 'results-local');
  mkdirSync(results);
  mkdirSync(local);
  const put = (dir, runs) => runs.forEach((r) => writeFileSync(join(dir, r.run_file), `${JSON.stringify(r, null, 2)}\n`));
  put(results, [
    ...[4.89, 7.92, 4.51, 4.60, 5.10].map((t) => bench(t, 92)),
    ...[4.45, 4.22, 3.95, 4.30, 4.10].map((t) => bench(t, 96, { slug: 'agent-browser', version: '0.38.1', passed: 29 })),
    ...probeSet(12, 20, 8),
  ]);
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--results', results, '--local-results', local], { encoding: 'utf8' });
  assert.equal(cli('baseline').status, 0);
  put(local, [
    ...[3.7, 3.9, 4.05, 3.6, 4.1].map((t) => bench(t, 88, { head: 'aaa1111' })), ...probeSet(12, 22, 9, { head: 'aaa1111' }),
    ...[3.2, 3.3, 3.4, 3.1, 3.0].map((t) => bench(t, 85, { head: 'bbb2222' })), ...probeSet(12, 22, 9, { head: 'bbb2222' }),
    bench(3.5, 85, { head: 'ddd4444', dirty: true }),
  ]);
  const check2 = (stage1Head, ...extra) => cli('check', '--stage', '2', '--head', 'bbb2222', '--stage1-head', stage1Head, '--skip-code', ...extra);
  // Tippfehler im SHA
  const typo = check2('aaX1111');
  assert.equal(typo.status, 2, typo.stdout);
  assert.match(typo.stderr, /no counted stage-1 runs at head aaX1111/);
  assert.doesNotMatch(typo.stdout, /Versionsdrift/);
  assert.throws(() => readFileSync(join(local, 'acceptance-stage2-bbb2222.json')), /ENOENT/);
  // alle Stufe-1-Laeufe dirty: der Hinweis steht in der Meldung
  const dirty = check2('ddd4444');
  assert.equal(dirty.status, 2, dirty.stdout);
  assert.match(dirty.stderr, /no counted stage-1 runs at head ddd4444 .*git_dirty=true, nicht gewertet/);
  // Filter trifft keinen Stufe-1-Lauf
  const filtered = check2('aaa1111', '--chrome-version', '154.0.7000.1');
  assert.equal(filtered.status, 2, filtered.stdout);
  assert.match(filtered.stderr, /no counted stage-1 runs at head aaa1111 \(filter Chrome 154\.0\.7000\.1\)/);
  // Gegenprobe: richtiger Stufe-1-Head -> normales Urteil (nur code offen), keine Drift
  const ok = check2('aaa1111');
  assert.equal(ok.status, 1, ok.stderr);
  assert.doesNotMatch(ok.stdout, /Versionsdrift/);
  assert.match(ok.stdout, /^Urteil: FAIL — nicht erfuellt: code$/m);
});
