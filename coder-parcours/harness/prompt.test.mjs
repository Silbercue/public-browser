import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSessionPrompt, BUDGETS } from './prompt.mjs';
import { buildRunConfig, changeBrokenFor } from './seed.mjs';
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
    explore: { calls: 75, maxTurns: 100, wallMin: 45 },
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
    assert.ok(text.includes('about 75 tool calls'));
    for (const a of TEST_ACCOUNTS) assert.ok(text.includes(`${a.email} / ${a.password}`));
    assert.ok(!text.includes('{{'));
    assert.ok(!text.includes('run_plan'));
    for (const b of catalog.bugs) assert.ok(!text.includes(b.title), 'Titel ' + b.id);
    assert.ok(!text.includes('SMOKE MODE'));
  }
});

test('F13: capture nennt eine frische Kopie des Testordners als Arbeitsverzeichnis, nicht den Testordner selbst', () => {
  const runConfig = buildRunConfig({ seed: 11, sessionType: 'capture', catalog });
  const text = renderSessionPrompt({ ...base, type: 'capture', runConfig, reportPath: '/x/report.json', testDir: '/x/test' });
  assert.match(text, /in a fresh copy of \/x\/test as its working directory/);
  assert.ok(!text.includes('runs with /x/test as working directory'), 'Gegenprobe: der alte Wortlaut ist weg');
  assert.ok(text.includes('/x/test/RUN'), 'RUN liegt weiter im Testordner');
});

test('K-T10-1: explore - der Auftrag ist fuer heile und kaputte Aenderung Zeichen fuer Zeichen gleich (Seeds mit beiden Urteilen)', () => {
  const seeds = [11, 12, 13, 14, 15, 16, 17, 18].map((s) => ({ s, broken: changeBrokenFor(s) }));
  assert.ok(seeds.some((x) => x.broken) && seeds.some((x) => !x.broken), 'Gegenprobe: beide Faelle kommen vor');
  for (const { s } of seeds) {
    const cfg = buildRunConfig({ seed: s, sessionType: 'explore', catalog });
    const render = (broken) => renderSessionPrompt({ ...base, type: 'explore', runConfig: { ...cfg, change: { ...cfg.change, broken } }, reportPath: '/x/report.json', testDir: '/x/test' });
    assert.equal(render(true), render(false), `seed ${s}`);
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

test('beide Typen nennen den Sitzungsordner und dass Schreiben ausserhalb die Sitzung beendet, gleich formuliert', () => {
  const sentence = (type) => {
    const runConfig = buildRunConfig({ seed: 11, sessionType: type, catalog });
    const text = renderSessionPrompt({ ...base, type, runConfig, reportPath: '/x/session/report.json', testDir: '/x/session/test' });
    return text.split('\n').find((l) => l.startsWith('Only create or edit files'));
  };
  const expected = 'Only create or edit files inside the session folder /x/session; writing anywhere else ends the session.';
  assert.equal(sentence('explore'), expected);
  assert.equal(sentence('capture'), expected);
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

test('der Auftragstext ist fuer gesunde und kaputte Variante Zeichen fuer Zeichen gleich, und fuer alle Teilnehmer bis auf den Werkzeugnamen', () => {
  for (const type of /** @type {const} */ (['explore', 'capture'])) {
    // capture: the variant of the run config; explore: the "broken" flag of the change (same seed, same target, flag flipped)
    const render = (variant, toolName) => {
      const cfg = buildRunConfig({ seed: 11, sessionType: type, catalog, variant: type === 'capture' ? variant : null });
      const runConfig = type === 'explore' && variant ? { ...cfg, change: { ...cfg.change, broken: variant === 'broken' } } : cfg;
      return renderSessionPrompt({ ...base, toolName, type, runConfig, reportPath: '/x/report.json', testDir: '/x/test' });
    };
    const healthy = render('healthy', 'Tool Alpha');
    const broken = render('broken', 'Tool Alpha');
    assert.equal(healthy, broken, `${type}: the text does not tell whether the change is broken`);
    assert.equal(render(null, 'Tool Alpha'), healthy, `${type}: nor does the missing variant`);
    const other = render('healthy', 'Tool Omega');
    assert.notEqual(other, healthy, 'Gegenprobe: the tool name does change the text');
    assert.equal(other.split('Tool Omega').join('Tool Alpha'), healthy, `${type}: only the tool name differs between participants`);
    assert.ok(healthy.includes('Tool Alpha'));
  }
});

test('capture nennt Werkzeugnamen und Konten und verraet weder run_plan noch einen Fehlertitel', () => {
  const runConfig = buildRunConfig({ seed: 11, sessionType: 'capture', catalog });
  const text = renderSessionPrompt({ ...base, type: 'capture', runConfig, reportPath: '/x/report.json', testDir: '/x/test' });
  assert.ok(text.includes('Some Browser Tool'), 'tool name');
  assert.ok(text.includes('http://127.0.0.1:4555'), 'app url');
  for (const a of TEST_ACCOUNTS) assert.ok(text.includes(`${a.email} / ${a.password}`), a.email);
  assert.ok(!text.includes('run_plan'));
  for (const b of catalog.bugs) assert.ok(!text.includes(b.title), `title ${b.id}`);
  for (const d of catalog.decoys ?? []) assert.ok(!text.includes(d.title), `decoy title ${d.id}`);
});

test('Ziel nicht im Katalog und Ziel ohne Rollentext werfen mit der Fehler-ID', () => {
  for (const type of /** @type {const} */ (['explore', 'capture'])) {
    const runConfig = buildRunConfig({ seed: 11, sessionType: type, catalog });
    const key = type === 'explore' ? 'change' : 'capture';
    const targetId = runConfig[key].bugId;
    const without = { ...catalog, bugs: catalog.bugs.filter((b) => b.id !== targetId) };
    assert.throws(() => renderSessionPrompt({ ...base, catalog: without, type, runConfig, reportPath: '/r', testDir: '/t' }), new RegExp(`${targetId} has no ${key} role text`));
    const noRole = { ...catalog, bugs: catalog.bugs.map((b) => (b.id === targetId ? { ...b, roles: {} } : b)) };
    assert.throws(() => renderSessionPrompt({ ...base, catalog: noRole, type, runConfig, reportPath: '/r', testDir: '/t' }), new RegExp(`${targetId} has no ${key} role text`));
    // Gegenprobe: the unchanged catalog renders
    assert.doesNotThrow(() => renderSessionPrompt({ ...base, type, runConfig, reportPath: '/r', testDir: '/t' }));
  }
});

test('der Smoke-Zusatz steht am Ende des Textes und nur im Smoke-Fall', () => {
  for (const type of /** @type {const} */ (['explore', 'capture'])) {
    const runConfig = buildRunConfig({ seed: 11, sessionType: type, catalog });
    const args = { ...base, type, runConfig, reportPath: '/r', testDir: '/t' };
    const plain = renderSessionPrompt(args);
    const smoke = renderSessionPrompt({ ...args, smoke: true });
    assert.ok(smoke.startsWith(plain.trimEnd()), 'the normal text comes first, unchanged');
    assert.match(smoke.trimEnd().split('\n').pop(), /^SMOKE MODE \(harness self-test\)/, 'the add-on is the last line');
    assert.ok(!plain.includes('SMOKE MODE'));
  }
});
