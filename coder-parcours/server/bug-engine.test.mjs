import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCatalog } from '../catalog/load.mjs';
import { buildRunConfig } from '../harness/seed.mjs';
import { createServer } from './app.mjs';
import { TEST_ACCOUNTS } from '../shared/accounts.mjs';
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

test('beacon decoding: valid beacons resolve, strangers and forgeries do not', () => {
  const { e } = engine('F03@schedule:all');
  const c = e.codesFor('F03');
  for (const v of [c.key, c.reached, c.passed]) assert.match(v, /^[0-9a-f]{8}$/);
  assert.notEqual(c.reached, c.passed);
  const r = e.makeBeacon('F03', 'reached');
  const p = e.makeBeacon('F03', 'passed');
  assert.deepEqual(e.decodeBeacon(r.b, r.e), { bug: 'F03', event: 'reached' });
  assert.deepEqual(e.decodeBeacon(p.b, p.e), { bug: 'F03', event: 'passed' });
  assert.equal(e.decodeBeacon('deadbeef', 'cafebabe'), null, 'random pair');
  assert.equal(e.decodeBeacon(r.b, 'cafebabe'), null, 'right b, random e');
  assert.equal(e.decodeBeacon(r.b, 'zz'), null);
  assert.equal(e.decodeBeacon(undefined, undefined), null);
});

test('beacon forgery: e of another beacon, swapped b/e, key as b are all rejected', () => {
  const { e } = engine('F03@schedule:all,F01@cart:phone');
  const r1 = e.makeBeacon('F03', 'reached', '11111111');
  const r2 = e.makeBeacon('F03', 'reached', '22222222');
  assert.notEqual(r1.e, r2.e, 'e is bound to b');
  assert.deepEqual(e.decodeBeacon(r2.b, r2.e), { bug: 'F03', event: 'reached' }, 'positive: r2 itself is valid');
  assert.equal(e.decodeBeacon(r2.b, r1.e), null, 'e of another beacon');
  assert.equal(e.decodeBeacon(r1.e, r1.b), null, 'b and e swapped');
  assert.equal(e.decodeBeacon(e.codesFor('F03').key, r1.e), null, 'the old constant key is no longer a b');
});

test('beacon event and bug are bound into e', () => {
  const { e } = engine('F03@schedule:all,F01@cart:phone');
  const b = '0a0b0c0d';
  const seen = [
    e.decodeBeacon(b, e.makeBeacon('F03', 'reached', b).e),
    e.decodeBeacon(b, e.makeBeacon('F03', 'passed', b).e),
    e.decodeBeacon(b, e.makeBeacon('F01', 'reached', b).e),
  ];
  assert.deepEqual(seen, [
    { bug: 'F03', event: 'reached' }, { bug: 'F03', event: 'passed' }, { bug: 'F01', event: 'reached' },
  ]);
});

test('trap beacons of repeated clicks use different b and look like neutral ones', () => {
  const { e } = engine('F03@schedule:all');
  const beacons = Array.from({ length: 12 }, () => e.makeBeacon('F03', 'reached'));
  assert.ok(new Set(beacons.map((x) => x.b)).size > 1, 'b varies');
  assert.ok(new Set(beacons.map((x) => x.e)).size > 1, 'e varies');
  for (const x of beacons) {
    assert.match(x.b, /^[0-9a-f]{8}$/);
    assert.match(x.e, /^[0-9a-f]{8}$/);
    assert.deepEqual(e.decodeBeacon(x.b, x.e), { bug: 'F03', event: 'reached' }, 'each one still decodes');
  }
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
    const c = eng.makeBeacon('F03', 'reached');
    const post = (b, e) => fetch(`${base}/api/metrics`, { method: 'POST', body: JSON.stringify({ b, e }) });
    assert.equal((await post(c.b, c.e)).status, 204);
    assert.equal((await post('deadbeef', 'cafebabe')).status, 204);
    const lines = readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const bugLines = lines.filter((l) => l.type === 'bug');
    assert.equal(bugLines.length, 1);
    assert.equal(bugLines[0].bug, 'F03');
    assert.equal(bugLines[0].event, 'reached');
  } finally { await h.close(); }
});

/** Real server with the real engine and the fixture catalog (plus optional extra bugs); returns a cookie-keeping fetch helper. */
async function serverWithEngine(activate, extraBugs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-engine-http-'));
  const staticDir = join(dir, 's');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
  const cat = { ...catalog, bugs: [...catalog.bugs, ...extraBugs] };
  const cfg = buildRunConfig({ seed: 2601, sessionType: 'explore', catalog: cat, activate });
  const srv = createServer({
    mode: 'single', runConfig: cfg, eventsFile: join(dir, 'events.jsonl'), staticDir,
    makeEngine: (rc, { logEvent }) => createBugEngine({ catalog: cat, runConfig: rc, logEvent }),
  });
  const h = await srv.listen(0);
  const base = `http://127.0.0.1:${h.port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const jar = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c));
    if (jar.length) cookie = [...new Set([...cookie.split('; ').filter(Boolean), ...jar])].join('; ');
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, close: () => h.close() };
}

test('engine hook proxy over HTTP: cart() and respond() of a before hook run through the proxy (F02), the control without the bug discounts', async () => {
  for (const [active, expectDiscount] of [[[{ id: 'F02', station: 'cart', width: 'all' }], false], [[], true]]) {
    const s = await serverWithEngine(active);
    try {
      const all = (await s.call('GET', '/api/classes')).json.classes;
      const k = all.find((c) => !c.ended && c.spotsLeft > 2);
      await s.call('POST', '/api/cart/items', { classId: k.id, spots: 1 });
      const r = await s.call('POST', '/api/cart/coupon', { code: 'YOGA10' });
      assert.equal(r.status, 200);
      assert.equal(r.json.items.length, 1, 'answer is the cart view');
      assert.equal(r.json.discountCents > 0, expectDiscount, expectDiscount ? 'control: coupon lowers the total' : 'bug: answer shows the unchanged cart');
    } finally { await s.close(); }
  }
});

test('engine hook proxy over HTTP: expireSession() called by a bug hook expires the session, the control without the bug keeps it', async () => {
  /** @type {any} */
  const f09 = {
    id: 'F09', category: 'timing', title: 't', stations: ['cart'], widths: ['all'], severity: 'low', symptom: 's', grader: 'g',
    server: { setup(api) { let fired = false; api.before('GET /api/cart', (ctx) => { if (!fired) { fired = true; ctx.expireSession(); } }); } },
  };
  for (const [active, expectExpired] of [[[{ id: 'F09', station: 'cart', width: 'all' }], true], [[], false]]) {
    const s = await serverWithEngine(active, [f09]);
    try {
      const [maya] = TEST_ACCOUNTS;
      assert.equal((await s.call('POST', '/api/auth/login', { email: maya.email, password: maya.password })).status, 200);
      assert.equal((await s.call('GET', '/api/profile')).status, 200, 'logged in before the hook fires');
      await s.call('GET', '/api/cart');
      const r = await s.call('GET', '/api/profile');
      assert.equal(r.status, expectExpired ? 401 : 200, expectExpired ? 'session expired by the bug hook' : 'control: no hook, session lives');
      if (expectExpired) assert.equal(r.json.error, 'session_expired');
    } finally { await s.close(); }
  }
});

test('beacon: a mac made from the key of one bug and the code of another bug resolves to nothing', async () => {
  const { e } = engine('F03@schedule:all,F01@cart:phone');
  const src = readFileSync(new URL('./client-runtime.js', import.meta.url), 'utf8');
  const mac = new Function(`${src}\nreturn __swMac;`)();
  const a = e.codesFor('F03');
  const b = e.codesFor('F01');
  const bb = '0badf00d';
  assert.deepEqual(e.decodeBeacon(bb, mac(`${a.key}|${a.reached}|${bb}`)), { bug: 'F03', event: 'reached' }, 'positive: own key + own code resolves');
  assert.equal(e.decodeBeacon(bb, mac(`${a.key}|${b.reached}|${bb}`)), null, 'key of F03 + code of F01');
  assert.equal(e.decodeBeacon(bb, mac(`${b.key}|${a.passed}|${bb}`)), null, 'key of F01 + code of F03');
});
