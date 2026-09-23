import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTranscript, recomputeRun } from './recompute-tokens.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'recompute-tokens.mjs');
const SID = '12345678-aaaa-bbbb-cccc-000000000001';
const usage = { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
// msg_1 steht als zwei Zeilen (thinking + tool_use) im Transkript: richtig 2 x 110 = 220, alte Zaehlung 3 x 110 = 330.
const JSONL = [
  { type: 'assistant', uuid: 'a', message: { id: 'msg_1', model: 'claude-opus-5', usage, content: [{ type: 'thinking', thinking: '' }] } },
  { type: 'assistant', uuid: 'b', message: { id: 'msg_1', model: 'claude-opus-5', usage, content: [{ type: 'tool_use', id: 't1', name: 'mcp__x__click', input: {} }] } },
  { type: 'user', uuid: 'c', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'assistant', uuid: 'd', message: { id: 'msg_2', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'done' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n';

function setup(over = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'recompute-'));
  const home = join(tmp, 'home');
  const proj = join(home, '.claude', 'projects', '-private-tmp-bench-public-browser-x');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${SID}.jsonl`), JSONL);
  const results = join(tmp, 'results');
  mkdirSync(results);
  const run = {
    name: 'Public Browser', slug: 'public-browser', session_id: SID,
    harness: { mode: 'blind-print', status: 'ok', num_turns: 3,
      session_jsonl_sha256: createHash('sha256').update(JSONL).digest('hex') },
    summary: { passed: 30, counted: 30 },
    tokens: { start: 0, end: 330, delta: 330 },
    cost_usd_list: 1.23, mqs: { score: 50, token_score: 40 },
    ...over,
  };
  const file = join(results, 'public-browser-run1.json');
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  const exec = (...args) => spawnSync(process.execPath, [SCRIPT, '--dir', results, ...args],
    { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  return { home, results, file, exec, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('recompute: korrigiert tokens aus dem Transkript und laesst alles andere stehen', () => {
  const s = setup();
  const r = s.exec();
  assert.equal(r.status, 0, r.stderr);
  const run = s.read();
  assert.deepEqual({ ...run.tokens, recomputed: undefined },
    { start: 0, end: 220, delta: 220, rounds: 2, dedup: 'message.id', recomputed: undefined });
  assert.equal(run.tokens.recomputed.previous_delta, 330);
  assert.match(run.tokens.recomputed.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(run.cost_usd_list, 1.23);
  assert.deepEqual(run.mqs, { score: 50, token_score: 40 });
  assert.equal(run.harness.num_turns, 3);
  assert.match(r.stdout, /fixed\s+results\/public-browser-run1\.json {2}330 -> 220 \(x1\.50\), rounds 2/);
});

test('recompute: ein zweiter Lauf aendert nichts', () => {
  const s = setup();
  s.exec();
  const first = readFileSync(s.file, 'utf8');
  const r = s.exec();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), first);
  assert.match(r.stdout, /^ok\s+results\/public-browser-run1\.json/m);
});

test('recompute: --dry-run schreibt nicht', () => {
  const s = setup();
  const before = readFileSync(s.file, 'utf8');
  const r = s.exec('--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), before);
  assert.match(r.stdout, /would fix/);
});

test('recompute: eine abweichende Transkript-SHA laesst die Datei stehen und endet mit Exit 1', () => {
  const s = setup({ harness: { mode: 'blind-print', status: 'ok', session_jsonl_sha256: '0'.repeat(64) } });
  const before = readFileSync(s.file, 'utf8');
  const r = s.exec();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sha256/);
  assert.equal(readFileSync(s.file, 'utf8'), before);
});

test('recompute: ein fehlendes Transkript endet mit Exit 1', () => {
  const s = setup({ session_id: '00000000-0000-0000-0000-000000000000' });
  const r = s.exec();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /transcript missing/);
});

test('recompute: Laeufe ohne blind-print bleiben unberuehrt', () => {
  const s = setup({ harness: undefined });
  const before = readFileSync(s.file, 'utf8');
  const r = s.exec();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.file, 'utf8'), before);
  assert.match(r.stdout, /skip/);
});

test('recomputeRun: schon korrigiert und gleich -> unveraendert; abweichend -> Fehler; altes Skript -> Fehler', () => {
  const cost = { total: { all: 220 }, rounds: 2, dedup: 'message.id' };
  const done = { tokens: { start: 0, end: 220, delta: 220, rounds: 2, dedup: 'message.id' } };
  assert.equal(recomputeRun(done, cost).changed, false);
  assert.throws(() => recomputeRun({ tokens: { ...done.tokens, delta: 221 } }, cost), /recount differs/);
  assert.throws(() => recomputeRun({ tokens: { delta: 330 } }, { total: { all: 330 } }), /old script/);
});

test('findTranscript: genau ein Treffer, null ohne Treffer, Fehler bei zweien', () => {
  const s = setup();
  const projects = join(s.home, '.claude', 'projects');
  assert.match(findTranscript(projects, SID), new RegExp(`${SID}\\.jsonl$`));
  assert.equal(findTranscript(projects, 'nope'), null);
  mkdirSync(join(projects, '-zweiter-ordner'));
  writeFileSync(join(projects, '-zweiter-ordner', `${SID}.jsonl`), JSONL);
  assert.throws(() => findTranscript(projects, SID), /2 transcripts/);
});
