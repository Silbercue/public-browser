import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from './load.mjs';

const mod = (id, extra = '') => `export default {
  id: '${id}', category: 'layout', title: 'T ${id}', stations: ['cart'], widths: ['phone'],
  severity: 'low', symptom: 'S', grader: 'G', client: { css: () => '' }${extra}
};
`;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'cp-load-'));
}

test('public fixtures: 3 bugs, all marked public', async () => {
  const c = await loadCatalog({ publicDir: 'fixtures/bugs' });
  assert.deepEqual(c.bugs.map((b) => b.id).sort(), ['F01', 'F02', 'F03']);
  assert.deepEqual(c.sources, { public: 3, secret: 0 });
  assert.ok(c.bugs.every((b) => b.source === 'public'));
  assert.deepEqual(c.decoys, []);
  assert.deepEqual(c.unplanned, []);
});

test('with secret fixtures: 4 bugs, sources 3/1, S90 marked secret', async () => {
  const c = await loadCatalog({ publicDir: 'fixtures/bugs', secretDir: 'fixtures/secret' });
  assert.equal(c.bugs.length, 4);
  assert.deepEqual(c.sources, { public: 3, secret: 1 });
  const s90 = c.bugs.find((b) => b.id === 'S90');
  assert.equal(s90?.source, 'secret');
  assert.deepEqual(s90?.removesDecoys, ['D01']);
  assert.equal(c.bugs.find((b) => b.id === 'F01')?.source, 'public');
});

test('fixture F02 is a server bug with change and capture roles on widths all', async () => {
  const c = await loadCatalog({ publicDir: 'fixtures/bugs' });
  const f02 = c.bugs.find((b) => b.id === 'F02');
  assert.equal(typeof f02?.server?.setup, 'function');
  assert.ok(f02?.roles?.change && f02?.roles?.capture);
  assert.deepEqual(f02?.widths, ['all']);
  const f01 = c.bugs.find((b) => b.id === 'F01');
  assert.deepEqual(f01?.widths, ['phone']);
  assert.equal(typeof f01?.client?.css, 'function');
  assert.equal(c.bugs.find((b) => b.id === 'F03')?.category, 'timing');
});

test('default publicDir comes from CODER_PARCOURS_PUBLIC_DIR', async () => {
  const old = process.env.CODER_PARCOURS_PUBLIC_DIR;
  process.env.CODER_PARCOURS_PUBLIC_DIR = 'fixtures/bugs';
  try {
    const c = await loadCatalog();
    assert.equal(c.sources.public, 3);
  } finally {
    if (old === undefined) delete process.env.CODER_PARCOURS_PUBLIC_DIR;
    else process.env.CODER_PARCOURS_PUBLIC_DIR = old;
  }
});

test('empty public folder is allowed (bugs/public by default)', async () => {
  const old = process.env.CODER_PARCOURS_PUBLIC_DIR;
  delete process.env.CODER_PARCOURS_PUBLIC_DIR;
  const dir = tmp();
  try {
    const c = await loadCatalog({ publicDir: dir });
    assert.deepEqual(c.sources, { public: 0, secret: 0 });
    const d = await loadCatalog();
    assert.ok(Array.isArray(d.bugs));
  } finally {
    if (old !== undefined) process.env.CODER_PARCOURS_PUBLIC_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate id throws with file name', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'A01-one.mjs'), mod('A01'));
    writeFileSync(join(dir, 'A01-two.mjs'), mod('A01'));
    await assert.rejects(loadCatalog({ publicDir: dir }), /A01-two\.mjs.*duplicate|duplicate.*A01-two\.mjs/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate id across public and secret throws', async () => {
  const pub = tmp();
  const sec = tmp();
  try {
    writeFileSync(join(pub, 'A01.mjs'), mod('A01'));
    mkdirSync(join(sec, 'bugs'));
    writeFileSync(join(sec, 'bugs', 'A01.mjs'), mod('A01', ', removesDecoys: []'));
    writeFileSync(join(sec, 'decoys.json'), '[]');
    await assert.rejects(loadCatalog({ publicDir: pub, secretDir: sec }), /duplicate/i);
  } finally {
    rmSync(pub, { recursive: true, force: true });
    rmSync(sec, { recursive: true, force: true });
  }
});

test('validation error throws with file name', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'B07-broken.mjs'), mod('B07').replace("'layout'", "'ugly'"));
    await assert.rejects(loadCatalog({ publicDir: dir }), /B07-broken\.mjs.*category/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret bug without removesDecoys throws with file name; empty list is fine', async () => {
  const sec = tmp();
  try {
    mkdirSync(join(sec, 'bugs'));
    writeFileSync(join(sec, 'decoys.json'), '[]');
    writeFileSync(join(sec, 'bugs', 'S01-x.mjs'), mod('S01'));
    await assert.rejects(loadCatalog({ publicDir: 'fixtures/bugs', secretDir: sec }), /S01-x\.mjs.*removesDecoys/);
    writeFileSync(join(sec, 'bugs', 'S01-x.mjs'), mod('S01', ', removesDecoys: []'));
    const c = await loadCatalog({ publicDir: 'fixtures/bugs', secretDir: sec });
    assert.deepEqual(c.sources, { public: 3, secret: 1 });
  } finally {
    rmSync(sec, { recursive: true, force: true });
  }
});

test('public bug without removesDecoys is fine (gegenprobe)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'A01.mjs'), mod('A01'));
    const c = await loadCatalog({ publicDir: dir });
    assert.equal(c.bugs[0].source, 'public');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('decoys from public file and secret file are merged and validated', async () => {
  const dir = tmp();
  try {
    const decoysFile = join(dir, 'decoys.json');
    writeFileSync(decoysFile, JSON.stringify([{ id: 'D01', station: 'cart', title: 't', grader: 'g', conflicts: ['F01'] }]));
    const c = await loadCatalog({ publicDir: 'fixtures/bugs', decoysFile });
    assert.deepEqual(c.decoys.map((d) => d.id), ['D01']);
    writeFileSync(decoysFile, JSON.stringify([{ id: 'D01', station: 'cart', title: 't', grader: 'g', conflicts: ['x'] }]));
    await assert.rejects(loadCatalog({ publicDir: 'fixtures/bugs', decoysFile }), /decoys\.json.*conflicts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
