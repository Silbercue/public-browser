import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  GRADER_MODEL, GRADER_FLAGS, buildGraderInput, runGrader, scoreSession, findingKey, gradeRound,
} from './grade.mjs';
import { fixtureCatalog, makeSession, seedWithChange } from '../fixtures/grader/build.mjs';
import { loadSeeds } from './seed.mjs';
import { validateGradedResult, sessionFileName } from './result-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const FAKE = join(ROOT, 'fixtures', 'grader', 'fake-grader.mjs');
const fakeCmd = `"${process.execPath}" "${FAKE}"`;

const catalog = fixtureCatalog();
const SEED = loadSeeds()[0];
const act = (id, station, width) => ({ id, station, width });
/** @returns {any} */
const m = (i, match, confidence = 'high') => ({ i, match, confidence, reason: '' });
const fileOf = (s) => sessionFileName({ slug: s.participant.slug, type: s.session.type, seed: s.session.seed });
const keyOf = (s, i) => findingKey(fileOf(s), i, s.report.normalized.findings[i]);

// ---------- scoreSession: hits, duplicates, false alarms ----------

test('two findings for the same bug: 1 hit, 1 duplicate, 0 false alarms', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }, { title: 'b' }] });
  const met = scoreSession({ result, catalog, grading: { matches: [m(0, 'B01'), m(1, 'B01')] }, decisions: {} });
  assert.equal(met.bugs.hits, 1);
  assert.equal(met.duplicates, 1);
  assert.equal(met.false_alarms.total, 0);
  assert.equal(met.false_alarms.unreviewed, 0);
  assert.deepEqual(met.hit_ids, ['B01']);
});

test('decoy finding counts as false alarm; a second one for the same decoy is a duplicate', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }, { title: 'b' }] });
  assert.ok(result.session.run_config.decoys.includes('D01'));
  const one = scoreSession({ result, catalog, grading: { matches: [m(0, 'D01'), m(1, 'none')] }, decisions: {} });
  assert.equal(one.false_alarms.decoy, 1);
  assert.equal(one.false_alarms.total, 1);
  assert.equal(one.bugs.hits, 0);
  const two = scoreSession({ result, catalog, grading: { matches: [m(0, 'D01'), m(1, 'D01')] }, decisions: {} });
  assert.equal(two.false_alarms.decoy, 1);
  assert.equal(two.duplicates, 1);
});

test('match to a decoy outside run_config.decoys is none', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B06', 'profile', 'phone')], findings: [{ title: 'a' }] });
  assert.ok(!result.session.run_config.decoys.includes('D02'));
  const met = scoreSession({ result, catalog, grading: { matches: [m(0, 'D02')] }, decisions: {} });
  assert.equal(met.false_alarms.decoy, 0);
  assert.equal(met.false_alarms.unreviewed, 1);
});

test('none without decision is unreviewed, with false-alarm decision it is decided', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }] });
  const grading = { matches: [m(0, 'none')] };
  const open = scoreSession({ result, catalog, grading, decisions: {} });
  assert.deepEqual(open.false_alarms, { decoy: 0, decided: 0, unreviewed: 1, total: 0 });
  const key = keyOf(result, 0);
  assert.match(key, /^[0-9a-f]{12}$/);
  const decided = scoreSession({ result, catalog, grading, decisions: { [key]: { verdict: 'false-alarm' } } });
  assert.deepEqual(decided.false_alarms, { decoy: 0, decided: 1, unreviewed: 0, total: 1 });
});

test('match to a distractor (inactive bug) is none; the same match on an active bug is a hit', () => {
  const findings = [{ title: 'a' }];
  const inactive = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings });
  const metIn = scoreSession({ result: inactive, catalog, grading: { matches: [m(0, 'B07')] }, decisions: {} });
  assert.equal(metIn.bugs.hits, 0);
  assert.equal(metIn.false_alarms.unreviewed, 1);
  const active = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone'), act('B07', 'home', 'desktop')], findings });
  const metAct = scoreSession({ result: active, catalog, grading: { matches: [m(0, 'B07')] }, decisions: {} });
  assert.equal(metAct.bugs.hits, 1);
  assert.equal(metAct.false_alarms.unreviewed, 0);
});

test('unknown id is none', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }] });
  const met = scoreSession({ result, catalog, grading: { matches: [m(0, 'Z99')] }, decisions: {} });
  assert.equal(met.false_alarms.unreviewed, 1);
});

test('finding about the change target is neither hit nor false alarm nor open; active excludes it', () => {
  const seed = seedWithChange(true);
  const result = makeSession({ catalog, seed, activate: [act('B02', 'cart', 'all'), act('B01', 'cart', 'phone')], findings: [{ title: 'a' }] });
  assert.equal(result.session.run_config.change.bugId, 'B02');
  const met = scoreSession({ result, catalog, grading: { matches: [m(0, 'B02')] }, decisions: {} });
  assert.equal(met.bugs.active, 1);
  assert.equal(met.bugs.hits, 0);
  assert.equal(met.duplicates, 0);
  assert.deepEqual(met.false_alarms, { decoy: 0, decided: 0, unreviewed: 0, total: 0 });
});

test('bugs per category and width, hit rate', () => {
  const result = makeSession({
    catalog, seed: SEED, findings: [{ title: 'a' }],
    activate: [act('B01', 'cart', 'phone'), act('B05', 'checkout', 'tablet'), act('B08', 'settings', 'all')],
  });
  const met = scoreSession({ result, catalog, grading: { matches: [m(0, 'B05')] }, decisions: {} });
  assert.equal(met.bugs.active, 3);
  assert.equal(met.bugs.hits, 1);
  assert.equal(met.bugs.hit_rate, 1 / 3);
  assert.deepEqual(met.bugs.by_category, { fiddly: { active: 1, hits: 0 }, 'next-step': { active: 1, hits: 1 }, background: { active: 1, hits: 0 } });
  assert.deepEqual(met.bugs.by_width, { phone: { active: 1, hits: 0 }, tablet: { active: 1, hits: 1 }, all: { active: 1, hits: 0 } });
});

// ---------- change verdict (A) ----------

test('change: works on broken is false_works; broken on broken is correct', () => {
  const seed = seedWithChange(true);
  const works = makeSession({ catalog, seed, verdict: 'works' });
  const a = scoreSession({ result: works, catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(a.change, { verdict: 'works', truth: 'broken', correct: false, false_works: true });
  const broken = makeSession({ catalog, seed, verdict: 'broken' });
  const b = scoreSession({ result: broken, catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(b.change, { verdict: 'broken', truth: 'broken', correct: true, false_works: false });
});

test('change: works on healthy is correct and no false_works; missing verdict gives correct null', () => {
  const seed = seedWithChange(false);
  const a = scoreSession({ result: makeSession({ catalog, seed, verdict: 'works' }), catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(a.change, { verdict: 'works', truth: 'works', correct: true, false_works: false });
  const n = scoreSession({ result: makeSession({ catalog, seed, verdict: null }), catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(n.change, { verdict: null, truth: 'works', correct: null, false_works: false });
});

// ---------- traps (C) ----------

const ev = (type, extra = {}) => ({ t: '2026-10-21T10:00:00.000Z', sb: 'sb', type, ...extra });

test('trap reached and passed without a hit is silently bypassed', () => {
  const events = [ev('bug', { bug: 'B03', event: 'reached' }), ev('bug', { bug: 'B03', event: 'passed' })];
  const result = makeSession({ catalog, seed: SEED, activate: [act('B03', 'schedule', 'all')], events });
  const met = scoreSession({ result, catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(met.traps, { reached: 1, reported: 0, silently_bypassed: 1, stuck: 0, not_reached: 0 });
});

test('trap: hit is reported, reached only is stuck, nothing is not_reached', () => {
  const events = [ev('bug', { bug: 'B03', event: 'reached' }), ev('bug', { bug: 'B03', event: 'passed' })];
  const hit = makeSession({ catalog, seed: SEED, activate: [act('B03', 'schedule', 'all')], events, findings: [{ title: 'a' }] });
  assert.deepEqual(scoreSession({ result: hit, catalog, grading: { matches: [m(0, 'B03')] }, decisions: {} }).traps,
    { reached: 1, reported: 1, silently_bypassed: 0, stuck: 0, not_reached: 0 });
  const stuck = makeSession({ catalog, seed: SEED, activate: [act('B03', 'schedule', 'all')], events: [events[0]] });
  assert.deepEqual(scoreSession({ result: stuck, catalog, grading: { matches: [] }, decisions: {} }).traps,
    { reached: 1, reported: 0, silently_bypassed: 0, stuck: 1, not_reached: 0 });
  const none = makeSession({ catalog, seed: SEED, activate: [act('B03', 'schedule', 'all')] });
  assert.deepEqual(scoreSession({ result: none, catalog, grading: { matches: [] }, decisions: {} }).traps,
    { reached: 0, reported: 0, silently_bypassed: 0, stuck: 0, not_reached: 1 });
  const noTrap = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')] });
  assert.equal(scoreSession({ result: noTrap, catalog, grading: { matches: [] }, decisions: {} }).traps, null);
});

// ---------- login (D) ----------

test('login success needs an authed api line below 400 after the login (the login route itself does not count)', () => {
  const ok = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], events: [
    ev('login_failed'), ev('login'), ev('api', { route: 'POST /api/auth/login', status: 200, authed: true }), ev('api', { route: 'GET /api/me', status: 200, authed: true }),
  ] });
  const a = scoreSession({ result: ok, catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(a.login, { success: true, logins: 1, expired_relogin: null });
  const only = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], events: [
    ev('api', { route: 'GET /api/me', status: 200, authed: true }), ev('login'), ev('api', { route: 'POST /api/auth/login', status: 200, authed: true }),
    ev('api', { route: 'GET /api/me', status: 401, authed: true }), ev('api', { route: 'GET /api/cart', status: 200, authed: false }),
  ] });
  assert.equal(scoreSession({ result: only, catalog, grading: { matches: [] }, decisions: {} }).login.success, false);
});

test('session trap: session_expired then login gives expired_relogin true, without login false', () => {
  const base = [ev('login'), ev('api', { route: 'GET /api/me', status: 200, authed: true }), ev('session_expired')];
  const re = makeSession({ catalog, seed: SEED, activate: [act('B04', 'bookings', 'all')], events: [...base, ev('login')] });
  const a = scoreSession({ result: re, catalog, grading: { matches: [] }, decisions: {} });
  assert.equal(a.login.expired_relogin, true);
  assert.equal(a.login.logins, 2);
  const no = makeSession({ catalog, seed: SEED, activate: [act('B04', 'bookings', 'all')], events: base });
  assert.equal(scoreSession({ result: no, catalog, grading: { matches: [] }, decisions: {} }).login.expired_relogin, false);
  const other = makeSession({ catalog, seed: SEED, activate: [act('B03', 'schedule', 'all')], events: [...base, ev('login')] });
  assert.equal(scoreSession({ result: other, catalog, grading: { matches: [] }, decisions: {} }).login.expired_relogin, null);
});

// ---------- humans, capture, cost ----------

test('human sessions only carry bugs, false alarms, duplicates, hit ids', () => {
  const result = makeSession({ catalog, seed: SEED, kind: 'human', slug: 'human-x', display: 'x', pkg: null,
    activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }], verdict: 'works' });
  const met = scoreSession({ result, catalog, grading: { matches: [m(0, 'B01')] }, decisions: {} });
  assert.equal(met.bugs.hits, 1);
  assert.deepEqual(met.hit_ids, ['B01']);
  for (const k of ['change', 'traps', 'login', 'capture', 'cost']) assert.equal(met[k], null, k);
});

test('capture sessions only carry capture and cost', () => {
  const result = makeSession({ catalog, seed: SEED, type: 'capture' });
  const met = scoreSession({ result, catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(met.capture, { valid: true, reason: null });
  assert.deepEqual(met.cost, { tokens: 5000, rounds: 12, calls: 2, wall_s: 120, cost_usd_list: [0.42] });
  for (const k of ['change', 'bugs', 'false_alarms', 'duplicates', 'traps', 'login']) assert.equal(met[k], null, k);
  assert.deepEqual(met.hit_ids, []);
});

test('explore agent sessions carry cost', () => {
  const met = scoreSession({ result: makeSession({ catalog, seed: SEED }), catalog, grading: { matches: [] }, decisions: {} });
  assert.deepEqual(met.cost, { tokens: 5000, rounds: 12, calls: 2, wall_s: 120, cost_usd_list: [0.42] });
  assert.equal(met.capture, null);
});

// ---------- buildGraderInput ----------

test('buildGraderInput: active bugs, distractors, sorted, same fields for all, only run_config decoys', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B06', 'profile', 'phone'), act('B03', 'schedule', 'all')],
    findings: [{ title: 't', where: '/p', viewport: 'phone', steps: 's', expected: 'e', actual: 'a' }] });
  const input = buildGraderInput({ result, catalog });
  const ids = input.bugs.map((b) => b.id);
  assert.ok(ids.includes('B06') && ids.includes('B03'));
  const distractors = ids.filter((id) => id !== 'B06' && id !== 'B03');
  assert.equal(distractors.length, 5);
  assert.deepEqual(ids, [...ids].sort());
  for (const b of input.bugs) assert.deepEqual(Object.keys(b).sort(), ['grader', 'id', 'station', 'symptom', 'title', 'width']);
  assert.deepEqual(input.bugs.find((b) => b.id === 'B06'), { id: 'B06', title: 'Bug six', symptom: 'Symptom six', grader: 'Grader six', station: 'profile', width: 'phone' });
  assert.deepEqual(input.decoys.map((d) => d.id), ['D01']);
  assert.deepEqual(Object.keys(input.decoys[0]).sort(), ['grader', 'id', 'station', 'title']);
  assert.deepEqual(input.findings, [{ i: 0, title: 't', where: '/p', viewport: 'phone', steps: 's', expected: 'e', actual: 'a' }]);
  assert.deepEqual(Object.keys(input).sort(), ['bugs', 'decoys', 'findings']);
  // deterministic
  assert.deepEqual(buildGraderInput({ result, catalog }), input);
});

test('buildGraderInput: a phone-only distractor always carries phone, never all', () => {
  let seen = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const result = makeSession({ catalog, seed, activate: [act('B03', 'schedule', 'all')] });
    const b01 = buildGraderInput({ result, catalog }).bugs.find((b) => b.id === 'B01');
    if (!b01) continue;
    seen++;
    assert.equal(b01.width, 'phone');
    assert.equal(b01.station, 'cart');
  }
  assert.ok(seen > 5, `B01 drawn as distractor ${seen} times`);
  // a multi-width distractor varies (its width comes from the draw, not a fixed field)
  const widths = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const result = makeSession({ catalog, seed, activate: [act('B03', 'schedule', 'all')] });
    const b05 = buildGraderInput({ result, catalog }).bugs.find((b) => b.id === 'B05');
    if (b05) widths.add(b05.width);
  }
  assert.deepEqual([...widths].sort(), ['desktop', 'tablet']);
});

test('buildGraderInput: unplanned without seeds always, with seeds only for that seed', () => {
  const cat = { ...catalog, unplanned: [
    { id: 'N01', title: 'New one', grader: 'G1', station: 'cart' },
    { id: 'N02', title: 'New two', grader: 'G2', station: 'home', seeds: [SEED] },
  ] };
  const inSeed = buildGraderInput({ result: makeSession({ catalog: cat, seed: SEED, activate: [] }), catalog: cat }).bugs.map((b) => b.id);
  assert.ok(inSeed.includes('N01') && inSeed.includes('N02'));
  const other = buildGraderInput({ result: makeSession({ catalog: cat, seed: SEED + 1, activate: [] }), catalog: cat }).bugs.map((b) => b.id);
  assert.ok(other.includes('N01'));
  assert.ok(!other.includes('N02'));
});

test('buildGraderInput scrubs the participant name and mcp__ tool names from findings', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [], findings: [{ title: 'Public Browser click via MCP__public-browser__click failed', actual: 'public-browser said no' }] });
  const f = buildGraderInput({ result, catalog }).findings[0];
  assert.equal(f.title, '[tool] click via [tool] failed');
  assert.equal(f.actual, '[tool] said no');
});

test('buildGraderInput throws when an active bug is missing from the catalog', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')] });
  const cat = { ...catalog, bugs: catalog.bugs.filter((b) => b.id !== 'B01') };
  assert.throws(() => buildGraderInput({ result, catalog: cat }), /B01/);
});

// ---------- runGrader ----------

const smallInput = { bugs: [{ id: 'B01', title: 't', symptom: 's', grader: 'g', station: 'cart', width: 'phone' }], decoys: [],
  findings: [{ i: 0, title: 'x', where: '', viewport: 'all', steps: '', expected: '', actual: '' }, { i: 1, title: 'y', where: '', viewport: 'all', steps: '', expected: '', actual: '' }] };

function claudeAnswer(matches, model = 'claude-sonnet-5-5') {
  return JSON.stringify({ type: 'result', result: '```json\n' + JSON.stringify({ matches }) + '\n```',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    total_cost_usd: 0.012, modelUsage: { [model]: { outputTokens: 5 } } });
}

test('runGrader default: isolated claude -p with empty cwd outside the repo', async () => {
  /** @type {any} */
  let seen = null;
  const spawn = async (file, args, opts) => {
    seen = { file, args, cwd: opts.cwd, cwdEntries: readdirSync(opts.cwd), input: opts.input, env: opts.env };
    const mcp = args[args.indexOf('--mcp-config') + 1];
    seen.mcpContent = JSON.parse(readFileSync(mcp, 'utf8'));
    seen.mcp = mcp;
    return { code: 0, stdout: claudeAnswer([m(0, 'B01', 'medium'), m(1, 'none', 'low')]), stderr: '' };
  };
  const out = await runGrader(smallInput, { spawn, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k' }, claudeBin: '/x/claude' });
  assert.equal(seen.file, '/x/claude');
  const a = seen.args;
  assert.ok(a.includes('-p'));
  assert.equal(a[a.indexOf('--model') + 1], GRADER_MODEL);
  assert.equal(GRADER_MODEL, 'sonnet');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(a[a.indexOf('--setting-sources') + 1], 'project');
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.deepEqual(seen.mcpContent, { mcpServers: {} });
  assert.deepEqual(seen.cwdEntries, []);
  const cwdReal = realpathSync(tmpdir());
  assert.ok(seen.cwd.startsWith(tmpdir()) || seen.cwd.startsWith(cwdReal), seen.cwd);
  assert.ok(!resolve(seen.cwd).startsWith(REPO + sep));
  assert.ok(!seen.mcp.startsWith(seen.cwd), 'mcp config must not sit in the empty cwd');
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(seen.input.includes('"findings"') && seen.input.includes('Answer with JSON only'));
  assert.deepEqual(out.matches.map((x) => [x.i, x.match, x.confidence]), [[0, 'B01', 'medium'], [1, 'none', 'low']]);
  assert.equal(out.model, 'claude-sonnet-5-5');
  assert.deepEqual(out.usage, { input_tokens: 130, output_tokens: 5, cost_usd: 0.012 });
  assert.deepEqual(out.flags, GRADER_FLAGS);
  assert.ok(!existsSync(seen.cwd), 'temp cwd removed afterwards');
});

test('runGrader refuses the agent model', async () => {
  const spawn = async () => ({ code: 0, stdout: claudeAnswer([m(0, 'none')], 'claude-opus-5-20261001'), stderr: '' });
  await assert.rejects(runGrader(smallInput, { spawn, env: {} }), /claude-opus-5/);
});

test('runGrader fills missing answers with none/low and ignores unknown indexes', async () => {
  const spawn = async () => ({ code: 0, stdout: claudeAnswer([m(1, 'B01'), m(7, 'B01'), m(1, 'D01')]), stderr: '' });
  const out = await runGrader(smallInput, { spawn, env: {} });
  assert.deepEqual(out.matches.map((x) => [x.i, x.match, x.confidence]), [[0, 'none', 'low'], [1, 'B01', 'high']]);
});

/** @returns {{ dir: string, env: Record<string, string> }} */
function cmdEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-grade-test-'));
  return { dir, env: { PATH: process.env.PATH, CODER_PARCOURS_GRADER_CMD: fakeCmd, FAKE_GRADER_COUNTER: join(dir, 'count'), ...extra } };
}
const calls = (dir) => Number(readFileSync(join(dir, 'count'), 'utf8'));

test('runGrader with CODER_PARCOURS_GRADER_CMD: prompt on stdin, usage zeros', async () => {
  const { dir, env } = cmdEnv({ FAKE_GRADER_DUMP: '' });
  env.FAKE_GRADER_DUMP = join(dir, 'prompt.txt');
  const input = { ...smallInput, findings: [{ ...smallInput.findings[0], title: 'match=B01 conf=low' }, smallInput.findings[1]] };
  const out = await runGrader(input, { env });
  assert.deepEqual(out.matches.map((x) => [x.i, x.match, x.confidence]), [[0, 'B01', 'low'], [1, 'none', 'high']]);
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  assert.equal(out.model, 'fake-grader');
  assert.ok(readFileSync(env.FAKE_GRADER_DUMP, 'utf8').includes('match=B01'));
  assert.equal(calls(dir), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('runGrader retries once on broken JSON', async () => {
  const { dir, env } = cmdEnv({ FAKE_GRADER_MODE: 'broken-once' });
  const out = await runGrader(smallInput, { env });
  assert.equal(out.matches.length, 2);
  assert.equal(calls(dir), 2);
  rmSync(dir, { recursive: true, force: true });
});

test('runGrader fails after the second broken answer', async () => {
  const { dir, env } = cmdEnv({ FAKE_GRADER_MODE: 'broken' });
  await assert.rejects(runGrader(smallInput, { env }), /JSON/);
  assert.equal(calls(dir), 2);
  rmSync(dir, { recursive: true, force: true });
});

test('runGrader with CMD refuses claude-opus-5', async () => {
  const { dir, env } = cmdEnv({ FAKE_GRADER_MODEL: 'claude-opus-5' });
  await assert.rejects(runGrader(smallInput, { env }), /claude-opus-5/);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- gradeRound / CLI ----------

function roundDir(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'cp-grade-round-'));
  mkdirSync(join(root, 'r1', 'sessions'), { recursive: true });
  for (const s of sessions) writeFileSync(join(root, 'r1', 'sessions', fileOf(s)), JSON.stringify(s));
  return root;
}

test('gradeRound writes valid graded files, reuses matches without recall, calls again with recall', async () => {
  const explore = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'match=B01' }, { title: 'match=B01' }] });
  const capture = makeSession({ catalog, seed: SEED, type: 'capture' });
  const root = roundDir([explore, capture]);
  const { dir, env } = cmdEnv();
  const deps = { env, catalog };
  const out = await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(out.length, 2);
  const g = JSON.parse(readFileSync(join(root, 'r1', 'graded', fileOf(explore)), 'utf8'));
  assert.deepEqual(validateGradedResult(g), []);
  assert.equal(g.metrics.bugs.hits, 1);
  assert.equal(g.metrics.duplicates, 1);
  assert.equal(g.grading.model, 'fake-grader');
  assert.match(g.grading.prompt_sha256, /^[0-9a-f]{64}$/);
  const gc = JSON.parse(readFileSync(join(root, 'r1', 'graded', fileOf(capture)), 'utf8'));
  assert.deepEqual(validateGradedResult(gc), []);
  assert.equal(gc.metrics.capture.valid, true);
  assert.equal(calls(dir), 1, 'capture sessions do not call the grader');
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(calls(dir), 1, 'existing matches reused');
  await gradeRound({ round: 'r1', resultsRoot: root, recall: true }, deps);
  assert.equal(calls(dir), 2);
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('gradeRound grades human sessions into valid graded files', async () => {
  const human = makeSession({ catalog, seed: SEED, kind: 'human', slug: 'human-x', display: 'x', pkg: null,
    activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'match=B01' }] });
  const root = roundDir([human]);
  const { dir, env } = cmdEnv();
  await gradeRound({ round: 'r1', resultsRoot: root }, { env, catalog });
  const g = JSON.parse(readFileSync(join(root, 'r1', 'graded', 'human-x-explore-seed' + SEED + '.json'), 'utf8'));
  assert.deepEqual(validateGradedResult(g), []);
  assert.deepEqual(g.metrics.hit_ids, ['B01']);
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('gradeRound skips the grader for sessions without findings', async () => {
  const root = roundDir([makeSession({ catalog, seed: SEED, activate: [] })]);
  const { dir, env } = cmdEnv();
  await gradeRound({ round: 'r1', resultsRoot: root }, { env, catalog });
  assert.ok(!existsSync(join(dir, 'count')));
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('CLI grade.mjs --round grades the round folder', () => {
  const pub = loadSeeds()[0];
  // CLI loads the catalog itself: use the fixture bugs (F01..F03) via the public dir variable
  const root = mkdtempSync(join(tmpdir(), 'cp-grade-cli-'));
  mkdirSync(join(root, 'r1', 'sessions'), { recursive: true });
  const fx = { bugs: [], decoys: [], unplanned: [], sources: { public: 0, secret: 0 } };
  const s = makeSession({ catalog: fx, seed: pub, activate: [], findings: [{ title: 'match=none' }] });
  writeFileSync(join(root, 'r1', 'sessions', fileOf(s)), JSON.stringify(s));
  const { dir, env } = cmdEnv();
  const empty = mkdtempSync(join(tmpdir(), 'cp-grade-empty-'));
  const r = spawnSync(process.execPath, [join(ROOT, 'harness', 'grade.mjs'), '--round', 'r1', '--results', root], {
    env: { ...env, CODER_PARCOURS_PUBLIC_DIR: empty }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, 'r1', 'graded', fileOf(s))));
  for (const d of [root, dir, empty]) rmSync(d, { recursive: true, force: true });
});

// ---------- Fix round 1: bug decisions, cumulative grader cost, decision keys ----------

test('decision "bug": overrides none and a decoy match for an active bug; ignored for an inactive bug', () => {
  const result = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }, { title: 'b' }] });
  const grading = { matches: [m(0, 'none'), m(1, 'D01')] };
  const k0 = keyOf(result, 0);
  const k1 = keyOf(result, 1);
  const base = scoreSession({ result, catalog, grading, decisions: {} });
  assert.deepEqual([base.bugs.hits, base.false_alarms.decoy, base.false_alarms.unreviewed], [0, 1, 1]);
  const on = scoreSession({ result, catalog, grading, decisions: { [k0]: { verdict: 'bug', id: 'B01' } } });
  assert.deepEqual([on.bugs.hits, on.false_alarms.unreviewed, on.hit_ids], [1, 0, ['B01']]);
  const over = scoreSession({ result, catalog, grading, decisions: { [k1]: { verdict: 'bug', id: 'B01' } } });
  assert.deepEqual([over.bugs.hits, over.false_alarms.decoy], [1, 0], 'a decoy match is corrected too');
  const dup = scoreSession({ result, catalog, grading, decisions: { [k0]: { verdict: 'bug', id: 'B01' }, [k1]: { verdict: 'bug', id: 'B01' } } });
  assert.deepEqual([dup.bugs.hits, dup.duplicates], [1, 1]);
  const off = scoreSession({ result, catalog, grading, decisions: { [k0]: { verdict: 'bug', id: 'B07' } } });
  assert.deepEqual([off.bugs.hits, off.false_alarms.unreviewed], [0, 1], 'B07 is not active in this session');
});

test('findingKey: same place + same text is stable, other text changes the key but keeps the place part', () => {
  const f = { title: 't', where: '/cart', viewport: 'all', steps: '', expected: '', actual: 'x' };
  const a = findingKey('s.json', 0, f);
  assert.equal(a, findingKey('s.json', 0, { ...f }));
  const b = findingKey('s.json', 0, { ...f, actual: 'y' });
  assert.notEqual(a, b);
  assert.equal(a.slice(0, 6), b.slice(0, 6));
  assert.notEqual(a.slice(0, 6), findingKey('s.json', 1, f).slice(0, 6));
});

const claudeCost = (stdout) => ({ code: 0, stdout, stderr: '' });
const ONE = { input_tokens: 130, output_tokens: 5, cost_usd: 0.012 };
const times = (n) => ({ input_tokens: ONE.input_tokens * n, output_tokens: ONE.output_tokens * n, cost_usd: +(ONE.cost_usd * n).toFixed(6) });
const roundOf = (r) => (s) => JSON.parse(readFileSync(join(r, 'r1', 'graded', fileOf(s)), 'utf8'));

test('grader cost is cumulative: recall adds, reuse keeps, a failed recall parks its cost, no findings keeps it', async () => {
  const explore = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'x' }] });
  const root = roundDir([explore]);
  const readG = roundOf(root);
  let mode = 'ok';
  const spawn = async () => claudeCost(mode === 'ok' ? claudeAnswer([m(0, 'B01')]) : JSON.stringify({ type: 'result', result: 'no json here',
    usage: { input_tokens: 130, output_tokens: 5 }, total_cost_usd: 0.012, modelUsage: { 'claude-sonnet-5-5': { outputTokens: 5 } } }));
  const deps = { env: { PATH: process.env.PATH }, claudeBin: '/x/claude', spawn, catalog, log: () => {} };
  const approx = (u, n) => { assert.equal(u.input_tokens, times(n).input_tokens); assert.equal(u.output_tokens, times(n).output_tokens); assert.ok(Math.abs(u.cost_usd - times(n).cost_usd) < 1e-9); };

  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  approx(readG(explore).grading.usage, 1);
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  approx(readG(explore).grading.usage, 1); // reuse: nothing new was spent
  await gradeRound({ round: 'r1', resultsRoot: root, recall: true }, deps);
  approx(readG(explore).grading.usage, 2); // --recall adds to the first call
  assert.equal(readG(explore).grading.calls.length, 2);

  mode = 'broken'; // both attempts of the grader call are paid for, then the call fails
  await assert.rejects(gradeRound({ round: 'r1', resultsRoot: root, recall: true }, deps), /no valid JSON/);
  approx(readG(explore).grading.usage, 2); // graded file untouched by the failure
  mode = 'ok';
  await gradeRound({ round: 'r1', resultsRoot: root, recall: true }, deps);
  const g = readG(explore).grading;
  approx(g.usage, 5); // 2 before + 2 failed attempts + 1
  assert.ok(!existsSync(join(root, 'r1', 'grading-spent.json')), 'parked cost is settled');
  const sum = g.calls.reduce((a, c) => ({ input_tokens: a.input_tokens + c.usage.input_tokens, output_tokens: a.output_tokens + c.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(sum, { input_tokens: g.usage.input_tokens, output_tokens: g.usage.output_tokens }, 'calls add up to usage');

  // the same session now without findings (replaced file): the grader is not called, the earlier cost stays
  const empty = { ...explore, report: { ...explore.report, normalized: { ...explore.report.normalized, findings: [] } } };
  writeFileSync(join(root, 'r1', 'sessions', fileOf(explore)), JSON.stringify(empty));
  await gradeRound({ round: 'r1', resultsRoot: root, recall: true }, deps);
  approx(readG(explore).grading.usage, 5);
  rmSync(root, { recursive: true, force: true });
});

test('decisions flow into the graded file; a decision whose finding changed is stale and not applied', async () => {
  const mk = (title) => makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title }] });
  const first = mk('old text');
  const root = roundDir([first]);
  const { dir, env } = cmdEnv();
  const logs = [];
  const deps = { env, catalog, log: (l) => logs.push(l) };
  mkdirSync(join(root, 'r1', 'review'), { recursive: true });
  const key = keyOf(first, 0);
  writeFileSync(join(root, 'r1', 'review', 'decisions.json'), JSON.stringify({ [key]: { verdict: 'false-alarm' } }));
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  const readG = roundOf(root);
  assert.deepEqual(readG(first).grading.decisions, { applied: [{ key, verdict: 'false-alarm' }], stale: [] });
  assert.equal(readG(first).metrics.false_alarms.decided, 1);

  const second = mk('a different finding at the same place');
  writeFileSync(join(root, 'r1', 'sessions', fileOf(second)), JSON.stringify(second));
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  const g = readG(second);
  assert.deepEqual(g.grading.decisions, { applied: [], stale: [key] });
  assert.deepEqual([g.metrics.false_alarms.decided, g.metrics.false_alarms.unreviewed], [0, 1], 'old decision does not hang on the new finding');
  assert.ok(logs.some((l) => l.includes(key) && /stale/.test(l)));
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// (Schritt 6: Code behoben, Test aktiv.) Frueher: grade.mjs gradeRound wrote grading-spent.json only on the grader-failure path
// and at the very end. When a later session throws for another reason (here: a file whose name does not match its content),
// the settled posting of the first session stays in the file on disk although graded/ already carries its cost: the next
// round report counts it twice. Un-skip when saveSpent() runs in a finally block.
test('a paid posting is settled on disk even when a later session throws for another reason', async () => {
  const explore = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'x' }] });
  const root = roundDir([explore]);
  let mode = 'broken';
  const spawn = async () => claudeCost(mode === 'ok' ? claudeAnswer([m(0, 'B01')]) : JSON.stringify({ type: 'result', result: 'no json here',
    usage: { input_tokens: 130, output_tokens: 5 }, total_cost_usd: 0.012, modelUsage: { 'claude-sonnet-5-5': { outputTokens: 5 } } }));
  const deps = { env: { PATH: process.env.PATH }, claudeBin: '/x/claude', spawn, catalog, log: () => {} };
  const spentFile = join(root, 'r1', 'grading-spent.json');
  await assert.rejects(gradeRound({ round: 'r1', resultsRoot: root }, deps), /no valid JSON/);
  assert.ok(existsSync(spentFile), 'the failed call parked its cost');
  // A second file whose name does not match its content: sorted after the first, it throws after the first was regraded.
  writeFileSync(join(root, 'r1', 'sessions', 'zzz-wrong-name.json'), JSON.stringify(explore));
  mode = 'ok';
  await assert.rejects(gradeRound({ round: 'r1', resultsRoot: root, recall: true }, deps), /does not match its content/);
  const g = JSON.parse(readFileSync(join(root, 'r1', 'graded', fileOf(explore)), 'utf8')).grading;
  assert.ok(g.usage.input_tokens > 130, 'positive: the first session carries the parked cost in graded/');
  assert.ok(!existsSync(spentFile), 'the posting that graded/ already carries is gone from grading-spent.json');
  rmSync(root, { recursive: true, force: true });
});

// (Schritt 6: Code behoben, Test aktiv.) Frueher: REF_PATTERNS ('@e\d+', 'uid=...') have no word boundary, so harmless finding text
// loses detail for the grader ("foo@e2e.com" -> "foo[tool]e.com", "guid=abc" -> "g[tool]"). Un-skip when the patterns
// only match whole references.
test('scrubber: tool refs are replaced, mail addresses and url parameters that merely contain them are not', async () => {
  const { makeScrubber } = await import('./grade.mjs');
  const scrub = makeScrubber([]);
  assert.equal(scrub('click @e12 then uid=1_4'), 'click [tool] then [tool]', 'positive: real refs vanish');
  assert.equal(scrub('mail foo@e2e.com failed'), 'mail foo@e2e.com failed');
  assert.equal(scrub('url ?guid=abc'), 'url ?guid=abc');
  assert.equal(scrub('url ?uid=5'), 'url ?uid=5');
});

// ---------- grader cost over a retry, model choice, reuse after changed findings, hit rate without active bugs ----------

test('runGrader adds the usage of a broken first attempt to the retry (both are paid)', async () => {
  let n = 0;
  const spawn = async () => {
    n++;
    const stdout = n === 1
      ? JSON.stringify({ type: 'result', result: 'no json here', usage: { input_tokens: 130, output_tokens: 5 }, total_cost_usd: 0.012, modelUsage: { 'claude-sonnet-5-5': { outputTokens: 5 } } })
      : claudeAnswer([m(0, 'B01'), m(1, 'none')]);
    return { code: 0, stdout, stderr: '' };
  };
  const out = await runGrader(smallInput, { spawn, env: {}, claudeBin: '/x/claude' });
  assert.equal(n, 2);
  assert.equal(out.usage.input_tokens, 260);
  assert.equal(out.usage.output_tokens, 10);
  assert.ok(Math.abs(out.usage.cost_usd - 0.024) < 1e-9);
});

test('runGrader names the model with the most output tokens, then outer.model, then the alias', async () => {
  const answer = (outer) => async () => ({
    code: 0, stderr: '',
    stdout: JSON.stringify({ type: 'result', result: JSON.stringify({ matches: [m(0, 'none'), m(1, 'none')] }), usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0, ...outer }),
  });
  const model = async (outer) => (await runGrader(smallInput, { spawn: answer(outer), env: {}, claudeBin: '/x/claude' })).model;
  assert.equal(await model({ modelUsage: { 'claude-haiku-4-5': { outputTokens: 2 }, 'claude-sonnet-5-5': { outputTokens: 9 } } }), 'claude-sonnet-5-5');
  assert.equal(await model({ modelUsage: { 'claude-sonnet-5-5': { outputTokens: 2 }, 'claude-haiku-4-5': { outputTokens: 9 } } }), 'claude-haiku-4-5', 'not just the first or the last');
  assert.equal(await model({ model: 'claude-custom-1' }), 'claude-custom-1');
  assert.equal(await model({}), GRADER_MODEL);
});

test('gradeRound regrades without --recall when the findings or the run configuration of a session changed', async () => {
  const explore = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'match=B01' }] });
  const root = roundDir([explore]);
  const { dir, env } = cmdEnv();
  const deps = { env, catalog, log: () => {} };
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(calls(dir), 1, 'unchanged findings: reused');
  const changed = JSON.parse(readFileSync(join(root, 'r1', 'sessions', fileOf(explore)), 'utf8'));
  changed.report.normalized.findings[0].title = 'match=B01 and something else';
  writeFileSync(join(root, 'r1', 'sessions', fileOf(explore)), JSON.stringify(changed));
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(calls(dir), 2, 'changed finding text: graded again');
  const other = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone'), act('B03', 'schedule', 'all')], findings: [{ title: 'match=B01 and something else' }] });
  assert.equal(fileOf(other), fileOf(explore), 'same session file, other run configuration');
  assert.notEqual(other.session.run_config_sha256, explore.session.run_config_sha256);
  writeFileSync(join(root, 'r1', 'sessions', fileOf(explore)), JSON.stringify(other));
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(calls(dir), 3, 'changed run configuration: graded again');
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('scoreSession: without counted active bugs the hit rate is null, not 0 and not NaN', () => {
  const none = makeSession({ catalog, seed: SEED, activate: [], findings: [{ title: 'a' }] });
  const met = scoreSession({ result: none, catalog, grading: { matches: [m(0, 'none')] }, decisions: {} });
  assert.equal(met.bugs.active, 0);
  assert.equal(met.bugs.hit_rate, null);
  const some = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'a' }] });
  assert.equal(scoreSession({ result: some, catalog, grading: { matches: [m(0, 'none')] }, decisions: {} }).bugs.hit_rate, 0, 'Gegenprobe: with an active bug and no hit it is 0');
});

test('gradeRound regrades without --recall when the grader prompt changed since the stored grading (and reuses with the same prompt)', async () => {
  const explore = makeSession({ catalog, seed: SEED, activate: [act('B01', 'cart', 'phone')], findings: [{ title: 'match=B01' }] });
  const root = roundDir([explore]);
  const { dir, env } = cmdEnv();
  const deps = { env, catalog, log: () => {}, promptText: 'grader prompt one' };
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  await gradeRound({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(calls(dir), 1, 'same prompt: reused');
  await gradeRound({ round: 'r1', resultsRoot: root }, { ...deps, promptText: 'grader prompt two' });
  assert.equal(calls(dir), 2, 'changed prompt: graded again');
  const g = JSON.parse(readFileSync(join(root, 'r1', 'graded', fileOf(explore)), 'utf8')).grading;
  assert.equal(g.prompt_sha256, createHash('sha256').update('grader prompt two').digest('hex'));
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('trap: a replayed beacon (same event many times) counts once', () => {
  const once = [ev('bug', { bug: 'B03', event: 'reached' }), ev('bug', { bug: 'B03', event: 'passed' })];
  const replay = [...once, ...once, ...once];
  const mk = (events) => scoreSession({ result: makeSession({ catalog, seed: SEED, activate: [act('B03', 'schedule', 'all')], events }), catalog, grading: { matches: [] }, decisions: {} }).traps;
  assert.deepEqual(mk(replay), mk(once));
  assert.deepEqual(mk(replay), { reached: 1, reported: 0, silently_bypassed: 1, stuck: 0, not_reached: 0 }, 'positive: the replay is not empty');
});

test('R5 S5: cost fuehrt text_chars und images aus dem Ledger, nur wenn jeder Eintrag text_chars hat', () => {
  const base = makeSession({ catalog, seed: SEED });
  const cost = (ledger) => scoreSession({ result: { ...base, harness: { ...base.harness, calls_ledger: ledger } }, catalog, grading: { matches: [] }, decisions: {} }).cost;
  const c = cost([{ i: 1, tool: 'a', chars: 99999, text_chars: 120, images: 2 }, { i: 2, tool: 'b', chars: 10, text_chars: 10, images: 0 }]);
  assert.equal(c.text_chars, 130);
  assert.equal(c.images, 2);
  assert.equal(c.calls, 2);
  const old = cost([{ i: 1, tool: 'a', chars: 99999 }, { i: 2, tool: 'b', chars: 10, text_chars: 10 }]);
  assert.equal('text_chars' in old, false, 'Gegenprobe: gemischtes Ledger liefert keine Teilsumme');
});
