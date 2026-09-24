#!/usr/bin/env node
// check-acceptance.mjs — Abnahme der Arbeit "Aufschliessen" (Stufe 1: keine stillen Fehler, Stufe 2: Ballast raus).
// Liest Run-JSONs des Benchmarks und der Realseiten-Probe, rechnet Mediane und gibt je Kriterium PASS/FAIL aus.
// Token zaehlen nur entdoppelt (tokens.dedup = "message.id"), Runden = tokens.rounds (Modellantworten).
//
//   node check-acceptance.mjs baseline [--results <dir>] [--chrome-version <v>] [--claude-code-version <v>]
//   node check-acceptance.mjs check --stage 1 --head <sha> [--skip-code] [--exclude <run_file>=<grund>]...
//   node check-acceptance.mjs check --stage 2 --head <sha> --stage1-head <sha> [--skip-code] [--exclude ...]
//   Gemeinsam: [--results <dir>] (Default results/) [--local-results <dir>] (Default results-local/)
//              [--chrome-version <v>] [--claude-code-version <v>] (nur Laeufe mit genau diesen Versionen)
//
// Exit-Codes von check: 0 PASS, 1 FAIL, 2 Fehler, 3 TOKENS-ONLY (nur Token-Ziel verfehlt, Funktion gruen, keine
// Verschlechterung), 4 INCONCLUSIVE (version drift) (Chrome oder Claude Code weicht von der Referenz ab).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULT_PATHSPEC, SCORABLE } from './blind-run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = 'baseline-2026-09-aufschliessen.json';
export const BASELINE_PINS = { 'public-browser': '2.10.6', 'agent-browser': '0.38.1' };
export const MIN_BENCH_RUNS = 5;
export const MIN_PROBE_RUNS = 2;
export const PROBE_TASKS = ['P1', 'P2', 'P3'];
// Feste Grenzen je Stufe (Abnahmetabelle). Die uebrigen Vergleichswerte kommen aus Baseline bzw. Stufe 1.
export const LIMITS = {
  1: { tokensMax: 4_900_000, probeRoundsFactor: 1.2 },
  2: { tokensMedian: 3_400_000, tokensMax: 4_200_000, probeRoundsFactor: 1.2 },
};
// Urteilsklassen: faellt ein Funktionskriterium, ist es FAIL; fallen nur Token-Ziele, ist es TOKENS-ONLY.
export const FUNCTION_CRITERIA = ['benchmark', 'rounds', 'tokens_vs_stage1', 'probe', 'code'];
export const TOKEN_CRITERIA = ['tokens_median', 'tokens_max'];
export const EXIT_CODES = { PASS: 0, FAIL: 1, 'TOKENS-ONLY': 3, 'INCONCLUSIVE (version drift)': 4 };
// Python-Umgebung des Plans (Task 5, Step 0): pytest mit pytest-asyncio, sonst werden async-Tests still uebersprungen.
export const VENV_PYTHON = join(homedir(), '.cache', 'public-browser-venv', 'bin', 'python');

export function median(values) {
  const v = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// In eine Abnahme gehen nur entdoppelte Token (recompute-tokens.mjs bzw. measure-session-cost.sh ab M1).
function tokenData(run) {
  const t = run.tokens ?? {};
  if (t.dedup !== 'message.id' || !(t.delta > 0) || !(t.rounds > 0)) {
    throw new Error(`${run.run_file}: tokens not counted by message.id (run recompute-tokens.mjs first)`);
  }
  return t;
}

const abortReason = (r) => `status ${r.harness?.status ?? '?'}${r.notes ? `: ${r.notes}` : ''}`;

export function summarizeBenchmark(runs) {
  const failures = [];
  const ok = [];
  for (const r of runs) {
    if (r.harness?.status !== 'ok') { failures.push({ run: r.run_file, reason: abortReason(r) }); continue; }
    ok.push(r);
    const s = r.summary ?? {};
    if (s.passed !== SCORABLE.length || s.counted !== SCORABLE.length) failures.push({ run: r.run_file, reason: `${s.passed}/${s.counted}` });
  }
  const tokens = ok.map((r) => tokenData(r).delta);
  const max = tokens.length ? Math.max(...tokens) : null;
  const rounds = ok.map((r) => r.tokens.rounds);
  const calls = ok.map((r) => r.tool_efficiency?.calls_total ?? null);
  return {
    n: runs.length, n_ok: ok.length, runs: runs.map((r) => r.run_file), failures,
    tokens: { median: median(tokens), max, max_run: max === null ? null : ok[tokens.indexOf(max)].run_file, values: tokens },
    rounds: { median: median(rounds), values: rounds },
    calls: { median: median(calls), values: calls },
  };
}

export function summarizeProbe(runs) {
  const out = {};
  for (const task of PROBE_TASKS) {
    const rs = runs.filter((r) => r.task === task);
    const ok = rs.filter((r) => r.harness?.status === 'ok');
    const failures = rs.filter((r) => r.harness?.status !== 'ok' || r.probe?.pass !== true).map((r) => ({
      run: r.run_file, reason: r.harness?.status !== 'ok' ? abortReason(r) : (r.probe?.problems ?? []).join('; ') || 'not passed',
    }));
    const rounds = ok.map((r) => tokenData(r).rounds);
    const tokens = ok.map((r) => r.tokens.delta);
    out[task] = { n: rs.length, n_ok: ok.length, passed: rs.length - failures.length, runs: rs.map((r) => r.run_file), failures,
      rounds: { median: median(rounds), values: rounds }, tokens: { median: median(tokens), values: tokens } };
  }
  return out;
}

// Versionen, von denen die Token pro Runde abhaengen: Chrome (Run-Feld chrome_version) und Claude Code
// (harness.claude_code_version, bringt Systemprompt und Cache-Verhalten mit). Fehlt ein Wert, zaehlt er als "unknown".
const VERSION_NAMES = { chrome: 'Chrome', claude_code: 'Claude Code' };

export function versionsOf(runs) {
  const uniq = (xs) => [...new Set(xs.map((x) => x ?? 'unknown'))].sort();
  return { chrome: uniq(runs.map((r) => r.chrome_version)), claude_code: uniq(runs.map((r) => r.harness?.claude_code_version)) };
}

// Abweichungen der gewerteten Laeufe von den Referenzen und Mischungen innerhalb einer Gruppe.
// refs: [{ label: 'Baseline' | 'Stufe 1', versions }]. Leere Liste = keine Drift.
export function versionDrift(current, refs = []) {
  const drift = [];
  for (const [key, name] of Object.entries(VERSION_NAMES)) {
    const cur = current?.[key] ?? [];
    if (cur.length > 1) drift.push(`${name} mixed in this stage: ${cur.join(', ')}`);
    for (const ref of refs) {
      const want = ref.versions?.[key] ?? [];
      if (want.length > 1) drift.push(`${name} mixed in ${ref.label}: ${want.join(', ')}`);
      const off = cur.filter((v) => !want.includes(v));
      if (off.length) drift.push(`${name} ${off.join(', ')} instead of ${want.join(', ') || '—'} (${ref.label})`);
    }
  }
  return drift;
}

const isBench = (r) => r.harness?.mode === 'blind-print' && r.slug === 'public-browser';
const isProbe = (r) => r.harness?.mode === 'real-sites-probe' && r.slug === 'public-browser';

// Nur Laeufe mit genau diesen Versionen (filter: { chrome?, claudeCode? }); ohne Filter zaehlt jeder Lauf.
const versionFilter = (filter = {}) => (r) => (filter.chrome === undefined || r.chrome_version === filter.chrome)
  && (filter.claudeCode === undefined || r.harness?.claude_code_version === filter.claudeCode);
const filterText = (filter = {}) => [
  filter.chrome === undefined ? null : `Chrome ${filter.chrome}`,
  filter.claudeCode === undefined ? null : `Claude Code ${filter.claudeCode}`,
].filter(Boolean).join(', ');

// Laeufe einer Stufe: lokaler Build, genau dieser Head, saubere Arbeitskopie. Ausschluss nur fuer abgebrochene Laeufe.
// filter wie bei buildBaseline: nach einer Versionsdrift liegen alte und neue Laeufe desselben Heads nebeneinander.
export function selectStageRuns(runs, head, exclusions = {}, filter = {}) {
  const warnings = [];
  const picked = [];
  const atHead = runs.filter((r) => r.harness?.local_build === true && r.harness?.git_head === head);
  for (const f of Object.keys(exclusions)) {
    const r = atHead.find((x) => x.run_file === f);
    if (!r) throw new Error(`--exclude ${f}: no run at head ${head}`);
    if (r.harness.status === 'ok') throw new Error(`--exclude ${f}: only aborted runs may be excluded`);
  }
  const chosen = versionFilter(filter);
  const skipped = atHead.filter((r) => !chosen(r)).length;
  if (skipped) warnings.push(`${skipped} runs with another version not counted (filter ${filterText(filter)})`);
  for (const r of atHead.filter(chosen)) {
    if (r.harness.git_dirty !== false) { warnings.push(`${r.run_file}: git_dirty=${r.harness.git_dirty}, not counted`); continue; }
    if (exclusions[r.run_file] !== undefined) { warnings.push(`${r.run_file}: excluded — ${exclusions[r.run_file]}`); continue; }
    picked.push(r);
  }
  return {
    benchmark: summarizeBenchmark(picked.filter(isBench)),
    probe: summarizeProbe(picked.filter(isProbe)),
    versions: versionsOf(picked.filter((r) => isBench(r) || isProbe(r))),
    warnings,
  };
}

// filter: { chrome?, claudeCode? } — nur Laeufe mit genau diesen Versionen zaehlen (nach einer Versionsdrift liegen
// alte und neue Referenzlaeufe nebeneinander in results/). Ohne Filter muessen alle gewerteten Laeufe gleich sein.
export function buildBaseline(runs, now = new Date(), filter = {}) {
  const npm = (r) => r.harness?.local_build !== true;
  const chosen = versionFilter(filter);
  const bench = (slug) => runs.filter((r) => r.harness?.mode === 'blind-print' && r.slug === slug
    && r.mcp_version === BASELINE_PINS[slug] && npm(r) && chosen(r));
  const pbRuns = bench('public-browser');
  const abRuns = bench('agent-browser');
  const probeRuns = runs.filter((r) => isProbe(r) && r.mcp_version === BASELINE_PINS['public-browser'] && npm(r) && chosen(r));
  const versions = versionsOf([...pbRuns, ...abRuns, ...probeRuns]);
  const baseline = {
    created_at: now.toISOString(), pins: BASELINE_PINS, versions,
    version_filter: { chrome: filter.chrome ?? null, claude_code: filter.claudeCode ?? null },
    public_browser: summarizeBenchmark(pbRuns),
    agent_browser: summarizeBenchmark(abRuns),
    probe: summarizeProbe(probeRuns),
  };
  const problems = [];
  const warnings = [];
  for (const [key, slug] of [['public_browser', 'public-browser'], ['agent_browser', 'agent-browser']]) {
    if (baseline[key].n_ok < MIN_BENCH_RUNS) problems.push(`${slug} ${BASELINE_PINS[slug]}: ${baseline[key].n_ok} ok runs, need ${MIN_BENCH_RUNS}`);
  }
  for (const t of PROBE_TASKS) {
    const p = baseline.probe[t];
    if (p.n_ok < MIN_PROBE_RUNS) problems.push(`probe ${t}: ${p.n_ok} ok runs, need ${MIN_PROBE_RUNS}`);
    if (p.failures.length) warnings.push(`probe ${t}: ${p.failures.map((f) => `${f.run} ${f.reason}`).join('; ')}`);
  }
  const mixed = Object.keys(VERSION_NAMES).filter((k) => versions[k].length > 1);
  if (mixed.length) {
    problems.push(`mixed versions: ${mixed.map((k) => `${VERSION_NAMES[k]} ${versions[k].join(', ')}`).join('; ')}`
      + ' — pick one with --chrome-version/--claude-code-version');
  }
  if (baseline.public_browser.failures.length) {
    warnings.push(`public-browser: ${baseline.public_browser.failures.map((f) => `${f.run} ${f.reason}`).join('; ')}`);
  }
  return { baseline, problems, warnings };
}

const M = (x) => (Number.isFinite(x) ? `${(x / 1e6).toFixed(2)}M` : '—');
const le = (x, limit) => Number.isFinite(x) && Number.isFinite(limit) && x <= limit;
const r1 = (x) => Math.round(x * 10) / 10;

// Summe der Runden-Mediane je Aufgabe ueber P1–P3 (paarungsfrei: jeder Probe-Lauf faehrt nur eine Aufgabe).
function probeRoundSum(probe) {
  const medians = PROBE_TASKS.map((t) => probe?.[t]?.rounds?.median);
  return medians.every(Number.isFinite) ? medians.reduce((a, b) => a + b, 0) : null;
}

// Ein Eintrag je Zeile der Spec-Tabelle. pass: true/false, null = nicht geprueft (zaehlt nicht als bestanden).
export function evaluateStage({ stage, current, baseline = null, stage1 = null, code = null }) {
  const lim = LIMITS[stage];
  if (!lim) throw new Error(`unknown stage ${stage}`);
  if (stage === 1 && !baseline) throw new Error('stage 1 needs the baseline');
  if (stage === 2 && !stage1) throw new Error('stage 2 needs the stage-1 runs');
  const b = current.benchmark;
  const out = [];
  const add = (id, label, pass, detail) => out.push({ id, label, pass, detail });

  add('benchmark', `Benchmark 30/30 in ${MIN_BENCH_RUNS} of ${MIN_BENCH_RUNS} runs`,
    b.n_ok >= MIN_BENCH_RUNS && b.failures.length === 0,
    `${b.n} runs, ${b.n_ok} ok${b.failures.length ? ` — ${b.failures.map((f) => `${f.run}: ${f.reason}`).join('; ')}` : ', all 30/30'}`);

  const refRounds = stage === 1 ? baseline.public_browser.rounds.median : stage1.benchmark.rounds.median;
  add('rounds', stage === 1 ? 'Rounds (median) ≤ baseline PB 2.10.6' : 'Rounds (median) ≤ stage 1 result',
    le(b.rounds.median, refRounds), `${b.rounds.median ?? '—'} vs ${refRounds ?? '—'} (${b.rounds.values.join(', ')})`);

  const tokenLimit = stage === 1 ? baseline.agent_browser.tokens.median : lim.tokensMedian;
  add('tokens_median', stage === 1 ? 'Tokens (median) ≤ agent-browser median' : `Tokens (median) ≤ ${M(lim.tokensMedian)}`,
    le(b.tokens.median, tokenLimit), `${M(b.tokens.median)} vs ${M(tokenLimit)} (${b.tokens.values.map(M).join(', ')})`);

  add('tokens_max', `Single run ≤ ${M(lim.tokensMax)}`, le(b.tokens.max, lim.tokensMax), `max ${M(b.tokens.max)} (${b.tokens.max_run ?? '—'})`);

  if (stage === 2) {
    // Verschlechterung gegen Stufe 1 ist ein Funktionskriterium (Ruecknahme-Regel), kein blosses Token-Ziel.
    const s1 = stage1.benchmark.tokens;
    add('tokens_vs_stage1', 'Tokens no worse than stage 1 (median and largest single run)',
      le(b.tokens.median, s1.median) && le(b.tokens.max, s1.max),
      `median ${M(b.tokens.median)} vs ${M(s1.median)}, single run max ${M(b.tokens.max)} vs ${M(s1.max)}`);
  }

  // Probe: bestanden je Aufgabe (mind. 2 Laeufe, alle bestanden); Runden als Summe der Mediane je Aufgabe.
  const refProbe = stage === 1 ? baseline.probe : stage1.probe;
  const refLabel = stage === 1 ? 'Baseline' : 'stage 1';
  const perTask = PROBE_TASKS.map((t) => {
    const c = current.probe[t];
    const fails = c.failures.length ? ` (${c.failures.map((f) => `${f.run}: ${f.reason}`).join('; ')})` : '';
    return { pass: c.n >= MIN_PROBE_RUNS && c.failures.length === 0, text: `${t} ${c.passed}/${c.n} passed${fails}` };
  });
  const sum = probeRoundSum(current.probe);
  const refSum = probeRoundSum(refProbe);
  const limit = refSum === null ? null : Math.round(refSum * lim.probeRoundsFactor * 1000) / 1000;
  const medians = PROBE_TASKS.map((t) => `${t} ${current.probe[t].rounds.median ?? '—'}`).join(' + ');
  add('probe', `Real-site probe P1–P3 passed in ${MIN_PROBE_RUNS} of ${MIN_PROBE_RUNS} runs each, sum of round medians ≤ ${refLabel} + 20 %`,
    perTask.every((p) => p.pass) && le(sum, limit),
    `${perTask.map((p) => p.text).join(' · ')} · sum of round medians ${sum === null ? '—' : r1(sum)} (${medians}), `
    + `limit ${limit === null ? '—' : r1(limit)} = ${refLabel} ${refSum ?? '—'} × 1.2`);

  add('code', 'npm test, lint, npm run build, Python tests green', code === null ? null : code.length > 0 && code.every((c) => c.ok),
    code === null ? 'not checked (--skip-code)' : code.map((c) => `${c.name} ${c.ok ? 'ok' : `RED (${c.detail})`}`).join(', '));
  return out;
}

export const accepted = (results) => results.length > 0 && results.every((r) => r.pass === true);

// Gesamturteil. Versionsdrift geht vor: dann ist kein Vergleich mit der Referenz fair.
export function verdict(results, drift = []) {
  if (drift.length) return 'INCONCLUSIVE (version drift)';
  if (accepted(results)) return 'PASS';
  const open = results.filter((r) => r.pass !== true);
  return open.every((r) => TOKEN_CRITERIA.includes(r.id)) ? 'TOKENS-ONLY' : 'FAIL';
}

export function formatReport({ stage, head, results, warnings = [], drift = [] }) {
  const tag = (p) => (p === true ? 'PASS' : p === false ? 'FAIL' : 'OPEN');
  const lines = [`Acceptance stage ${stage} — head ${head}`];
  for (const r of results) lines.push(`[${tag(r.pass)}] ${r.label} — ${r.detail}`);
  for (const w of warnings) lines.push(`Note: ${w}`);
  for (const d of drift) lines.push(`Version drift: ${d}`);
  const v = verdict(results, drift);
  const open = results.filter((r) => r.pass !== true).map((r) => r.id);
  lines.push(v === 'PASS' || v.startsWith('INCONCLUSIVE') ? `Verdict: ${v}` : `Verdict: ${v} — not met: ${open.join(', ')}`);
  return lines.join('\n');
}

// Python fuer das Code-Kriterium: $PYTHON, sonst das venv aus Task 5, Step 0. Nie das System-Python (ohne
// pytest-asyncio laufen die async-Tests nicht, sondern werden still uebersprungen).
export function defaultPython(env = process.env, venv = VENV_PYTHON, exists = existsSync) {
  if (env.PYTHON) return env.PYTHON;
  return exists(venv) ? venv : null;
}

// Code-Kriterium: nur gegen genau den gemessenen Stand (HEAD = --head, Arbeitskopie ohne Aenderungen ausser Ergebnissen).
export function runCodeChecks(repoRoot, head, run = spawnSync, python = defaultPython()) {
  const git = (args) => String(run('git', args, { cwd: repoRoot, encoding: 'utf8' }).stdout ?? '').trim();
  const actual = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain', ...RESULT_PATHSPEC]);
  if (actual !== head) return [{ name: 'working copy', ok: false, detail: `HEAD is ${actual}, but ${head} was measured` }];
  if (dirty) return [{ name: 'working copy', ok: false, detail: 'uncommitted changes' }];
  const steps = [
    ['npm test', 'npm', ['test'], repoRoot],
    ['lint', 'npm', ['run', 'lint'], repoRoot],
    ['build', 'npm', ['run', 'build'], repoRoot],
    ['pytest', python, ['-m', 'pytest', '-q'], join(repoRoot, 'python')],
  ];
  return steps.map(([name, cmd, args, cwd]) => {
    if (!cmd) {
      return { name, ok: false, detail: `no Python: PYTHON not set and ${VENV_PYTHON} missing (Plan Task 5, Step 0)` };
    }
    const r = run(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-2).join(' / ');
    if (r.status !== 0) return { name, ok: false, detail: String(r.error?.message ?? tail).slice(0, 200) };
    if (name === 'pytest' && /\b\d+ skipped\b/.test(`${r.stdout ?? ''}`)) {
      return { name, ok: false, detail: `skipped tests, pytest-asyncio missing? (${tail.slice(0, 160)})` };
    }
    return { name, ok: true, detail: '' };
  });
}

function readRuns(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), run_file: f }));
}

const USAGE = 'usage: node check-acceptance.mjs baseline [--results <dir>] [--chrome-version <v>] [--claude-code-version <v>]\n'
  + '       node check-acceptance.mjs check --stage 1|2 --head <sha> [--stage1-head <sha>] [--skip-code] '
  + '[--exclude <run_file>=<reason>]... [--chrome-version <v>] [--claude-code-version <v>] [--results <dir>] [--local-results <dir>]';

export function parseCheckArgs(rest) {
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const stage = Number(opt('--stage'));
  if (![1, 2].includes(stage)) throw new Error('--stage must be 1 or 2');
  const head = opt('--head');
  if (!head) throw new Error('--head <sha> is required (git rev-parse --short HEAD of the measured build)');
  const stage1Head = opt('--stage1-head');
  if (stage === 2 && !stage1Head) throw new Error('--stage1-head <sha> is required for stage 2');
  const exclusions = {};
  rest.forEach((a, i) => {
    if (a !== '--exclude') return;
    const m = String(rest[i + 1] ?? '').match(/^([^=]+\.json)=(.+)$/);
    if (!m) throw new Error('--exclude needs <run_file>=<reason>');
    exclusions[m[1]] = m[2];
  });
  return { stage, head, stage1Head, exclusions, skipCode: rest.includes('--skip-code') };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const resultsDir = opt('--results') || join(HERE, 'results');
  const localDir = opt('--local-results') || join(HERE, 'results-local');
  const filter = { chrome: opt('--chrome-version'), claudeCode: opt('--claude-code-version') };
  if (cmd === 'baseline') {
    const { baseline, problems, warnings } = buildBaseline(readRuns(resultsDir), new Date(), filter);
    for (const w of warnings) console.log(`Note: ${w}`);
    if (problems.length) { console.error(`Baseline incomplete:\n- ${problems.join('\n- ')}`); process.exit(1); }
    const out = join(resultsDir, BASELINE_FILE);
    writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
    const pb = baseline.public_browser;
    const ab = baseline.agent_browser;
    console.log([
      `Baseline written: ${out}`,
      `Versions: Chrome ${baseline.versions.chrome.join(', ')}, Claude Code ${baseline.versions.claude_code.join(', ')}`,
      `Public Browser ${BASELINE_PINS['public-browser']}: n=${pb.n_ok}, token median ${M(pb.tokens.median)} (max ${M(pb.tokens.max)}), rounds median ${pb.rounds.median}, calls median ${pb.calls.median}`,
      `agent-browser ${BASELINE_PINS['agent-browser']}: n=${ab.n_ok}, token median ${M(ab.tokens.median)} (max ${M(ab.tokens.max)}), rounds median ${ab.rounds.median}, calls median ${ab.calls.median}`,
      ...PROBE_TASKS.map((t) => `Probe ${t}: ${baseline.probe[t].passed}/${baseline.probe[t].n} passed, rounds median ${baseline.probe[t].rounds.median}, token median ${M(baseline.probe[t].tokens.median)}`),
    ].join('\n'));
    return;
  }
  if (cmd !== 'check') { console.log(USAGE); process.exit(2); }
  const a = parseCheckArgs(rest);
  const runs = readRuns(localDir);
  const current = selectStageRuns(runs, a.head, a.exclusions, filter);
  const stage1 = a.stage === 2 ? selectStageRuns(runs, a.stage1Head, {}, filter) : null;
  // Leere Stufe-1-Auswahl (Tippfehler im SHA, alles dirty, Filter trifft nichts) ist ein Aufruffehler (Exit 2),
  // keine Versionsdrift: sonst wuerde eine unnoetige Baseline-Neumessung ausgeloest.
  if (stage1 && stage1.benchmark.n === 0 && PROBE_TASKS.every((t) => stage1.probe[t].n === 0)) {
    const f = filterText(filter);
    throw new Error(`no counted stage-1 runs at head ${a.stage1Head}${f ? ` (filter ${f})` : ''}`
      + `${stage1.warnings.length ? ` — ${stage1.warnings.join('; ')}` : ''}`);
  }
  const baselinePath = join(resultsDir, BASELINE_FILE);
  if (!existsSync(baselinePath)) throw new Error(`baseline missing: ${baselinePath} (node check-acceptance.mjs baseline)`);
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const code = a.skipCode ? null : runCodeChecks(join(HERE, '..'), a.head);
  const results = evaluateStage({ stage: a.stage, current, baseline, stage1, code });
  const drift = versionDrift(current.versions,
    [{ label: 'Baseline', versions: baseline.versions }, ...(stage1 ? [{ label: 'stage 1', versions: stage1.versions }] : [])]);
  const v = verdict(results, drift);
  const warnings = [...current.warnings, ...(stage1?.warnings ?? []).map((w) => `stage 1: ${w}`)];
  console.log(formatReport({ stage: a.stage, head: a.head, results, warnings, drift }));
  const report = join(localDir, `acceptance-stage${a.stage}-${a.head}.json`);
  writeFileSync(report, `${JSON.stringify({
    stage: a.stage, head: a.head, stage1_head: a.stage1Head ?? null, checked_at: new Date().toISOString(),
    verdict: v, exit_code: EXIT_CODES[v], accepted: v === 'PASS', results, warnings, exclusions: a.exclusions,
    version_filter: { chrome: filter.chrome ?? null, claude_code: filter.claudeCode ?? null },
    version_drift: drift, versions: current.versions, baseline_versions: baseline.versions ?? null,
    benchmark: current.benchmark, probe: current.probe,
  }, null, 2)}\n`);
  console.log(`Report: ${report}`);
  process.exit(EXIT_CODES[v]);
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(String(e.message ?? e)); process.exit(2); }
}
