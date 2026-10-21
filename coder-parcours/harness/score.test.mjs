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
  assert.deepEqual(pb.cost.explore.tokens, { median: 2000, min: 1000, max: 3000, n: 2 });
  assert.deepEqual(pb.cost.capture.tokens, { median: 500, min: 500, max: 500, n: 2 });
  assert.deepEqual(pb.cost.capture.calls, { median: 10, min: 10, max: 10, n: 2 });
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

const graded = (r, model, sha = 'p1', flags = undefined) => ({ ...r, grading: { model, prompt_sha256: sha, ...(flags ? { flags } : {}), usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, matches: [] } });

test('aggregate: verschiedene Pruefer-Modelle oder Pruefer-Prompts werfen mit Wert und Datei; n/a-Eintraege zaehlen nicht', () => {
  assert.throws(() => aggregate([graded(explore('pb', 1), 'sonnet-a'), graded(explore('aa', 2), 'sonnet-b')]), (/** @type {any} */ e) => {
    assert.match(e.message, /grader model/);
    assert.match(e.message, /sonnet-a: pb-explore-seed1\.json/);
    assert.match(e.message, /sonnet-b: aa-explore-seed2\.json/);
    return true;
  });
  assert.throws(() => aggregate([graded(explore('pb', 1), 'sonnet-a', 'p1'), graded(explore('aa', 2), 'sonnet-a', 'p2')]), /grader prompt checksum/);
  const ok = aggregate([graded(explore('pb', 1), 'sonnet-a'), graded(explore('aa', 2), 'sonnet-a'), graded(capture('pb', 1, true), 'n/a (capture session)', 'other'), explore('aa', 3)]);
  assert.deepEqual(ok.grader, { model: 'sonnet-a', prompt_sha256: 'p1', flags: null });
  assert.match(renderScoreboard(ok), /Grader model: sonnet-a/);
});

test('aggregate: zwei Versionen desselben Teilnehmers werfen, verschiedene Teilnehmer mit eigener Version nicht', () => {
  const v = (r, version) => ({ ...r, participant: { ...r.participant, version } });
  assert.throws(() => aggregate([v(explore('pb', 1), '3.0.0'), v(explore('pb', 2), '3.0.1')]), (/** @type {any} */ e) => {
    assert.match(e.message, /participant pb/);
    assert.match(e.message, /3\.0\.0: pb-explore-seed1\.json/);
    assert.match(e.message, /3\.0\.1: pb-explore-seed2\.json/);
    return true;
  });
  const ok = aggregate([v(explore('pb', 1), '3.0.0'), v(explore('pb', 2), '3.0.0'), v(explore('aa', 1), '1.0.0')]);
  assert.equal(ok.participants.pb.version, '3.0.0');
  assert.equal(ok.participants.aa.version, '1.0.0');
});

test('renderScoreboard: Kosten getrennt nach explore und capture, ohne gemeinsamen Median', () => {
  const md = renderScoreboard(aggregate([explore('pb', 1, { tokens: 1000 }), explore('pb', 2, { tokens: 3000 }), capture('pb', 1, true)]));
  const ex = md.split('## Cost, explore sessions')[1].split('##')[0];
  const cp = md.split('## Cost, capture sessions')[1].split('##')[0];
  assert.match(ex, /2000 \(1000.3000, n=2\)/);
  assert.match(cp, /500 \(500.500, n=1\)/);
  assert.ok(!md.includes('1000 (500'));
});

test('renderScoreboard: Reihenfolge folgt dem Namen, nicht den Werten - in jeder Tabelle, bei guten wie bei schlechten Werten des spaeteren Namens', () => {
  const rowsOf = (md, heading) => md.split(heading)[1].split('\n## ')[0].split('\n').filter((l) => /^\| (ALPHA|ZETA)/.test(l)).map((l) => l.split('|')[1].trim());
  for (const [alphaWins, label] of [[false, 'zeta has the better numbers'], [true, 'alpha has the better numbers']]) {
    const good = { hits: ['B1', 'B2', 'B3', 'B4'], bugs: bugs(4, 4), tokens: 100, wall: 60, cost: 0.1, calls: 5 };
    const poor = { hits: [], bugs: bugs(4, 0), tokens: 9000, wall: 3000, cost: 9, calls: 90, fa: { decoy: 3, decided: 0, unreviewed: 2, total: 3 } };
    const md = renderScoreboard(aggregate([
      explore('alpha', 1, alphaWins ? good : poor), explore('zeta', 1, alphaWins ? poor : good),
      capture('alpha', 1, alphaWins), capture('zeta', 1, !alphaWins),
    ]));
    for (const h of ['## Explore', '## Capture and integrity', '## Cost, explore sessions', '## Cost, capture sessions']) {
      assert.deepEqual(rowsOf(md, h), ['ALPHA', 'ZETA'], `${h}: ${label}`);
    }
  }
});

test('renderScoreboard: kein Sieger-, Platz- oder Bestenwort in der Tafel, aber der Hinweis "no ranking" steht drin', () => {
  const md = renderScoreboard(aggregate([
    explore('alpha', 1, { hits: ['B1', 'B2', 'B3', 'B4'], bugs: bugs(4, 4) }), explore('zeta', 1, { hits: [], bugs: bugs(4, 0) }), human('anna', 1, ['B1']),
  ]));
  assert.match(md, /no ranking/, 'Gegenprobe: the sentence that rules a ranking out is there');
  assert.doesNotMatch(md, /\b(winner|best|worst|leader|leaderboard|1st|first place|rank\s*\d|#\s*1)\b/i);
});

// ---------- CLI ----------

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCORE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'score.mjs');
const cli = (args) => spawnSync(process.execPath, [SCORE_CLI, ...args], { encoding: 'utf8' });

test('CLI score.mjs: schreibt scoreboard.json und .md aus graded/, ohne Runde Exit 2, ohne graded-Ordner Exit 1 mit Hinweis', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-score-cli-'));
  try {
    const graded = join(root, 'r1', 'graded');
    mkdirSync(graded, { recursive: true });
    const put = (name, r) => writeFileSync(join(graded, name), JSON.stringify(r));
    put('pb-explore-seed1.json', explore('pb', 1));
    put('aa-explore-seed1.json', explore('aa', 1));
    put('pb-capture-seed1.json', capture('pb', 1, true));
    put('notes.txt', 'not a session');
    const ok = cli(['--round', 'r1', '--results', root]);
    assert.equal(ok.status, 0, ok.stderr);
    const sb = JSON.parse(readFileSync(join(root, 'r1', 'scoreboard.json'), 'utf8'));
    assert.deepEqual(Object.keys(sb.participants).sort(), ['aa', 'pb']);
    const md = readFileSync(join(root, 'r1', 'scoreboard.md'), 'utf8');
    assert.ok(md.indexOf('AA') >= 0 && md.indexOf('AA') < md.indexOf('PB'), 'participants alphabetical');
    const usage = cli(['--results', root]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: node harness\/score\.mjs --round/);
    const missing = cli(['--round', 'r9', '--results', root]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no graded folder.*run node harness\/grade\.mjs first/);
    assert.ok(!existsSync(join(root, 'r9', 'scoreboard.md')), 'nothing written for a round without graded sessions');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('aggregate: verschiedene Pruefer-Flags werfen, gleiche stehen in Tafel und Daten (K-T15-5)', () => {
  const f1 = ['--tools', ''];
  const f2 = ['--tools', 'Bash'];
  assert.throws(() => aggregate([graded(explore('pb', 1), 'sonnet-a', 'p1', f1), graded(explore('aa', 2), 'sonnet-a', 'p1', f2)]), /grader flags/);
  const ok = aggregate([graded(explore('pb', 1), 'sonnet-a', 'p1', f1), graded(explore('aa', 2), 'sonnet-a', 'p1', f1)]);
  assert.deepEqual(ok.grader.flags, f1);
  assert.match(renderScoreboard(ok), /grader flags: --tools /);
});

test('aggregate: unbekanntes Agenten-Modell ist ein Fehler, kein Modell "unknown"', () => {
  assert.throws(() => aggregate([explore('pb', 1, { model: 'unknown' })]), /no exact model id/);
  const noModel = explore('pb', 1);
  delete noModel.model;
  assert.throws(() => aggregate([noModel]), /no exact model id/);
  assert.deepEqual(aggregate([explore('pb', 1)]).models, ['claude-opus-5-20260101'], 'Gegenprobe: mit Modell laeuft es');
});

const abortedRun = (slug, type, seed, reason) => ({ participant: { slug, display: slug.toUpperCase(), kind: 'mcp' }, session: { type, seed, round: 'r' }, status: 'aborted', notes: [`aborted: ${reason}`] });

test('F8: abgebrochene Sitzungen stehen je Teilnehmer mit Zahl und Grund in Daten und Tafel; ohne Abbrueche steht "none"', () => {
  const g = [explore('pb', 1), explore('aa', 1)];
  const sb = aggregate(g, [
    abortedRun('pb', 'explore', 2, 'fairness violated, tools outside the lock executed: Bash(cat x)'),
    abortedRun('pb', 'capture', 2, 'fairness violated, tools outside the lock executed: Bash(ls)'),
    abortedRun('pb', 'capture', 3, 'ports 9222/9223 busy'),
  ]);
  assert.deepEqual(sb.aborted.pb, { n: 3, reasons: { 'fairness violated, tools outside the lock executed': 2, 'ports 9222/9223 busy': 1 } });
  assert.equal(sb.aborted.aa, undefined, 'Teilnehmer ohne Abbruch hat keinen Eintrag');
  const md = renderScoreboard(sb);
  assert.match(md, /## Aborted sessions/);
  assert.match(md, /\| PB \| 3 \|.*fairness violated, tools outside the lock executed \(2\)/);
  assert.match(renderScoreboard(aggregate(g, [])), /Aborted sessions: none/);
  assert.match(renderScoreboard(aggregate(g)), /Aborted sessions: none/);
});

test('F8: score.mjs liest aborted/ der Runde mit', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-score-ab-'));
  try {
    mkdirSync(join(root, 'r1', 'graded'), { recursive: true });
    mkdirSync(join(root, 'r1', 'aborted'), { recursive: true });
    writeFileSync(join(root, 'r1', 'graded', 'pb-explore-seed1.json'), JSON.stringify(explore('pb', 1)));
    writeFileSync(join(root, 'r1', 'aborted', 'pb-explore-seed2-1.json'), JSON.stringify(abortedRun('pb', 'explore', 2, 'session JSONL missing')));
    const r = cli(['--round', 'r1', '--results', root]);
    assert.equal(r.status, 0, r.stderr);
    const sb = JSON.parse(readFileSync(join(root, 'r1', 'scoreboard.json'), 'utf8'));
    assert.deepEqual(sb.aborted.pb, { n: 1, reasons: { 'session JSONL missing': 1 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
