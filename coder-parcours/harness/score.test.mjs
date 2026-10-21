import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, medianRange, renderScoreboard } from './score.mjs';

test('medianRange: gerade Anzahl mittelt die beiden mittleren', () => {
  assert.deepEqual(medianRange([3, 1, 2, 10]), { median: 2.5, min: 1, max: 10, n: 4 });
  assert.deepEqual(medianRange([5, 1, 3]), { median: 3, min: 1, max: 5, n: 3 });
  assert.deepEqual(medianRange([]), { median: null, min: null, max: null, n: 0 });
  assert.deepEqual(medianRange([null, 4, undefined, NaN]), { median: 4, min: 4, max: 4, n: 1 });
});

const bugs = (active, hits, byCategory = {}, byWidth = {}) => ({ active, hits, hit_rate: active ? hits / active : null, by_category: byCategory, by_width: byWidth });

function explore(slug, seed, o = {}) {
  return {
    participant: { slug, display: slug.toUpperCase(), kind: 'mcp' },
    session: { type: 'explore', seed, round: 'r' },
    status: 'ok',
    model: o.model ?? 'claude-opus-5-20260101',
    harness: { wall_clock_s: o.wall ?? 600, num_turns: 50, integrity: { read_bug_script: !!o.readScript, capture_outside_access: false } },
    tokens: { delta: o.tokens ?? 1000 },
    cost_usd_list: o.cost ?? 2,
    metrics: {
      change: o.change ?? { verdict: 'works', truth: 'works', correct: true, false_works: false },
      bugs: o.bugs ?? bugs(4, 2, { a: { active: 2, hits: 1 }, b: { active: 2, hits: 1 } }, { phone: { active: 4, hits: 2 } }),
      false_alarms: o.fa ?? { decoy: 1, decided: 0, unreviewed: o.unreviewed ?? 0, total: 1 },
      duplicates: o.dup ?? 0,
      traps: o.traps ?? { reached: 2, reported: 1, silently_bypassed: 1, stuck: 0, not_reached: 0 },
      login: o.login ?? { success: true, logins: 2, expired_relogin: null },
      capture: null,
      cost: { tokens: o.tokens ?? 1000, rounds: 5, calls: o.calls ?? 40, wall_s: o.wall ?? 600, cost_usd_list: o.cost ?? 2 },
      hit_ids: o.hits ?? ['B1', 'B2'],
    },
  };
}
function capture(slug, seed, valid, o = {}) {
  return {
    participant: { slug, display: slug.toUpperCase(), kind: 'mcp' }, session: { type: 'capture', seed, round: 'r' }, status: 'ok',
    model: o.model ?? 'claude-opus-5-20260101',
    harness: { wall_clock_s: 300, num_turns: 20, integrity: { read_bug_script: false, capture_outside_access: !!o.outside } },
    tokens: { delta: 500 }, cost_usd_list: 1,
    metrics: { change: null, bugs: null, false_alarms: null, duplicates: null, traps: null, login: null, capture: { valid, reason: null },
      cost: { tokens: 500, rounds: 3, calls: 10, wall_s: 300, cost_usd_list: 1 }, hit_ids: [] },
  };
}
function human(tester, seed, hits) {
  return {
    participant: { slug: `human-${tester}`, display: tester, kind: 'human' }, session: { type: 'explore', seed, round: 'r' }, status: 'ok',
    metrics: { change: null, bugs: bugs(4, hits.length), false_alarms: { decoy: 0, decided: 0, unreviewed: 0, total: 0 }, duplicates: 0,
      traps: null, login: null, capture: null, cost: null, hit_ids: hits },
  };
}

test('aggregate: Kennzahlen je Teilnehmer mit medianRange und x/n', () => {
  const sb = aggregate([
    explore('pb', 1, { hits: ['B1', 'B2'], tokens: 1000 }),
    explore('pb', 2, { hits: ['B1'], bugs: bugs(4, 1), tokens: 3000, change: { verdict: 'works', truth: 'broken', correct: false, false_works: true }, login: { success: false, logins: 4, expired_relogin: null }, unreviewed: 2, readScript: true }),
    capture('pb', 1, true), capture('pb', 2, false, { outside: true }),
    explore('aa', 1, { tokens: 500 }),
  ]);
  const pb = sb.participants.pb;
  assert.deepEqual(pb.change, { correct: 1, n: 2, false_works: 1 });
  assert.deepEqual(pb.hit_rate, { median: 0.375, min: 0.25, max: 0.5, n: 2 });
  assert.deepEqual(pb.tokens, { median: 750, min: 500, max: 3000, n: 4 });
  assert.deepEqual(pb.login, { success: 1, n: 2 });
  assert.deepEqual(pb.logins, { median: 3, min: 2, max: 4, n: 2 });
  assert.deepEqual(pb.capture, { valid: 1, n: 2 });
  assert.equal(pb.unreviewed, 2);
  assert.deepEqual(pb.integrity, { read_bug_script: 1, capture_outside_access: 1 });
  assert.deepEqual(pb.silent_bypass, { silently_bypassed: 2, reached: 4, share: 0.5 });
  assert.deepEqual(pb.by_category.a, { active: 2, hits: 1 });
  assert.equal(pb.false_alarms.median, 1);
  assert.equal(sb.participants.aa.sessions, 1);
  assert.equal(sb.unreviewed, 2);
});

test('aggregate: Menschenlauf liefert human_ratio und human_overlap als Median ueber Seeds', () => {
  const sb = aggregate([
    explore('pb', 1, { hits: ['B1', 'B2', 'B3'] }),   // Mensch B1,B2 -> ratio 1.5, overlap 1
    explore('pb', 2, { hits: ['B1'] }),               // Mensch B1,B4 -> ratio 0.5, overlap 0.5
    explore('pb', 3, { hits: ['B9'] }),               // kein Menschenlauf -> zaehlt nicht
    human('anna', 1, ['B1', 'B2']), human('ben', 2, ['B1', 'B4']),
  ]);
  assert.equal(sb.participants.pb.human_ratio, 1);
  assert.equal(sb.participants.pb.human_overlap, 0.75);
  assert.equal(sb.humans.sessions, 2);
  assert.equal(sb.humans.cost, undefined);
  assert.ok(!('human-anna' in sb.participants));
});

test('aggregate: Mensch ohne Treffer an einem Seed wird bei den Verhaeltnissen uebersprungen', () => {
  const sb = aggregate([explore('pb', 1, { hits: ['B1'] }), human('anna', 1, [])]);
  assert.equal(sb.participants.pb.human_ratio, null);
  assert.equal(sb.participants.pb.human_overlap, null);
});

test('aggregate: zwei Modell-IDs bei Agenten werfen mit IDs und Dateien, Menschen zaehlen nicht', () => {
  assert.throws(() => aggregate([explore("pb", 1), explore("aa", 2, { model: "claude-opus-5-20260202" })]), (/** @type {any} */ e) => {
    assert.match(e.message, /claude-opus-5-20260101/);
    assert.match(e.message, /claude-opus-5-20260202/);
    assert.match(e.message, /pb-explore-seed1\.json/);
    assert.match(e.message, /aa-explore-seed2\.json/);
    return true;
  });
  const ok = aggregate([explore('pb', 1), human('anna', 1, ['B1'])]);
  assert.deepEqual(ok.models, ['claude-opus-5-20260101']);
});

test('renderScoreboard: alphabetisch, Menschenzeile, offene Funde ausgewiesen, kein Sieger', () => {
  const sb = aggregate([explore('zeta', 1, { unreviewed: 3 }), explore('alpha', 1), human('anna', 1, ['B1'])]);
  const md = renderScoreboard(sb);
  assert.ok(md.indexOf('ALPHA') >= 0 && md.indexOf('ALPHA') < md.indexOf('ZETA'));
  assert.match(md, /Human/);
  assert.match(md, /unreviewed/i);
  assert.ok(!/\*\*(winner|best)/i.test(md));
  assert.match(md, /claude-opus-5-20260101/);
});

test('Menschen-Sitzung ohne Kosten bricht die Tafel nicht (cost null)', () => {
  const md = renderScoreboard(aggregate([human('anna', 1, ['B1'])]));
  assert.match(md, /Human/);
});
