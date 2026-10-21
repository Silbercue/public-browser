import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prng, changeBrokenFor, activeCountFor, buildRunConfig, runConfigSha, loadSeeds } from './seed.mjs';
import { loadCatalog } from '../catalog/load.mjs';
import { createHash } from 'node:crypto';

const SEEDS = Array.from({ length: 100 }, (_, i) => 1000 + i * 7);

/**
 * Synthetic public pool like Task 7/8: 4 fiddly, 4 next-step, 2 layout, 3 function,
 * 3 timing (traps), 1 background; 3 change roles, 2 capture roles.
 * @returns {any[]}
 */
function publicPool17() {
  const spec = [
    ['fiddly', ['phone'], ['cart', 'checkout']],
    ['fiddly', ['phone'], ['schedule']],
    ['fiddly', ['tablet'], ['class-detail', 'schedule']],
    ['fiddly', ['all'], ['login']],
    ['next-step', ['phone'], ['checkout']],
    ['next-step', ['phone'], ['register', 'login']],
    ['next-step', ['desktop'], ['bookings']],
    ['next-step', ['all'], ['profile']],
    ['layout', ['phone'], ['home']],
    ['layout', ['desktop'], ['schedule']],
    ['function', ['all'], ['cart'], { change: { feature: 'c1' } }],
    ['function', ['all'], ['profile'], { change: { feature: 'c2' }, capture: { flow: 'f1' } }],
    ['function', ['all'], ['settings'], { capture: { flow: 'f2' } }],
    ['timing', ['all'], ['bookings'], { trap: { reached: 'r', passed: 'p' } }],
    ['timing', ['phone', 'desktop'], ['checkout'], { trap: { reached: 'r', passed: 'p' } }],
    ['timing', ['all'], ['class-detail'], { trap: { reached: 'r', passed: 'p' } }],
    ['background', ['all'], ['schedule'], { change: { feature: 'c3' } }],
  ];
  return spec.map(([category, widths, stations, roles], i) => ({
    id: `P${String(i + 1).padStart(2, '0')}`,
    category,
    title: `t${i}`,
    stations,
    widths,
    severity: 'medium',
    symptom: 's',
    grader: 'g',
    client: { css: () => '' },
    ...(roles ? { roles } : {}),
    source: 'public',
  }));
}

/** @returns {any[]} */
function secretPool8() {
  const widths = [['phone'], ['tablet'], ['desktop'], ['all'], ['phone', 'tablet'], ['all'], ['desktop'], ['phone']];
  return widths.map((w, i) => ({
    id: `S${String(i + 1).padStart(2, '0')}`,
    category: 'layout',
    title: `s${i}`,
    stations: ['cart', 'home'],
    widths: w,
    severity: 'low',
    symptom: 's',
    grader: 'g',
    client: { css: () => '' },
    removesDecoys: [],
    source: 'secret',
  }));
}

/** @returns {any} */
function catalogOf(bugs, decoys = []) {
  return {
    bugs,
    decoys,
    unplanned: [],
    sources: {
      public: bugs.filter((b) => b.source !== 'secret').length,
      secret: bugs.filter((b) => b.source === 'secret').length,
    },
  };
}

const key = (a) => `${a.id}@${a.station}:${a.width}`;
/** active without the broken change target ("zusaetzlich") */
const nonChange = (cfg) => cfg.active.filter((a) => !cfg.change || a.id !== cfg.change.bugId);

test('prng is deterministic per key and in [0,1)', () => {
  const a = prng('x'), b = prng('x'), c = prng('y');
  const va = [a(), a(), a()], vb = [b(), b(), b()], vc = [c(), c(), c()];
  assert.deepEqual(va, vb);
  assert.notDeepEqual(va, vc);
  for (const v of va) assert.ok(v >= 0 && v < 1);
});

test('prng is mulberry32 over the first 4 bytes of sha256(key)', () => {
  let a = createHash('sha256').update('2601:broken').digest().readUInt32BE(0);
  const ref = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = prng('2601:broken');
  for (let i = 0; i < 5; i++) assert.equal(r(), ref());
});

test('activeCountFor ranges', () => {
  const seen17 = new Set(), seen25 = new Set();
  for (let i = 0; i < 300; i++) {
    seen17.add(activeCountFor(17, prng(`a${i}`)));
    seen25.add(activeCountFor(25, prng(`b${i}`)));
  }
  assert.deepEqual([...seen17].sort(), [6, 7, 8]);
  assert.deepEqual([...seen25].sort(), [10, 11, 9]);
  assert.equal(activeCountFor(1, () => 0), 1);
  assert.equal(activeCountFor(8, () => 0), 2);
  assert.equal(activeCountFor(8, () => 0.99), 4);
});

test('changeBrokenFor depends only on the seed and mixes', () => {
  let t = 0;
  for (const s of SEEDS) {
    assert.equal(changeBrokenFor(s), changeBrokenFor(s));
    if (changeBrokenFor(s)) t++;
  }
  assert.ok(t > 20 && t < 80, `broken ${t}/100`);
});

test('same seed gives identical RunConfig; change.broken equals changeBrokenFor with and without secret pool', () => {
  const pub = catalogOf(publicPool17());
  const both = catalogOf([...publicPool17(), ...secretPool8()]);
  for (const seed of SEEDS.slice(0, 20)) {
    const a = buildRunConfig({ seed, sessionType: 'explore', catalog: pub });
    const b = buildRunConfig({ seed, sessionType: 'explore', catalog: pub });
    assert.deepEqual(a, b);
    assert.equal(runConfigSha(a), runConfigSha(b));
    const c = buildRunConfig({ seed, sessionType: 'explore', catalog: both });
    assert.equal(a.change?.broken, changeBrokenFor(seed));
    assert.equal(c.change?.broken, changeBrokenFor(seed));
    assert.deepEqual(c.change, a.change);
  }
});

test('explore: change target from change roles, stations[0], width all; in active only when broken', () => {
  const cat = catalogOf(publicPool17());
  let brokenSeen = 0, healthySeen = 0;
  for (const seed of SEEDS) {
    const cfg = buildRunConfig({ seed, sessionType: 'explore', catalog: cat });
    assert.equal(cfg.seed, seed);
    assert.equal(cfg.sessionType, 'explore');
    assert.equal(cfg.variant, null);
    assert.equal(cfg.capture, null);
    assert.ok(cfg.change);
    const target = cat.bugs.find((b) => b.id === cfg.change.bugId);
    assert.ok(target.roles?.change);
    assert.deepEqual(cfg.change.activation, { id: target.id, station: target.stations[0], width: 'all' });
    const inActive = cfg.active.filter((a) => a.id === target.id);
    if (cfg.change.broken) {
      brokenSeen++;
      assert.deepEqual(inActive, [cfg.change.activation]);
    } else {
      healthySeen++;
      assert.deepEqual(inActive, []);
    }
  }
  assert.ok(brokenSeen > 0 && healthySeen > 0);
});

test('stratification over 100 seeds: trap, phone/tablet/desktop, fiddly, next-step, count 6..8', () => {
  const cat = catalogOf(publicPool17());
  const byId = new Map(cat.bugs.map((b) => [b.id, b]));
  for (const seed of SEEDS) {
    const cfg = buildRunConfig({ seed, sessionType: 'explore', catalog: cat });
    const acts = nonChange(cfg);
    assert.ok(acts.length >= 6 && acts.length <= 8, `seed ${seed}: ${acts.length}`);
    assert.equal(new Set(acts.map((a) => a.id)).size, acts.length, 'no duplicate ids');
    const bugs = acts.map((a) => byId.get(a.id));
    assert.ok(bugs.some((b) => b.roles?.trap), `seed ${seed}: trap`);
    for (const w of ['phone', 'tablet', 'desktop']) assert.ok(acts.some((a) => a.width === w), `seed ${seed}: ${w}`);
    assert.ok(bugs.some((b) => b.category === 'fiddly'), `seed ${seed}: fiddly`);
    assert.ok(bugs.some((b) => b.category === 'next-step'), `seed ${seed}: next-step`);
    for (const a of acts) {
      const b = byId.get(a.id);
      assert.ok(b.stations.includes(a.station), `station ${key(a)}`);
      assert.ok(b.widths.includes(a.width), `width ${key(a)}`);
    }
  }
});

test('phone-only bug never gets another width (100 seeds)', () => {
  const cat = catalogOf(publicPool17());
  const phoneOnly = new Set(cat.bugs.filter((b) => b.widths.length === 1 && b.widths[0] === 'phone').map((b) => b.id));
  let seen = 0;
  for (const seed of SEEDS) {
    for (const a of buildRunConfig({ seed, sessionType: 'explore', catalog: cat }).active) {
      if (phoneOnly.has(a.id)) {
        seen++;
        assert.equal(a.width, 'phone');
      }
    }
  }
  assert.ok(seen > 50, `phone-only activations seen: ${seen}`);
});

test('secret pool adds 2..4 and keeps every public activation unchanged (100 seeds)', () => {
  const pub = catalogOf(publicPool17());
  const both = catalogOf([...publicPool17(), ...secretPool8()]);
  const secretIds = new Set(secretPool8().map((b) => b.id));
  for (const seed of SEEDS) {
    const a = buildRunConfig({ seed, sessionType: 'explore', catalog: pub });
    const b = buildRunConfig({ seed, sessionType: 'explore', catalog: both });
    const bKeys = new Set(b.active.map(key));
    for (const act of a.active) assert.ok(bKeys.has(key(act)), `seed ${seed}: ${key(act)} missing`);
    const secret = b.active.filter((x) => secretIds.has(x.id));
    assert.ok(secret.length >= 2 && secret.length <= 4, `seed ${seed}: secret ${secret.length}`);
    assert.equal(b.active.length, a.active.length + secret.length);
    const total = nonChange(b).length;
    assert.ok(total >= 8 && total <= 12, `seed ${seed}: total ${total}`);
    assert.deepEqual(b.sources, { public: 17, secret: 8 });
    assert.deepEqual(a.sources, { public: 17, secret: 0 });
  }
});

test('capture: no active, no change, target from capture roles; variant broken activates exactly the target', () => {
  const cat = catalogOf(publicPool17());
  for (const seed of SEEDS.slice(0, 20)) {
    const plain = buildRunConfig({ seed, sessionType: 'capture', catalog: cat });
    assert.deepEqual(plain.active, []);
    assert.equal(plain.change, null);
    const target = cat.bugs.find((b) => b.id === plain.capture?.bugId);
    assert.ok(target?.roles?.capture);
    const healthy = buildRunConfig({ seed, sessionType: 'capture', catalog: cat, variant: 'healthy' });
    assert.deepEqual(healthy.active, []);
    assert.equal(healthy.variant, 'healthy');
    const broken = buildRunConfig({ seed, sessionType: 'capture', catalog: cat, variant: 'broken' });
    assert.equal(broken.variant, 'broken');
    assert.deepEqual(broken.capture, plain.capture);
    assert.deepEqual(broken.active, [{ id: target.id, station: target.stations[0], width: 'all' }]);
  }
});

test('capture variant broken with fixtures activates F02', async () => {
  const cat = await loadCatalog({ publicDir: 'fixtures/bugs' });
  const cfg = buildRunConfig({ seed: 7, sessionType: 'capture', catalog: cat, variant: 'broken' });
  assert.deepEqual(cfg.capture, { bugId: 'F02' });
  assert.deepEqual(cfg.active, [{ id: 'F02', station: 'cart', width: 'all' }]);
});

test('no role in pool: change and capture are null', () => {
  const noRoles = catalogOf(publicPool17().map(({ roles, ...b }) => b));
  const e = buildRunConfig({ seed: 1, sessionType: 'explore', catalog: noRoles });
  assert.equal(e.change, null);
  assert.ok(e.active.length >= 6);
  const c = buildRunConfig({ seed: 1, sessionType: 'capture', catalog: noRoles, variant: 'broken' });
  assert.equal(c.capture, null);
  assert.deepEqual(c.active, []);
});

test('change and capture targets never come from the secret pool', () => {
  const sec = secretPool8().map((b) => ({ ...b, widths: ['all'], category: 'function', roles: { change: { feature: 'x' }, capture: { flow: 'y' } } }));
  const cat = catalogOf([...publicPool17(), ...sec]);
  for (const seed of SEEDS.slice(0, 30)) {
    assert.match(buildRunConfig({ seed, sessionType: 'explore', catalog: cat }).change.bugId, /^P/);
    assert.match(buildRunConfig({ seed, sessionType: 'capture', catalog: cat }).capture.bugId, /^P/);
  }
});

test('activate replaces active completely', () => {
  const cat = catalogOf(publicPool17());
  /** @type {any} */
  const activate = [{ id: 'P01', station: 'checkout', width: 'phone' }];
  const cfg = buildRunConfig({ seed: 3, sessionType: 'explore', catalog: cat, activate });
  assert.deepEqual(cfg.active, activate);
  assert.throws(() => buildRunConfig({ seed: 3, sessionType: 'explore', catalog: cat, activate: [{ id: 'Z99', station: 'cart', width: 'all' }] }), /Z99/);
});

test('decoys: conflicts and removesDecoys drop a decoy, otherwise it stays', async () => {
  const cat = await loadCatalog({ publicDir: 'fixtures/bugs', secretDir: 'fixtures/secret' });
  cat.decoys = [
    { id: 'D01', station: 'cart', title: 't', grader: 'g', conflicts: ['F01'] },
    { id: 'D02', station: 'home', title: 't', grader: 'g' },
  ];
  const run = (/** @type {any} */ activate) => buildRunConfig({ seed: 5, sessionType: 'explore', catalog: cat, activate }).decoys;
  assert.deepEqual(run([{ id: 'F01', station: 'cart', width: 'phone' }]), ['D02']);
  assert.deepEqual(run([{ id: 'F03', station: 'cart', width: 'all' }]), ['D01', 'D02']);
  assert.deepEqual(run([{ id: 'S90', station: 'cart', width: 'phone' }]), ['D02']);
  assert.deepEqual(run([]), ['D01', 'D02']);
});

test('runConfigSha is key-order independent and 64 hex', () => {
  const a = { b: 1, a: [{ y: 2, x: 1 }] };
  const b = { a: [{ x: 1, y: 2 }], b: 1 };
  assert.equal(runConfigSha(a), runConfigSha(b));
  assert.match(runConfigSha(a), /^[0-9a-f]{64}$/);
  assert.notEqual(runConfigSha(a), runConfigSha({ ...a, b: 2 }));
});

test('loadSeeds: five integers, changeBrokenFor at least 2x true and 2x false', () => {
  const seeds = loadSeeds();
  assert.equal(seeds.length, 5);
  assert.ok(seeds.every((s) => Number.isInteger(s)));
  const t = seeds.filter((s) => changeBrokenFor(s)).length;
  assert.ok(t >= 2 && 5 - t >= 2, `broken ${t}/5`);
});

test('golden values: fixed seeds give fixed run configurations (the draw keys :change, :active, :secret, :capture are pinned)', () => {
  const both = catalogOf([...publicPool17(), ...secretPool8()]);
  const pub = catalogOf(publicPool17());
  const GOLD = {
    2601: {
      sha: '6038cf4b6a1d46328cf129a7dbcc717259b29681bd53c77537970cba7e342b86', shaPub: '6915a10ace881a7e9a1028233aa39dd3d7d702f29d7fd176dd625418c98104d2',
      active: ['P14@bookings:all', 'P05@checkout:phone', 'P03@schedule:tablet', 'P10@schedule:desktop', 'P09@home:phone', 'P02@schedule:phone', 'S05@home:tablet', 'S02@cart:tablet', 'S01@home:phone'],
      change: 'P12', capture: 'P13',
    },
    2602: {
      sha: '0d39b2de8813aac15a48a5b22285ca85272fe4a7f5212ea12ce87d2ad2941f6c', shaPub: 'd85db37bd784a0473df1f0dfb7cf44050f013963ee1a9637be4190d5322f4932',
      active: ['P12@profile:all', 'P16@class-detail:all', 'P06@login:phone', 'P03@schedule:tablet', 'P10@schedule:desktop', 'P07@bookings:desktop', 'P14@bookings:all', 'S02@cart:tablet', 'S08@home:phone', 'S03@home:desktop'],
      change: 'P12', capture: 'P13',
    },
    2611: {
      sha: '2eef7b504c719c71439bbbae6a3189aaaeea46ca17a40336712cfc898177178c', shaPub: '1ea6bb92061472bda31f7a7ece2543e4c56ffd4b939a2ca67ae2eb2152281ba7',
      active: ['P12@profile:all', 'P14@bookings:all', 'P02@schedule:phone', 'P03@class-detail:tablet', 'P15@checkout:desktop', 'P08@profile:all', 'P10@schedule:desktop', 'P04@login:all', 'P17@schedule:all', 'S04@cart:all', 'S03@cart:desktop'],
      change: 'P12', capture: 'P13',
    },
  };
  for (const [seed, g] of Object.entries(GOLD)) {
    const e = buildRunConfig({ seed: Number(seed), sessionType: 'explore', catalog: both });
    assert.deepEqual(e.active.map(key), g.active, `seed ${seed}: active list`);
    assert.equal(e.change?.bugId, g.change, `seed ${seed}: change target`);
    assert.equal(runConfigSha(e), g.sha, `seed ${seed}: checksum with the secret pool`);
    assert.equal(runConfigSha(buildRunConfig({ seed: Number(seed), sessionType: 'explore', catalog: pub })), g.shaPub, `seed ${seed}: checksum without the secret pool`);
    assert.equal(buildRunConfig({ seed: Number(seed), sessionType: 'capture', catalog: both }).capture?.bugId, g.capture, `seed ${seed}: capture target`);
  }
});

test('stratifiedPublic keeps the required picks complete even when the drawn count is smaller', () => {
  const one = (id, widths, over = {}) => ({ id, category: 'layout', title: id, stations: ['cart'], widths, severity: 'low', symptom: 's', grader: 'g', client: { css: () => '' }, source: 'public', ...over });
  const cat = catalogOf([
    one('P01', ['phone'], { category: 'timing', roles: { trap: { reached: 'r', passed: 'p' } } }),
    one('P02', ['tablet']), one('P03', ['desktop']), one('P04', ['all']), one('P05', ['all']),
  ]);
  let small = 0;
  for (const seed of SEEDS) {
    const count = activeCountFor(5, prng(`${seed}:active`));
    if (count < 3) small++;
    const cfg = buildRunConfig({ seed, sessionType: 'explore', catalog: cat });
    const widths = new Set(cfg.active.map((a) => a.width));
    assert.ok(cfg.active.some((a) => a.id === 'P01'), `seed ${seed}: the trap is there`);
    for (const w of /** @type {const} */ (['phone', 'tablet', 'desktop'])) assert.ok(widths.has(w), `seed ${seed}: ${w} covered although the count was ${count}`);
    assert.ok(cfg.active.length >= 3);
  }
  assert.ok(small > 0, 'Gegenprobe: some seeds really draw fewer than the 3 required picks');
});

test('a healthy change target removes no decoy, a broken one removes its decoys', () => {
  const pool = publicPool17();
  for (const b of pool) if (b.id !== 'P12' && b.roles?.change) delete b.roles.change; // P12 is the only change target
  const target = (c) => pool.find((b) => b.roles?.change && b.id === c);
  const p12 = pool.find((b) => b.id === 'P12');
  p12.removesDecoys = ['D01'];
  const cat = catalogOf(pool, [{ id: 'D01', station: 'cart', title: 't', grader: 'g' }, { id: 'D02', station: 'home', title: 't', grader: 'g' }]);
  assert.ok(target('P12'));
  let healthy = 0;
  let broken = 0;
  for (const seed of SEEDS) {
    const cfg = buildRunConfig({ seed, sessionType: 'explore', catalog: cat });
    assert.equal(cfg.change.bugId, 'P12');
    if (cfg.change.broken) { broken++; assert.deepEqual(cfg.decoys, ['D02'], `seed ${seed}: broken target is active and removes D01`); }
    else { healthy++; assert.deepEqual(cfg.decoys, ['D01', 'D02'], `seed ${seed}: healthy target is not active, D01 stays`); }
  }
  assert.ok(healthy > 5 && broken > 5, `both cases occurred (${healthy}/${broken})`);
});

test('golden values: the capture and change targets of 20 fixed seeds are pinned (draw keys :capture and :change are independent)', () => {
  const both = catalogOf([...publicPool17(), ...secretPool8()]);
  const first = SEEDS.slice(0, 20);
  assert.equal(first.map((seed) => buildRunConfig({ seed, sessionType: 'capture', catalog: both }).capture.bugId).join(','),
    'P13,P13,P13,P13,P13,P13,P13,P13,P12,P12,P13,P12,P13,P12,P13,P12,P13,P13,P12,P13');
  assert.equal(first.map((seed) => buildRunConfig({ seed, sessionType: 'explore', catalog: both }).change.bugId).join(','),
    'P17,P11,P17,P11,P12,P11,P12,P17,P17,P17,P12,P11,P11,P11,P17,P12,P17,P17,P12,P17');
});
