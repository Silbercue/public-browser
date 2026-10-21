import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  const key = findingKey(fileOf(result), 0);
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
