import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importHumanReports } from './human-import.mjs';
import { loadCatalog } from '../catalog/load.mjs';
import { buildRunConfig, runConfigSha } from './seed.mjs';
import { validateSessionResult } from './result-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'fixtures', 'grader', 'human-reports.jsonl');
const cat = () => loadCatalog({ publicDir: 'fixtures/bugs' });

function setup(gitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'cp-human-'));
  const gitCalls = [];
  const errs = [];
  const deps = {
    resultsRoot: root,
    loadCatalog: cat,
    git: async (args) => { gitCalls.push(args); return { code: gitCode }; },
    stderr: (l) => errs.push(l),
  };
  return { root, deps, gitCalls, errs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('two testers give two session files with normalized names in the round folder', async () => {
  const { root, deps, gitCalls, errs, cleanup } = setup(0);
  const paths = await importHumanReports({ reportsJsonl: REPORTS, round: 'r1' }, deps);
  const dir = join(root, 'r1', 'sessions');
  assert.deepEqual(readdirSync(dir).sort(), ['human-anna-m-ller-explore-seed2601.json', 'human-x-explore-seed2601.json']);
  assert.deepEqual([...paths].sort(), readdirSync(dir).sort().map((n) => join(dir, n)));
  const x = JSON.parse(readFileSync(join(dir, 'human-x-explore-seed2601.json'), 'utf8'));
  assert.deepEqual(validateSessionResult(x), []);
  assert.equal(x.participant.kind, 'human');
  assert.equal(x.participant.slug, 'human-x');
  const expected = buildRunConfig({ seed: 2601, sessionType: 'explore', catalog: await cat() });
  assert.deepEqual(x.session.run_config, expected);
  assert.equal(x.session.run_config_sha256, runConfigSha(expected));
  assert.equal(x.session.hosted_commit, 'abc1234');
  const f = x.report.normalized.findings;
  assert.equal(f.length, 2);
  assert.equal(f[0].viewport, 'phone');
  assert.equal(f[1].viewport, 'desktop');
  assert.equal(f[0].where, '/cart');
  assert.equal(f[0].title.length, 80);
  assert.ok(f[0].actual.startsWith(f[0].title) && f[0].actual.length > 80);
  assert.equal(f[1].title, 'Second report from x');
  assert.deepEqual(x.events, []);
  assert.deepEqual(gitCalls[0], ['diff', '--quiet', 'abc1234', 'HEAD', '--',
    'coder-parcours/bugs', 'coder-parcours/catalog', 'coder-parcours/harness/seed.mjs', 'coder-parcours/harness/seeds.json']);
  assert.deepEqual(x.notes, []);
  assert.deepEqual(errs, []);
  const anna = JSON.parse(readFileSync(join(dir, 'human-anna-m-ller-explore-seed2601.json'), 'utf8'));
  assert.equal(anna.report.normalized.findings[0].viewport, 'tablet');
  cleanup();
});

test('changed catalog since the hosted commit gives a warning in notes and on stderr', async () => {
  const { root, deps, errs, cleanup } = setup(1);
  await importHumanReports({ reportsJsonl: REPORTS, round: 'r1' }, deps);
  const x = JSON.parse(readFileSync(join(root, 'r1', 'sessions', 'human-x-explore-seed2601.json'), 'utf8'));
  assert.equal(x.notes.length, 1);
  assert.match(x.notes[0], /catalog changed/i);
  assert.ok(errs.some((l) => /catalog changed/i.test(l)));
  assert.deepEqual(validateSessionResult(x), []);
  cleanup();
});

test('missing commit gives a warning and hosted_commit null', async () => {
  const { root, deps, gitCalls, cleanup } = setup(0);
  const file = join(root, 'reports.jsonl');
  writeFileSync(file, JSON.stringify({ t: '2026-10-21T10:00:00.000Z', sb: 's', seed: 2602, commit: null, text: 'x', path: '/', viewportPx: 390, tester: 'bo' }) + '\n');
  await importHumanReports({ reportsJsonl: file, round: 'r1' }, deps);
  const s = JSON.parse(readFileSync(join(root, 'r1', 'sessions', 'human-bo-explore-seed2602.json'), 'utf8'));
  assert.equal(s.session.hosted_commit, null);
  assert.match(s.notes[0], /commit/i);
  assert.equal(gitCalls.length, 0);
  cleanup();
});

test('a seed outside seeds.json is refused clearly and nothing is written; a known seed passes', async () => {
  const { root, deps, cleanup } = setup(0);
  const file = join(root, 'reports.jsonl');
  const row = (seed) => JSON.stringify({ t: '2026-10-21T10:00:00.000Z', sb: 's', seed, commit: null, text: 'something', path: '/', viewportPx: 390, tester: 'bo' });
  writeFileSync(file, `${row(2602)}\n${row(4242)}\n`);
  await assert.rejects(importHumanReports({ reportsJsonl: file, round: 'r1' }, deps), /line 2.*4242.*not one of the seeds/);
  assert.throws(() => readdirSync(join(root, 'r1', 'sessions')), 'nothing written before the check');
  writeFileSync(file, `${row(2602)}\n`);
  const written = await importHumanReports({ reportsJsonl: file, round: 'r1' }, deps);
  assert.equal(written.length, 1);
  cleanup();
});

const row = (o) => JSON.stringify({ t: '2026-10-21T10:00:00.000Z', sb: 's', seed: 2602, commit: null, text: 'something', path: '/', viewportPx: 390, tester: 'bo', ...o });

test('unusable lines are skipped with a warning each; the usable line is still imported', async () => {
  const { root, deps, errs, cleanup } = setup(0);
  const file = join(root, 'reports.jsonl');
  writeFileSync(file, [
    'this is not json',
    row({ seed: 'abc' }),
    row({ text: '   ' }),
    row({ text: undefined }),
    '',
    row({ text: 'the one good report' }),
  ].join('\n') + '\n');
  const written = await importHumanReports({ reportsJsonl: file, round: 'r1' }, deps);
  assert.equal(written.length, 1);
  const s = JSON.parse(readFileSync(written[0], 'utf8'));
  assert.deepEqual(s.report.normalized.findings.map((f) => f.actual), ['the one good report']);
  assert.equal(errs.filter((l) => /skipped/.test(l)).length, 4, 'one warning per unusable line');
  assert.ok(errs.some((l) => /line 1 is not JSON/.test(l)));
  assert.ok(errs.some((l) => /line 2 has no integer seed/.test(l)));
  assert.ok(errs.some((l) => /line 3 has no text/.test(l)));
  assert.ok(errs.some((l) => /line 4 has no text/.test(l)));
  cleanup();
});

test('several commits in one tester session: the earliest report decides, the others are named in notes; git is asked once per commit', async () => {
  const { root, deps, gitCalls, cleanup } = setup(0);
  const file = join(root, 'reports.jsonl');
  writeFileSync(file, [
    row({ t: '2026-10-21T12:00:00.000Z', commit: 'bbbb222', text: 'later' }),
    row({ t: '2026-10-21T09:00:00.000Z', commit: 'aaaa111', text: 'earlier' }),
  ].join('\n') + '\n');
  const [out] = await importHumanReports({ reportsJsonl: file, round: 'r1' }, deps);
  const s = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(s.session.hosted_commit, 'aaaa111');
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /several commits \(aaaa111, bbbb222\); using aaaa111/);
  assert.deepEqual(s.report.normalized.findings.map((f) => f.actual), ['earlier', 'later'], 'findings in time order');
  assert.equal(gitCalls.length, 1);
  assert.equal(gitCalls[0][2], 'aaaa111');
  cleanup();
});

test('git exit code other than 0 and 1 gives a "could not compare" note, 0 gives none; blank testers share human-anonymous', async () => {
  /** @type {Array<[number, RegExp|null]>} */
  const cases = [[2, /could not compare the catalog with hosted commit abc1234 \(git exit 2\)/], [0, null]];
  for (const [code, expectNote] of cases) {
    const { root, deps, cleanup } = setup(code);
    const file = join(root, 'reports.jsonl');
    writeFileSync(file, [row({ commit: 'abc1234', tester: '', text: 'one' }), row({ commit: 'abc1234', tester: undefined, text: 'two' })].join('\n') + '\n');
    const written = await importHumanReports({ reportsJsonl: file, round: 'r1' }, deps);
    assert.equal(written.length, 1, 'both reports end up in one session');
    assert.match(written[0], /human-anonymous-explore-seed2602\.json$/);
    const s = JSON.parse(readFileSync(written[0], 'utf8'));
    assert.equal(s.report.normalized.findings.length, 2);
    if (expectNote) assert.match(s.notes.join('\n'), expectNote); else assert.deepEqual(s.notes, []);
    cleanup();
  }
});
