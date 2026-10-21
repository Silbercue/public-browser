import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSessionPrompt, BUDGETS } from './prompt.mjs';
import { buildRunConfig } from './seed.mjs';
import { loadCatalog } from '../catalog/load.mjs';
import { TEST_ACCOUNTS } from '../shared/accounts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = await loadCatalog({
  publicDir: path.join(root, 'fixtures/bugs'),
  decoysFile: path.join(root, 'catalog/decoys.json'),
  unplannedFile: path.join(root, 'catalog/unplanned.json'),
});
const base = { toolName: 'Some Browser Tool', appUrl: 'http://127.0.0.1:4555', catalog };

test('BUDGETS wie im Plan', () => {
  assert.deepEqual(BUDGETS, {
    explore: { calls: 120, maxTurns: 160, wallMin: 45 },
    capture: { calls: 60, maxTurns: 80, wallMin: 25 },
  });
});

test('explore enthaelt Aenderung, Konten, Budget, Berichtsregel; kein Platzhalter, kein Fehlertitel, kein run_plan', () => {
  for (const variant of /** @type {Array<null|'healthy'|'broken'>} */ ([null, 'healthy', 'broken'])) {
    const runConfig = buildRunConfig({ seed: 11, sessionType: 'explore', catalog, variant });
    const target = catalog.bugs.find((b) => b.id === runConfig.change.bugId);
    const text = renderSessionPrompt({ ...base, type: 'explore', runConfig, reportPath: '/x/report.json', testDir: '/x/test' });
    assert.ok(text.includes(target.roles.change.feature));
    assert.ok(text.includes('Only the report file below counts'));
    assert.ok(text.includes('http://127.0.0.1:4555'));
    assert.ok(text.includes('Some Browser Tool'));
    assert.ok(text.includes('/x/report.json'));
    assert.ok(text.includes('about 120 tool calls'));
    for (const a of TEST_ACCOUNTS) assert.ok(text.includes(`${a.email} / ${a.password}`));
    assert.ok(!text.includes('{{'));
    assert.ok(!text.includes('run_plan'));
    for (const b of catalog.bugs) assert.ok(!text.includes(b.title), 'Titel ' + b.id);
    assert.ok(!text.includes('SMOKE MODE'));
  }
});

test('capture enthaelt Ablauf, Quellcode-Verbot, Testordner und Budget', () => {
  const runConfig = buildRunConfig({ seed: 11, sessionType: 'capture', catalog });
  const target = catalog.bugs.find((b) => b.id === runConfig.capture.bugId);
  const text = renderSessionPrompt({ ...base, type: 'capture', runConfig, reportPath: '/x/report.json', testDir: '/x/test' });
  assert.ok(text.includes(target.roles.capture.flow));
  assert.ok(text.includes("Do not read the app's source code"));
  assert.ok(text.includes('/x/test/RUN'));
  assert.ok(text.includes('about 60 tool calls'));
  assert.ok(!text.includes('{{'));
  assert.ok(!text.includes('SMOKE MODE'));
});

test('Smoke-Zusatz je Typ', () => {
  const e = buildRunConfig({ seed: 11, sessionType: 'explore', catalog });
  const c = buildRunConfig({ seed: 11, sessionType: 'capture', catalog });
  const te = renderSessionPrompt({ ...base, type: 'explore', runConfig: e, reportPath: '/r', testDir: '/t', smoke: true });
  const tc = renderSessionPrompt({ ...base, type: 'capture', runConfig: c, reportPath: '/r', testDir: '/t', smoke: true });
  assert.ok(te.includes('SMOKE MODE (harness self-test): do only Part 1, write the report, stop.'));
  assert.ok(tc.includes('SMOKE MODE (harness self-test): write a RUN file containing `exit 0`, call run-my-test once, stop.'));
});

test('fehlendes Ziel wirft', () => {
  const e = { ...buildRunConfig({ seed: 11, sessionType: 'explore', catalog }), change: null };
  const c = { ...buildRunConfig({ seed: 11, sessionType: 'capture', catalog }), capture: null };
  assert.throws(() => renderSessionPrompt({ ...base, type: 'explore', runConfig: e, reportPath: '/r', testDir: '/t' }), /target|change/i);
  assert.throws(() => renderSessionPrompt({ ...base, type: 'capture', runConfig: c, reportPath: '/r', testDir: '/t' }), /target|capture/i);
  assert.throws(() => renderSessionPrompt({ ...base, type: /** @type {any} */ ('nope'), runConfig: c, reportPath: '/r', testDir: '/t' }));
});

test('uebrig gebliebenes {{ wirft', () => {
  const runConfig = buildRunConfig({ seed: 11, sessionType: 'explore', catalog });
  assert.throws(() => renderSessionPrompt({ ...base, type: 'explore', runConfig, reportPath: '/r{{X}}', testDir: '/t' }), /\{\{/);
});
