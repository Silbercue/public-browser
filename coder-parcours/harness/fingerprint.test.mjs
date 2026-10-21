import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareFingerprints, fingerprint } from './fingerprint.mjs';
import { BUDGETS } from './prompt.mjs';

const SCRIPT = fileURLToPath(new URL('./fingerprint.mjs', import.meta.url));

/** Kleiner Baum mit allen Dateien, die der Fingerabdruck liest. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), 'cp-fp-'));
  for (const d of ['harness/prompts', 'bugs/public', 'catalog']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'harness/grader-prompt.md'), 'grader');
  writeFileSync(join(root, 'harness/prompts/explore.md'), 'explore');
  writeFileSync(join(root, 'harness/prompts/capture.md'), 'capture');
  writeFileSync(join(root, 'harness/seeds.json'), '[1,2]');
  writeFileSync(join(root, 'catalog/decoys.json'), '[]');
  writeFileSync(join(root, 'bugs/public/alpha-secret-name.mjs'), 'export default 1;');
  writeFileSync(join(root, 'bugs/public/beta.mjs'), 'export default 2;');
  return root;
}

test('fingerprint hat alle Felder, Budgets im Klartext und keinen Dateinamen', () => {
  const root = tree();
  try {
    const fp = fingerprint({ root });
    for (const k of ['grader_prompt_sha256', 'prompts_sha256', 'catalog_sha256']) assert.match(fp[k], /^[0-9a-f]{64}$/);
    assert.deepEqual(fp.budgets, BUDGETS);
    const text = JSON.stringify(fp);
    for (const name of ['alpha-secret-name', 'beta.mjs', 'explore.md', 'capture.md', 'decoys', 'seeds', 'grader-prompt']) assert.ok(!text.includes(name), name);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ein Byte unter bugs/public aendert nur catalog_sha256', () => {
  const root = tree();
  try {
    const before = fingerprint({ root });
    writeFileSync(join(root, 'bugs/public/beta.mjs'), 'export default 3;');
    const after = fingerprint({ root });
    assert.notEqual(after.catalog_sha256, before.catalog_sha256);
    for (const k of ['grader_prompt_sha256', 'prompts_sha256', 'budgets', 'participants']) assert.deepEqual(after[k], before[k], k);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Gegenprobe: Auftragstext und Pruefer-Prompt aendern jeweils nur ihr eigenes Feld', () => {
  const root = tree();
  try {
    const before = fingerprint({ root });
    writeFileSync(join(root, 'harness/prompts/explore.md'), 'explore!');
    const p = fingerprint({ root });
    assert.notEqual(p.prompts_sha256, before.prompts_sha256);
    assert.equal(p.catalog_sha256, before.catalog_sha256);
    assert.equal(p.grader_prompt_sha256, before.grader_prompt_sha256);
    writeFileSync(join(root, 'harness/grader-prompt.md'), 'grader!');
    const g = fingerprint({ root });
    assert.notEqual(g.grader_prompt_sha256, p.grader_prompt_sha256);
    assert.equal(g.prompts_sha256, p.prompts_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Testdateien unter bugs/public zaehlen nicht zum Katalog', () => {
  const root = tree();
  try {
    const before = fingerprint({ root });
    writeFileSync(join(root, 'bugs/public/beta.test.mjs'), 'x');
    assert.equal(fingerprint({ root }).catalog_sha256, before.catalog_sha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fehlende Datei ergibt null, auch bei leerem bugs/public', () => {
  const root = tree();
  try {
    rmSync(join(root, 'harness/grader-prompt.md'));
    rmSync(join(root, 'catalog/decoys.json'));
    const fp = fingerprint({ root });
    assert.equal(fp.grader_prompt_sha256, null);
    assert.equal(fp.catalog_sha256, null);
    assert.match(fp.prompts_sha256, /^[0-9a-f]{64}$/);
    rmSync(join(root, 'harness/prompts'), { recursive: true });
    assert.equal(fingerprint({ root }).prompts_sha256, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Teilnehmer-Abdruck: chrome-devtools-mcp tragen args und extraArgs, Mapping je Teilnehmer', () => {
  const root = tree();
  try {
    const fp = fingerprint({ root });
    assert.ok(Object.keys(fp.participants).length >= 4);
    for (const v of Object.values(fp.participants)) assert.match(v, /^[0-9a-f]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const base = () => ({ grader_prompt_sha256: 'a', prompts_sha256: 'b', catalog_sha256: 'c', participants: { x: 'd' }, budgets: BUDGETS });

test('compareFingerprints: nur budgets anders ist ok, alles andere nicht', () => {
  const onlyBudgets = compareFingerprints(base(), { ...base(), budgets: { explore: { calls: 1 } } });
  assert.equal(onlyBudgets.ok, true);
  assert.equal(onlyBudgets.fields.budgets, 'changed');
  assert.equal(onlyBudgets.fields.catalog_sha256, 'same');
  const other = compareFingerprints(base(), { ...base(), grader_prompt_sha256: 'z' });
  assert.equal(other.ok, false);
  assert.equal(other.fields.grader_prompt_sha256, 'changed');
  assert.equal(compareFingerprints(base(), { ...base(), participants: { x: 'e' } }).ok, false);
});

test('CLI --compare: Exit 0 bei reinen budgets-Unterschieden, Exit 1 sonst', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-fpcli-'));
  try {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    const c = join(dir, 'c.json');
    writeFileSync(a, JSON.stringify(base()));
    writeFileSync(b, JSON.stringify({ ...base(), budgets: { explore: { calls: 1 } } }));
    writeFileSync(c, JSON.stringify({ ...base(), grader_prompt_sha256: 'z' }));
    const ok = spawnSync(process.execPath, [SCRIPT, '--compare', a, b], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).budgets, 'changed');
    const bad = spawnSync(process.execPath, [SCRIPT, '--compare', a, c], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).grader_prompt_sha256, 'changed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
