import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../catalog/load.mjs';
import { buildRunConfig } from '../harness/seed.mjs';
import { createServer } from './app.mjs';
import { createBugEngine, RUNTIME_MARKER } from './bug-engine.mjs';

const catalog = await loadCatalog({ publicDir: 'fixtures/bugs' });
const cfgFor = (activate) => buildRunConfig({ seed: 2601, sessionType: 'explore', catalog, activate });

/** @param {string} list e.g. 'F01@cart:phone' @param {object} [extra] */
function engine(list, extra = {}) {
  const activate = list.split(',').filter(Boolean).map((p) => {
    const m = /^(\w+)@([a-z-]+):(\w+)$/.exec(p);
    return { id: m[1], station: m[2], width: m[3] };
  });
  const events = [];
  const e = createBugEngine({ catalog, runConfig: cfgFor(activate), logEvent: (x) => events.push(x), ...extra });
  return { e, events };
}

test('script holds neither ids, titles, nor the beacon words', () => {
  const { e } = engine('F01@cart:phone,F03@schedule:all');
  const script = e.runtimeScript();
  for (const bad of ['F01', 'F02', 'F03', 'Cart buttons shrink', 'Schedule buttons need', 'reached', 'passed']) {
    assert.ok(!script.includes(bad), `script must not contain ${bad}`);
  }
  assert.ok(script.includes(RUNTIME_MARKER));
  assert.ok(script.includes('swallowFirstClick'), 'positive: the runtime itself is in the script');
});

test('script without active bugs still carries the marker and no bug code', () => {
  const { e } = engine('');
  const script = e.runtimeScript();
  assert.ok(script.includes(RUNTIME_MARKER));
  assert.ok(!script.includes('__sw.run('), 'no bug is started');
  assert.deepEqual(e.activeIds, []);
});

test('only active bugs are loaded; inactive ones are absent', () => {
  const { e } = engine('F01@cart:phone');
  assert.deepEqual(e.activeIds, ['F01']);
  assert.throws(() => e.codesFor('F03'));
  assert.ok(e.codesFor('F01').key);
  assert.equal(engine('F01@cart:phone').e.runtimeScript().includes('__sw.run('), false, 'F01 is css only');
  assert.equal(engine('F03@schedule:all').e.runtimeScript().includes('__sw.run('), true);
});

test('css is wrapped in the media query of the width, not for all', () => {
  const css = engine('F01@cart:phone').e.runtimeScript();
  assert.ok(css.includes('@media (max-width: 600px)'));
  assert.ok(css.includes('data-section=\\"cart\\"'), 'ctx.section reaches the css function');
  const tablet = engine('F01@cart:tablet').e.runtimeScript();
  assert.ok(tablet.includes('@media (min-width: 601px) and (max-width: 1100px)'));
  assert.ok(!tablet.includes('(max-width: 600px)'));
  const all = engine('F01@cart:all').e.runtimeScript();
  assert.ok(all.includes('min-height: 0'), 'css present');
  assert.ok(!all.includes('@media'), 'all: no media wrapper');
});

test('setup source ships as a function expression even for method shorthand', () => {
  const script = engine('F03@schedule:all').e.runtimeScript();
  const m = /__sw\.run\("([0-9a-f]{8})", (\{[^\n]*?\}), (.*)\);/s.exec(script);
  assert.ok(m, 'run call found');
  assert.deepEqual(Object.keys(JSON.parse(m[2])).sort(), ['media', 'section', 'station', 'width']);
  assert.doesNotThrow(() => new Function(`return (${m[3]});`));
});

test('F02 before hook answers the coupon request', async () => {
  const { e } = engine('F02@cart:all');
  let answered = null;
  const ctx = { respond: (s, b) => { answered = { s, b }; }, cart: async () => ({ total: 5 }) };
  assert.equal(await e.hooks.runBefore('POST /api/cart/coupon', ctx), true);
  assert.deepEqual(answered, { s: 200, b: { total: 5 } });
  assert.equal(await engine('F01@cart:phone').e.hooks.runBefore('POST /api/cart/coupon', { respond() {} }), false);
});

test('beacon decoding: known code resolves, strangers do not', () => {
  const { e } = engine('F03@schedule:all');
  const c = e.codesFor('F03');
  for (const v of [c.key, c.reached, c.passed]) assert.match(v, /^[0-9a-f]{8}$/);
  assert.deepEqual(e.decodeBeacon(c.key, c.reached), { bug: 'F03', event: 'reached' });
  assert.deepEqual(e.decodeBeacon(c.key, c.passed), { bug: 'F03', event: 'passed' });
  assert.equal(e.decodeBeacon('deadbeef', c.reached), null, 'foreign key');
  assert.equal(e.decodeBeacon(c.key, 'deadbeef'), null, 'random code');
  assert.equal(e.decodeBeacon(c.key, 'zz'), null);
  assert.equal(e.decodeBeacon(undefined, undefined), null);
  assert.notEqual(c.reached, c.passed);
});

test('codes differ per salt and per engine', () => {
  const a = engine('F03@schedule:all', { salt: 'one' }).e.codesFor('F03');
  const b = engine('F03@schedule:all', { salt: 'two' }).e.codesFor('F03');
  assert.notEqual(a.key, b.key);
  const x = engine('F03@schedule:all').e.codesFor('F03');
  const y = engine('F03@schedule:all').e.codesFor('F03');
  assert.notEqual(x.reached, y.reached);
});

test('hook events carry the bug id; setup-level events too', async () => {
  /** @type {any} */
  const cat = { ...catalog, bugs: [...catalog.bugs, {
    id: 'F09', category: 'timing', title: 't', stations: ['cart'], widths: ['all'], severity: 'low', symptom: 's', grader: 'g',
    server: { setup(api) { api.after('GET /api/x', (ctx) => { ctx.event('reached'); ctx.validate = false; }); api.event('passed'); } },
  }] };
  const events = [];
  const e = createBugEngine({ catalog: cat, runConfig: { ...cfgFor(null), active: [{ id: 'F09', station: 'cart', width: 'all' }] }, logEvent: (x) => events.push(x) });
  assert.deepEqual(events, [{ type: 'bug', bug: 'F09', event: 'passed' }]);
  const seen = [];
  const ctx = { validate: true, event: (n, b) => seen.push([n, b]) };
  await e.hooks.runAfter('GET /api/x', ctx, {});
  assert.deepEqual(seen, [['reached', 'F09']]);
  assert.equal(ctx.validate, false, 'writes reach the real context');
});

test('through the server: metrics beacon with a trap code writes a bug line, a stranger writes none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-engine-'));
  const staticDir = join(dir, 's');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  const eventsFile = join(dir, 'events.jsonl');
  let eng;
  const cfg = cfgFor([{ id: 'F03', station: 'schedule', width: 'all' }]);
  const srv = createServer({
    mode: 'single', runConfig: cfg, eventsFile, staticDir,
    makeEngine: (rc, { logEvent }) => (eng = createBugEngine({ catalog, runConfig: rc, logEvent })),
  });
  const h = await srv.listen(0);
  try {
    const base = `http://127.0.0.1:${h.port}`;
    const js = await (await fetch(`${base}/assets/runtime.js`)).text();
    assert.ok(js.includes(RUNTIME_MARKER));
    const c = eng.codesFor('F03');
    const post = (b, e) => fetch(`${base}/api/metrics`, { method: 'POST', body: JSON.stringify({ b, e }) });
    assert.equal((await post(c.key, c.reached)).status, 204);
    assert.equal((await post('deadbeef', 'cafebabe')).status, 204);
    const lines = readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bugLines = lines.filter((l) => l.type === 'bug');
    assert.equal(bugLines.length, 1);
    assert.equal(bugLines[0].bug, 'F03');
    assert.equal(bugLines[0].event, 'reached');
  } finally { await h.close(); }
});
