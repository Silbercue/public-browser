// METHOD.md gegen den Endstand: die woertlich wiedergegebenen Auftragstexte muessen den Prompt-Dateien entsprechen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const method = readFileSync(join(ROOT, 'METHOD.md'), 'utf8');

/** Der erste ```-Block nach der Ueberschrift. */
function blockAfter(heading) {
  const i = method.indexOf(heading);
  assert.ok(i >= 0, `${heading} fehlt in METHOD.md`);
  const open = method.indexOf('```\n', i);
  const close = method.indexOf('\n```', open + 4);
  return method.slice(open + 4, close);
}

for (const type of ['explore', 'capture']) {
  test(`METHOD.md: der Auftragstext ${type} stimmt woertlich mit harness/prompts/${type}.md ueberein`, () => {
    const file = readFileSync(join(ROOT, 'harness', 'prompts', `${type}.md`), 'utf8').trimEnd();
    assert.equal(blockAfter(type === 'explore' ? '### Explore' : '### Capture'), file);
  });
}

test('METHOD.md: die Platzhalterliste nennt den Sitzungsordner; Gegenprobe: der Test erkennt eine Abweichung', () => {
  assert.match(method.replace(/\s+/g, ' '), /the session folder, the report path and the test folder/);
  const file = readFileSync(join(ROOT, 'harness', 'prompts', 'capture.md'), 'utf8').trimEnd();
  assert.notEqual(blockAfter('### Capture'), `${file} changed`);
});

test('METHOD.md nennt die Seeds aus harness/seeds.json', () => {
  const seeds = JSON.parse(readFileSync(join(ROOT, 'harness', 'seeds.json'), 'utf8'));
  assert.ok(method.includes(`${seeds.slice(0, -1).join(', ')}, ${seeds.at(-1)}`), 'Seed-Liste in 4.1 stimmt');
});
