import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTokenReport, planRound, runRound, writeTokenReport } from './round.mjs';
import { sessionFileName } from './result-schema.mjs';

const SLUGS = ['a', 'b', 'c', 'd'];
const SEEDS = [11, 12, 13, 14, 15];
const TYPES = ['explore', 'capture'];

test('planRound: 5 Seeds x 4 x 2 = 40, keine Dopplung, Rotation je Seed, erst explore dann capture', () => {
  const plan = planRound({ seeds: SEEDS, participants: SLUGS, types: TYPES });
  assert.equal(plan.length, 40);
  assert.equal(new Set(plan.map((p) => `${p.slug}/${p.type}/${p.seed}`)).size, 40);
  const seed1 = plan.filter((p) => p.seed === 11);
  assert.deepEqual(seed1.map((p) => `${p.type}:${p.slug}`), ['explore:a', 'explore:b', 'explore:c', 'explore:d', 'capture:a', 'capture:b', 'capture:c', 'capture:d']);
  assert.deepEqual(plan.filter((p) => p.seed === 12).slice(0, 4).map((p) => p.slug), ['b', 'c', 'd', 'a']);
  assert.deepEqual(plan.filter((p) => p.seed === 13).slice(0, 4).map((p) => p.slug), ['c', 'd', 'a', 'b']);
  assert.deepEqual(plan.map((p) => p.seed), SEEDS.flatMap((s) => Array(8).fill(s)));
});

function setup() {
  const resultsRoot = mkdtempSync(join(tmpdir(), 'cp-round-'));
  return { resultsRoot, done: () => rmSync(resultsRoot, { recursive: true, force: true }) };
}

/** Fake-runSession: schreibt eine Datei nach sessions/ (oder aborted/) und merkt sich die Aufrufe. 
 * @param {string} resultsRoot
 * @param {{ models?: (n: number) => string, abortAt?: number[], log?: any[], onCall?: (n: number, o: any) => void }} [cfg]
 */
function fakeRun(resultsRoot, { models = () => "claude-opus-5-1", abortAt = [], log = [], onCall } = {}) {
  return async (/** @type {any} */ opts) => {
    log.push(opts);
    onCall?.(log.length, opts);
    const n = log.length;
    const status = abortAt.includes(n) ? 'aborted' : 'ok';
    const result = { participant: { slug: opts.slug, kind: 'mcp' }, session: { type: opts.type, seed: opts.seed, round: opts.round }, status, model: models(n) };
    const dir = join(resultsRoot, opts.round, status === 'aborted' ? 'aborted' : 'sessions');
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, sessionFileName(opts));
    writeFileSync(outPath, JSON.stringify(result));
    return { result, outPath };
  };
}

const quiet = { log: () => {}, stderr: () => {}, fingerprint: () => ({ grader_prompt_sha256: 'g', budgets: {} }), commit: () => 'abc123', now: () => '2026-10-21T10:00:00.000Z' };

test('--probe plant nur den ersten Seed: 8 Sitzungen, nacheinander', async () => {
  const { resultsRoot, done } = setup();
  try {
    const calls = [];
    let running = 0;
    let maxRunning = 0;
    const runSession = async (o) => {
      running++; maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return fakeRun(resultsRoot, { log: calls })(o);
    };
    const out = await runRound({ round: 'r1', probe: true, participants: SLUGS, types: TYPES, seeds: SEEDS, resultsRoot }, { ...quiet, runSession });
    assert.equal(calls.length, 8);
    assert.deepEqual([...new Set(calls.map((c) => c.seed))], [11]);
    assert.equal(maxRunning, 1);
    assert.equal(out.ran, 8);
    assert.ok(calls.every((c) => c.round === 'r1' && c.replace === false));
  } finally { done(); }
});

test('--participants und --types schraenken ein; ohne --probe laufen alle Seeds', async () => {
  const { resultsRoot, done } = setup();
  try {
    const calls = [];
    await runRound({ round: 'r2', participants: ['a', 'c'], types: ['explore'], seeds: SEEDS, resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: calls }) });
    assert.equal(calls.length, 10);
    assert.deepEqual([...new Set(calls.map((c) => c.slug))].sort(), ['a', 'c']);
  } finally { done(); }
});

test('--resume ueberspringt vorhandene Ergebnisse, ohne --resume nicht', async () => {
  const { resultsRoot, done } = setup();
  try {
    const first = [];
    await runRound({ round: 'r3', participants: ['a', 'b'], types: ['explore'], seeds: [1, 2], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: first }) });
    assert.equal(first.length, 4);
    const second = [];
    const out = await runRound({ round: 'r3', resume: true, participants: ['a', 'b'], types: ['explore', 'capture'], seeds: [1, 2], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: second }) });
    assert.equal(second.length, 4);
    assert.ok(second.every((c) => c.type === 'capture'));
    assert.equal(out.skipped, 4);
    const third = [];
    await runRound({ round: 'r3', overwriteFingerprint: true, participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: third }) });
    assert.equal(third.length, 1);
  } finally { done(); }
});

test('aborted bricht die Runde nicht ab und steht am Ende in der Liste', async () => {
  const { resultsRoot, done } = setup();
  try {
    const calls = [];
    const out = await runRound({ round: 'r4', participants: SLUGS, types: ['explore'], seeds: [1, 2], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: calls, abortAt: [2] }) });
    assert.equal(calls.length, 8);
    assert.equal(out.aborted.length, 1);
    assert.deepEqual(out.aborted[0], { slug: calls[1].slug, type: 'explore', seed: calls[1].seed });
    assert.equal(out.stopped, null);
  } finally { done(); }
});

test('andere Modell-ID ab der dritten Sitzung stoppt die Runde dort, mit beiden IDs', async () => {
  const { resultsRoot, done } = setup();
  try {
    const calls = [];
    const out = await runRound({ round: 'r5', participants: SLUGS, types: ['explore'], seeds: [1, 2], resultsRoot },
      { ...quiet, runSession: fakeRun(resultsRoot, { log: calls, models: (n) => (n >= 3 ? 'claude-opus-5-2' : 'claude-opus-5-1') }) });
    assert.equal(calls.length, 3);
    assert.equal(out.stopped.first, 'claude-opus-5-1');
    assert.equal(out.stopped.other, 'claude-opus-5-2');
    assert.equal(out.stopped.slug, calls[2].slug);
  } finally { done(); }
});

test('Gegenprobe: abgebrochene Sitzung mit anderer ID setzt die Basis nicht und stoppt nicht', async () => {
  const { resultsRoot, done } = setup();
  try {
    const calls = [];
    const out = await runRound({ round: 'r6', participants: SLUGS, types: ['explore'], seeds: [1], resultsRoot },
      { ...quiet, runSession: fakeRun(resultsRoot, { log: calls, abortAt: [1], models: (n) => (n === 1 ? 'claude-opus-5-X' : 'claude-opus-5-1') }) });
    assert.equal(calls.length, 4);
    assert.equal(out.stopped, null);
  } finally { done(); }
});

test('--resume: Basis-ID kommt aus vorhandenen Sitzungen der Runde', async () => {
  const { resultsRoot, done } = setup();
  try {
    await runRound({ round: 'r7', participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { models: () => 'claude-opus-5-1' }) });
    const calls = [];
    const out = await runRound({ round: 'r7', resume: true, participants: ['a', 'b'], types: ['explore'], seeds: [1], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: calls, models: () => 'claude-opus-5-2' }) });
    assert.equal(calls.length, 1);
    assert.equal(out.stopped.first, 'claude-opus-5-1');
  } finally { done(); }
});

test('fingerprint.json liegt vor der ersten Sitzung, mit commit und Zeit; --resume ueberschreibt nicht, bricht bei Abweichung ab (ausser --accept-drift)', async () => {
  const { resultsRoot, done } = setup();
  try {
    const fpFile = join(resultsRoot, 'r8', 'fingerprint.json');
    let existedAtFirstCall = null;
    let content = null;
    await runRound({ round: 'r8', participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, {
      ...quiet,
      runSession: fakeRun(resultsRoot, { onCall: (n) => { if (n === 1) { existedAtFirstCall = existsSync(fpFile); content = JSON.parse(readFileSync(fpFile, 'utf8')); } } }),
    });
    assert.equal(existedAtFirstCall, true);
    assert.equal(content.grader_prompt_sha256, 'g');
    assert.equal(content.commit, 'abc123');
    assert.equal(content.time, '2026-10-21T10:00:00.000Z');

    const drifted = { ...quiet, fingerprint: () => ({ grader_prompt_sha256: 'CHANGED', budgets: {} }) };
    const calls = [];
    await assert.rejects(
      runRound({ round: 'r8', resume: true, participants: ['a'], types: ['explore', 'capture'], seeds: [1], resultsRoot }, { ...drifted, runSession: fakeRun(resultsRoot, { log: calls }) }),
      /grader_prompt_sha256[^]*--accept-drift/,
    );
    assert.equal(calls.length, 0);
    const warnings = [];
    await runRound({ round: 'r8', resume: true, acceptDrift: true, participants: ['a'], types: ['explore', 'capture'], seeds: [1], resultsRoot }, {
      ...drifted, stderr: (l) => warnings.push(l), runSession: fakeRun(resultsRoot),
    });
    assert.equal(JSON.parse(readFileSync(fpFile, 'utf8')).grader_prompt_sha256, 'g');
    assert.ok(warnings.some((w) => w.includes('grader_prompt_sha256')));

    const silent = [];
    await runRound({ round: 'r8', resume: true, participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, {
      ...quiet, stderr: (l) => silent.push(l), runSession: fakeRun(resultsRoot),
    });
    assert.deepEqual(silent, []);
  } finally { done(); }
});

// ---------- Token-Bericht ----------

function agentSession(slug, type, seed, { delta, rounds = 10, cost, wall, turns = 20, status = 'ok' }) {
  return { participant: { slug, kind: 'mcp' }, session: { type, seed }, status, harness: { wall_clock_s: wall, num_turns: turns }, tokens: { delta, rounds }, cost_usd_list: cost };
}

function reportRound(resultsRoot, round, sessions, graded = []) {
  const s = join(resultsRoot, round, 'sessions');
  mkdirSync(s, { recursive: true });
  const name = (r) => sessionFileName({ slug: r.participant.slug, type: r.session.type, seed: r.session.seed });
  for (const r of sessions) writeFileSync(join(s, name(r)), JSON.stringify(r));
  if (graded.length) {
    const g = join(resultsRoot, round, 'graded');
    mkdirSync(g, { recursive: true });
    for (const r of graded) writeFileSync(join(g, name(r)), JSON.stringify(r));
  }
}

test('Token-Bericht: Hochrechnung = Mittelwert x 5 je (Teilnehmer, Typ), Gesamt ueber die Gruppen', () => {
  const { resultsRoot, done } = setup();
  try {
    reportRound(resultsRoot, 'rt', [
      agentSession('pb', 'explore', 1, { delta: 1000, cost: 1.0, wall: 3600 }),
      agentSession('pb', 'explore', 2, { delta: 3000, cost: 3.0, wall: 7200 }),
      agentSession('pb', 'capture', 1, { delta: 400, cost: 0.5, wall: 1800 }),
    ]);
    const md = buildTokenReport({ round: 'rt', resultsRoot });
    assert.match(md, /\| pb \| explore \| 2 \| 10000 \| 10\.00 \| 7\.5 \|/);
    assert.match(md, /\| pb \| capture \| 1 \| 2000 \| 2\.50 \| 2\.5 \|/);
    assert.match(md, /\| Total \(3 sessions\)[^\n]*\| 12000 \| 12\.50 \| 10\.0 \|/);
    assert.match(md, /\| Sum \| 4400 \|/);
    assert.ok(!md.includes('Abo-Stand'));
    assert.ok(!/Grader/.test(md));
  } finally { done(); }
});

test('Token-Bericht: Pruefer-Abschnitt aus graded/, Hochrechnung auf 20 explore-Sitzungen, ohne Zuordnungen', () => {
  const { resultsRoot, done } = setup();
  try {
    const sess = [agentSession('pb', 'explore', 1, { delta: 1000, cost: 1, wall: 60 }), agentSession('pb', 'explore', 2, { delta: 1000, cost: 1, wall: 60 }), agentSession('pb', 'capture', 1, { delta: 10, cost: 0.1, wall: 6 })];
    const graded = [
      { ...sess[0], grading: { model: 'sonnet-x', usage: { input_tokens: 800, output_tokens: 200, cost_usd: 0.1 }, matches: [{ i: 0, match: 'SECRET-ID-77' }] } },
      { ...sess[1], grading: { model: 'sonnet-x', usage: { input_tokens: 1400, output_tokens: 600, cost_usd: 0.3 }, matches: [] } },
      { ...sess[2], grading: { model: 'n/a (capture session)', usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 }, matches: [] } },
    ];
    reportRound(resultsRoot, 'rg', sess, graded);
    const md = buildTokenReport({ round: 'rg', resultsRoot });
    assert.match(md, /## Grader/);
    assert.match(md, /Graded sessions: 2\b/);
    assert.match(md, /\| Sum, graded sessions \| 3000 \| 0\.40 \|/);
    assert.match(md, /\| Mean per graded session \| 1500 \| 0\.20 \|/);
    assert.match(md, /\| Projection, 20 explore sessions \| 30000 \| 4\.00 \|/);
    assert.ok(!md.includes('SECRET-ID-77'));
  } finally { done(); }
});

test('Token-Bericht: Menschen-Sitzung steht als Zeile ohne Zahlen und zaehlt in keiner Summe', () => {
  const { resultsRoot, done } = setup();
  try {
    const human = { participant: { slug: 'human-anna', kind: 'human' }, session: { type: 'explore', seed: 1 }, status: 'ok', events: [] };
    reportRound(resultsRoot, 'rh', [agentSession('pb', 'explore', 1, { delta: 1000, cost: 1, wall: 3600 }), human]);
    const md = buildTokenReport({ round: 'rh', resultsRoot });
    assert.match(md, /\| human-anna \| explore \| 1 \| ok \| — \| — \| — \| — \| — \|/);
    assert.match(md, /\| Sum \| 1000 \|/);
    const projection = md.split('## Projection')[1];
    assert.ok(!projection.includes('human-anna'));
    assert.match(projection, /\| pb \| explore \| 1 \|/);
  } finally { done(); }
});

test('Token-Bericht: Sitzung ohne Kosten (null) wird nicht als 0 gemittelt', () => {
  const { resultsRoot, done } = setup();
  try {
    reportRound(resultsRoot, 'rn', [
      agentSession('pb', 'explore', 1, { delta: 1000, cost: 2.0, wall: 3600 }),
      agentSession('pb', 'explore', 2, { delta: null, cost: null, wall: 3600 }),
    ]);
    const md = buildTokenReport({ round: 'rn', resultsRoot });
    assert.match(md, /\| pb \| explore \| 2 \| 5000 \| 10\.00 \|/);
  } finally { done(); }
});

test('writeTokenReport schreibt results/<r>/token-report.md', () => {
  const { resultsRoot, done } = setup();
  try {
    reportRound(resultsRoot, 'rw', [agentSession('pb', 'explore', 1, { delta: 1, cost: 1, wall: 1 })]);
    const p = writeTokenReport({ round: 'rw', resultsRoot });
    assert.equal(p, join(resultsRoot, 'rw', 'token-report.md'));
    assert.ok(existsSync(p));
  } finally { done(); }
});

test('ohne --resume ueberschreibt run eine vorhandene fingerprint.json nicht: Abbruch vor der ersten Sitzung, mit --overwrite-fingerprint erlaubt', async () => {
  const { resultsRoot, done } = setup();
  try {
    const fpFile = join(resultsRoot, 'r9', 'fingerprint.json');
    mkdirSync(join(resultsRoot, 'r9'), { recursive: true });
    writeFileSync(fpFile, '{"grader_prompt_sha256":"alt","commit":"alt"}\n');
    const calls = [];
    await assert.rejects(
      runRound({ round: 'r9', participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: calls }) }),
      /fingerprint\.json already exists[^]*--overwrite-fingerprint/,
    );
    assert.equal(calls.length, 0);
    assert.equal(JSON.parse(readFileSync(fpFile, 'utf8')).commit, 'alt');
    await runRound({ round: 'r9', overwriteFingerprint: true, participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot, { log: calls }) });
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(readFileSync(fpFile, 'utf8')).commit, 'abc123');
  } finally { done(); }
});

test('--resume ohne vorhandene fingerprint.json schreibt sie neu', async () => {
  const { resultsRoot, done } = setup();
  try {
    await runRound({ round: 'r10', resume: true, participants: ['a'], types: ['explore'], seeds: [1], resultsRoot }, { ...quiet, runSession: fakeRun(resultsRoot) });
    assert.equal(JSON.parse(readFileSync(join(resultsRoot, 'r10', 'fingerprint.json'), 'utf8')).commit, 'abc123');
  } finally { done(); }
});

test('Token-Bericht: Pruefer-Sitzung "n/a" mit Verbrauch (frueherer Lauf) zaehlt, fehlgeschlagene Aufrufe aus grading-spent.json auch; Gesamtzeile Agenten + Pruefer', () => {
  const { resultsRoot, done } = setup();
  try {
    const sess = [agentSession('pb', 'explore', 1, { delta: 1000, cost: 1, wall: 60 }), agentSession('pb', 'explore', 2, { delta: 2000, cost: 2, wall: 60 }), agentSession('pb', 'explore', 3, { delta: 500, cost: 0.5, wall: 60 })];
    const graded = [
      { ...sess[0], grading: { model: 'sonnet-x', usage: { input_tokens: 80, output_tokens: 20, cost_usd: 0.1 }, matches: [] } },
      { ...sess[1], grading: { model: 'n/a (no findings)', usage: { input_tokens: 300, output_tokens: 100, cost_usd: 0.4 }, matches: [] } },
      { ...sess[2], grading: { model: 'n/a (no findings)', usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 }, matches: [] } },
    ];
    reportRound(resultsRoot, 'rs', sess, graded);
    writeFileSync(join(resultsRoot, 'rs', 'grading-spent.json'), JSON.stringify({ 'x.json': { input_tokens: 40, output_tokens: 10, cost_usd: 0.25 } }));
    const md = buildTokenReport({ round: 'rs', resultsRoot });
    assert.match(md, /Graded sessions: 2\b/);
    assert.match(md, /\| Sum, graded sessions \| 500 \| 0\.50 \|/);
    assert.match(md, /\| Failed grader calls[^|]*\| 50 \| 0\.25 \|/);
    assert.match(md, /\| Sum, grader \| 550 \| 0\.75 \|/);
    assert.match(md, /\| Sum, agents \+ grader \| 4050 \| 4\.25 \|/);
  } finally { done(); }
});

test('Token-Bericht: nur grading-spent.json (noch nichts bewertet) erzeugt den Pruefer-Abschnitt; ohne beides keiner', () => {
  const { resultsRoot, done } = setup();
  try {
    reportRound(resultsRoot, 'ro', [agentSession('pb', 'explore', 1, { delta: 100, cost: 1, wall: 60 })]);
    assert.ok(!/## Grader/.test(buildTokenReport({ round: 'ro', resultsRoot })));
    writeFileSync(join(resultsRoot, 'ro', 'grading-spent.json'), JSON.stringify({ 'x.json': { input_tokens: 5, output_tokens: 5, cost_usd: 0.1 } }));
    const md = buildTokenReport({ round: 'ro', resultsRoot });
    assert.match(md, /Graded sessions: 0/);
    assert.match(md, /\| Sum, agents \+ grader \| 110 \| 1\.10 \|/);
  } finally { done(); }
});

test('Token-Bericht: Total-Zeile traegt die echte Sitzungszahl', () => {
  const { resultsRoot, done } = setup();
  try {
    reportRound(resultsRoot, 'rc', [agentSession('pb', 'explore', 1, { delta: 1, cost: 1, wall: 1 }), agentSession('pb', 'capture', 1, { delta: 1, cost: 1, wall: 1 })]);
    const md = buildTokenReport({ round: 'rc', resultsRoot });
    assert.match(md, /\| Total \(2 sessions\) \| \| 2 \|/);
    assert.ok(!md.includes('40 sessions'));
  } finally { done(); }
});

test('CLI round.mjs report: schreibt token-report.md und gibt den Pfad aus; ohne Runde Exit 2', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cliFile = join(fileURLToPath(new URL('.', import.meta.url)), 'round.mjs');
  const run = (args) => spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8' });
  const { resultsRoot, done } = setup();
  try {
    reportRound(resultsRoot, 'rc', [agentSession('pb', 'explore', 1, { delta: 100, cost: 1, wall: 10 })]);
    const ok = run(['report', '--round', 'rc', '--results', resultsRoot]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), join(resultsRoot, 'rc', 'token-report.md'));
    assert.ok(existsSync(join(resultsRoot, 'rc', 'token-report.md')));
    const noRound = run(['report', '--results', resultsRoot]);
    assert.equal(noRound.status, 2);
    assert.match(noRound.stderr, /usage: node harness\/round\.mjs run/);
  } finally { done(); }
});
