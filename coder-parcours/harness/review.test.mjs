import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingReview, applyReview, sampleReview, agreementReview } from './review.mjs';
import { gradeRound, findingKey } from './grade.mjs';
import { fixtureCatalog, makeSession } from '../fixtures/grader/build.mjs';
import { loadSeeds } from './seed.mjs';
import { sessionFileName } from './result-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(ROOT, 'fixtures', 'grader', 'fake-grader.mjs');
const [SEED_A, SEED_B] = loadSeeds();
const act = (id, station, width) => ({ id, station, width });
const fileOf = (s) => sessionFileName({ slug: s.participant.slug, type: s.session.type, seed: s.session.seed });

const PARTS = [
  { slug: 'public-browser', display: 'Public Browser', pkg: 'public-browser' },
  { slug: 'agent-browser', display: 'agent-browser (dogfood skill)', pkg: 'agent-browser' },
  { slug: 'playwright-cli', display: 'Playwright CLI', pkg: '@playwright/cli' },
];

/** Sets up a graded round with three participants and open findings that name tools. */
/** @param {{ sessions?: any[] }} [opts] */
async function setupRound({ sessions } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cp-review-'));
  const work = mkdtempSync(join(tmpdir(), 'cp-review-work-'));
  const unplannedFile = join(work, 'unplanned.json');
  writeFileSync(unplannedFile, '[]');
  const base = fixtureCatalog();
  const catalog = { ...base };
  const list = sessions ?? PARTS.map((p, n) => makeSession({
    catalog, seed: n === 2 ? SEED_B : SEED_A, slug: p.slug, display: p.display, pkg: p.pkg,
    activate: [act('B01', 'cart', 'phone')],
    findings: [
      { title: `open one from ${p.display}`, actual: `used mcp__${p.slug}__click and ${p.slug} snapshot`, steps: `MCP__X__y then ${p.pkg}` },
      { title: 'open two', where: '/schedule' },
      { title: 'match=B01 conf=low', actual: 'buttons tiny' },
      { title: 'match=D01 conf=high', actual: 'decoy thing' },
    ],
  }));
  mkdirSync(join(root, 'r1', 'sessions'), { recursive: true });
  for (const s of list) writeFileSync(join(root, 'r1', 'sessions', fileOf(s)), JSON.stringify(s));
  const counter = join(work, 'count');
  const env = { PATH: process.env.PATH, CODER_PARCOURS_GRADER_CMD: `"${process.execPath}" "${FAKE}"`, FAKE_GRADER_COUNTER: counter };
  const deps = {
    env,
    loadCatalog: async () => ({ ...base, unplanned: JSON.parse(readFileSync(unplannedFile, 'utf8')) }),
    unplannedFile,
    log: () => {},
  };
  await gradeRound({ round: 'r1', resultsRoot: root }, { ...deps, catalog: await deps.loadCatalog() });
  const cleanup = () => { rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); };
  const calls = () => Number(readFileSync(counter, 'utf8'));
  return { root, deps, list, unplannedFile, cleanup, calls };
}

function assertBlind(text, list) {
  for (const s of list) {
    assert.ok(!text.toLowerCase().includes(s.participant.slug.toLowerCase()), `slug ${s.participant.slug} leaked`);
    assert.ok(!text.includes(s.participant.display), `display ${s.participant.display} leaked`);
    if (s.participant.package) assert.ok(!text.includes(s.participant.package), `package leaked`);
    assert.ok(!text.includes(fileOf(s)), 'file name leaked');
    assert.ok(!text.includes(fileOf(s).replace(/\.json$/, '')), 'file stem leaked');
  }
  assert.ok(!/mcp__/i.test(text), 'mcp__ leaked');
}

test('pending: blinded open findings in shuffled order', async () => {
  const { root, deps, list, cleanup } = await setupRound();
  const out = await pendingReview({ round: 'r1', resultsRoot: root }, deps);
  const text = readFileSync(join(root, 'r1', 'review', 'pending.json'), 'utf8');
  const pending = JSON.parse(text);
  assert.equal(out, join(root, 'r1', 'review', 'pending.json'));
  assert.equal(pending.length, 6, '2 open findings x 3 sessions');
  for (const p of pending) assert.deepEqual(Object.keys(p).sort(), ['actual', 'expected', 'finding_key', 'seed', 'steps', 'title', 'viewport', 'where']);
  assertBlind(text, list);
  assert.ok(text.includes('[tool]'), 'names replaced, not dropped');
  assert.ok(text.includes('snapshot'), 'rest of the text kept');
  // natural order = the order in which the session files are read (sorted by name)
  const natural = [...list].sort((x, y) => (fileOf(x) < fileOf(y) ? -1 : 1)).flatMap((s) => [findingKey(fileOf(s), 0), findingKey(fileOf(s), 1)]);
  assert.deepEqual([...pending.map((p) => p.finding_key)].sort(), [...natural].sort());
  assert.notDeepEqual(pending.map((p) => p.finding_key), natural);
  cleanup();
});

test('pending leaves out findings Julian already decided (also new bugs not yet applied)', async () => {
  const { root, deps, list, cleanup } = await setupRound();
  const key = findingKey(fileOf(list[0]), 0);
  const key2 = findingKey(fileOf(list[1]), 0);
  mkdirSync(join(root, 'r1', 'review'), { recursive: true });
  writeFileSync(join(root, 'r1', 'review', 'decisions.json'), JSON.stringify({
    [key]: { verdict: 'false-alarm' },
    [key2]: { verdict: 'new-bug', id: 'N05', title: 't', station: 'cart', grader: 'g' },
  }));
  await pendingReview({ round: 'r1', resultsRoot: root }, deps);
  const keys = JSON.parse(readFileSync(join(root, 'r1', 'review', 'pending.json'), 'utf8')).map((p) => p.finding_key);
  assert.equal(keys.length, 4);
  assert.ok(!keys.includes(key));
  assert.ok(!keys.includes(key2));
  assert.ok(keys.includes(findingKey(fileOf(list[0]), 1)));
  cleanup();
});

const readGraded = (root, s) => JSON.parse(readFileSync(join(root, 'r1', 'graded', fileOf(s)), 'utf8'));

test('apply: new-bug with seeds turns the open finding into a hit only in sessions of that seed', async () => {
  const catalog = fixtureCatalog();
  const mk = (slug, seed, title) => makeSession({ catalog, seed, slug, display: slug, pkg: slug, activate: [act('B01', 'cart', 'phone')], findings: [{ title }] });
  const a = mk('p-a', SEED_A, 'open finding');
  const c = mk('p-c', SEED_A, 'match=N01');
  const b = mk('p-b', SEED_B, 'match=N01');
  const { root, deps, unplannedFile, cleanup, calls } = await setupRound({ sessions: [a, b, c] });
  assert.equal(calls(), 3);
  for (const s of [a, b, c]) assert.equal(readGraded(root, s).metrics.false_alarms.unreviewed, 1);
  const key = findingKey(fileOf(a), 0);
  mkdirSync(join(root, 'r1', 'review'), { recursive: true });
  writeFileSync(join(root, 'r1', 'review', 'decisions.json'), JSON.stringify({
    [key]: { verdict: 'new-bug', id: 'N01', title: 'New bug', station: 'cart', grader: 'Counts when ...', seeds: [SEED_A] },
  }));
  await applyReview({ round: 'r1', resultsRoot: root }, deps);
  assert.equal(calls(), 6, 'apply regrades every session with a fresh grader call');
  assert.deepEqual(JSON.parse(readFileSync(unplannedFile, 'utf8')), [{ id: 'N01', title: 'New bug', grader: 'Counts when ...', station: 'cart', seeds: [SEED_A] }]);
  const ga = readGraded(root, a).metrics;
  assert.deepEqual(ga.hit_ids, ['N01']);
  assert.equal(ga.false_alarms.unreviewed, 0);
  assert.equal(ga.bugs.active, 2);
  assert.deepEqual(readGraded(root, c).metrics.hit_ids, ['N01'], 'other session of the same seed matched after recall');
  const gb = readGraded(root, b).metrics;
  assert.deepEqual(gb.hit_ids, []);
  assert.equal(gb.false_alarms.unreviewed, 1);
  assert.equal(gb.bugs.active, 1);
  cleanup();
});

test('apply: new-bug without seeds counts in every seed', async () => {
  const catalog = fixtureCatalog();
  const a = makeSession({ catalog, seed: SEED_A, slug: 'p-a', display: 'p-a', pkg: 'p-a', activate: [], findings: [{ title: 'open finding' }] });
  const b = makeSession({ catalog, seed: SEED_B, slug: 'p-b', display: 'p-b', pkg: 'p-b', activate: [], findings: [{ title: 'match=N01' }] });
  const { root, deps, cleanup } = await setupRound({ sessions: [a, b] });
  mkdirSync(join(root, 'r1', 'review'), { recursive: true });
  writeFileSync(join(root, 'r1', 'review', 'decisions.json'), JSON.stringify({
    [findingKey(fileOf(a), 0)]: { verdict: 'new-bug', id: 'N01', title: 'New bug', station: 'cart', grader: 'g' },
  }));
  await applyReview({ round: 'r1', resultsRoot: root }, deps);
  assert.deepEqual(readGraded(root, a).metrics.hit_ids, ['N01']);
  assert.deepEqual(readGraded(root, b).metrics.hit_ids, ['N01']);
  cleanup();
});

test('apply rejects unknown keys and invalid new bugs', async () => {
  const { root, deps, list, cleanup } = await setupRound();
  mkdirSync(join(root, 'r1', 'review'), { recursive: true });
  const file = join(root, 'r1', 'review', 'decisions.json');
  writeFileSync(file, JSON.stringify({ deadbeef0000: { verdict: 'false-alarm' } }));
  await assert.rejects(applyReview({ round: 'r1', resultsRoot: root }, deps), /deadbeef0000/);
  writeFileSync(file, JSON.stringify({ [findingKey(fileOf(list[0]), 0)]: { verdict: 'new-bug', id: 'B01', title: 't', station: 'cart', grader: 'g' } }));
  await assert.rejects(applyReview({ round: 'r1', resultsRoot: root }, deps), /B01/);
  cleanup();
});

test('sample: blinded, prefers low confidence, shows finding and catalog entry', async () => {
  const { root, deps, list, cleanup } = await setupRound();
  // matched findings: 3 x B01 (low) + 3 x D01 (high)
  const out = await sampleReview({ round: 'r1', resultsRoot: root, n: 4 }, deps);
  const md = readFileSync(out, 'utf8');
  assertBlind(md, list);
  const keys = [...md.matchAll(/^## ([0-9a-f]{12})$/gm)].map((x) => x[1]);
  assert.equal(keys.length, 4);
  const lowKeys = list.map((s) => findingKey(fileOf(s), 2));
  for (const k of lowKeys) assert.ok(keys.includes(k), 'every low match sampled first');
  assert.ok(md.includes('Grader one') && md.includes('buttons tiny'));
  const matched = list.flatMap((s) => [2, 3].map((i) => findingKey(fileOf(s), i)));
  for (const k of keys) assert.ok(matched.includes(k), 'only matched findings are sampled');
  assert.equal(new Set(keys).size, 4);
  cleanup();
});

test('agreement counts agree and disagree', async () => {
  const { root, deps, cleanup } = await setupRound();
  mkdirSync(join(root, 'r1', 'review'), { recursive: true });
  writeFileSync(join(root, 'r1', 'review', 'sample-verdicts.json'), JSON.stringify({ a1: 'agree', a2: 'agree', a3: 'disagree', a4: 'agree', a5: 'maybe' }));
  const lines = [];
  const res = await agreementReview({ round: 'r1', resultsRoot: root }, { ...deps, log: (l) => lines.push(l) });
  assert.deepEqual({ agree: res.agree, disagree: res.disagree, n: res.n }, { agree: 3, disagree: 1, n: 4 });
  assert.ok(lines.join('\n').includes('3/4'));
  assert.ok(lines.join('\n').includes('a5'), 'invalid entries are named');
  cleanup();
});
