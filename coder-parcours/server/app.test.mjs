import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, nullEngine } from './app.mjs';
import { createHookSet } from './hooks.mjs';
import { CLASSES, STUDIO_CLOCK } from './data.mjs';
import { hostedConfigForSeed } from './start.mjs';
import { TEST_ACCOUNTS } from '../shared/accounts.mjs';
import { buildRunConfig, loadSeeds } from '../harness/seed.mjs';
import { loadCatalog } from '../catalog/load.mjs';

const [MAYA, SAM] = TEST_ACCOUNTS;

/** @param {any} [overrides] */
async function start(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-server-'));
  const staticDir = join(dir, 'static');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>');
  const eventsFile = join(dir, 'events.jsonl');
  const reportsFile = join(dir, 'reports.jsonl');
  const runConfig = { seed: 2601, sessionType: 'explore', variant: null, sources: { public: 0, secret: 0 }, active: [], change: null, capture: null, decoys: [] };
  const srv = createServer({ mode: 'single', runConfig, eventsFile, reportsFile, staticDir, ...overrides });
  const handle = await srv.listen(0);
  const base = `http://127.0.0.1:${handle.port}`;
  return { dir, base, handle, eventsFile, reportsFile, staticDir, srv };
}

/** Minimal client with its own cookie jar. */
function client(base) {
  /** @type {Map<string,string>} */
  const jar = new Map();
  /**
   * @param {string} method
   * @param {string} path
   * @param {any} [body]
   * @param {Record<string,string>} [headers]
   */
  async function req(method, path, body, headers = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      const expired = attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a)) || v === '';
      if (expired) jar.delete(k.trim()); else jar.set(k.trim(), v.trim());
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    jar,
    get: (p, h) => req('GET', p, undefined, h),
    post: (p, b = {}, h) => req('POST', p, b, h),
    put: (p, b = {}) => req('PUT', p, b),
    patch: (p, b = {}) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
    login: (acc = MAYA) => req('POST', '/api/auth/login', { email: acc.email, password: acc.password }),
  };
}

/** @param {string} file */
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** A future class with free spots that Maya has not booked. */
async function freeClass(c) {
  const all = (await c.get('/api/classes')).json.classes;
  const mine = new Set(['c08', 'c11']);
  return all.find((k) => !k.ended && k.spotsLeft > 2 && !mine.has(k.id));
}

test('data: 14 classes Mon-Sun, styles, levels, prices, capacities, two full, ended before Wednesday 10:00', async () => {
  assert.equal(CLASSES.length, 14);
  assert.deepEqual(new Set(CLASSES.map((k) => k.day)), new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']));
  assert.deepEqual(new Set(CLASSES.map((k) => k.style)), new Set(['Vinyasa', 'Yin', 'Hatha', 'Power']));
  assert.deepEqual(new Set(CLASSES.map((k) => k.level)), new Set(['Beginner', 'All levels', 'Advanced']));
  for (const k of CLASSES) {
    assert.ok(k.priceCents >= 1800 && k.priceCents <= 2600, k.id);
    assert.ok(k.capacity >= 12 && k.capacity <= 20, k.id);
    assert.ok(k.teacher.length > 2);
    assert.equal(k.reviews.length, 3);
  }
  assert.deepEqual(STUDIO_CLOCK, { day: 'Wed', time: '10:00' });
  const s = await start();
  try {
    const c = client(s.base);
    const { json } = await c.get('/api/classes');
    assert.equal(json.classes.length, 14);
    assert.equal(json.classes.filter((k) => k.spotsLeft === 0).length, 2);
    assert.ok(json.classes.filter((k) => k.spotsLeft === 0).every((k) => !k.ended));
    const ended = json.classes.filter((k) => k.ended);
    assert.ok(ended.length > 0 && ended.every((k) => ['Mon', 'Tue', 'Wed'].includes(k.day)));
    assert.ok(json.classes.some((k) => k.day === 'Wed' && !k.ended));
    assert.equal(json.classes[0].currency, 'USD');
    const filtered = (await c.get('/api/classes?day=fri&style=Yin')).json.classes;
    assert.ok(filtered.length >= 1 && filtered.every((k) => k.day === 'Fri' && k.style === 'Yin'));
    assert.equal((await c.get('/api/classes?level=Advanced')).json.classes.every((k) => k.level === 'Advanced'), true);
    assert.equal((await c.get('/api/classes/c08')).json.id, 'c08');
    assert.equal((await c.get('/api/classes/nope')).json.error, 'class_not_found');
    assert.equal((await c.get('/api/classes/c08/reviews')).json.reviews.length, 3);
    await c.login();
    assert.equal((await c.get('/api/bookings')).json.bookings.length, 2);
  } finally { await s.handle.close(); }
});

test('coupon: YOGA10 once, SPRING25 expired, empty, unknown', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    const k = await freeClass(c);
    assert.equal((await c.post('/api/cart/items', { classId: k.id, spots: 2 })).status, 200);
    const r1 = await c.post('/api/cart/coupon', { code: 'YOGA10' });
    assert.equal(r1.status, 200);
    assert.equal(r1.json.subtotalCents, 2 * k.priceCents);
    assert.equal(r1.json.discountCents, Math.round(0.1 * 2 * k.priceCents));
    assert.equal(r1.json.totalCents, r1.json.subtotalCents - r1.json.discountCents);
    const r2 = await c.post('/api/cart/coupon', { code: 'YOGA10' });
    assert.equal(r2.json.discountCents, r1.json.discountCents);
    let r = await c.post('/api/cart/coupon', { code: 'SPRING25' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'coupon_expired', 'This code expired on March 31.']);
    r = await c.post('/api/cart/coupon', { code: '  ' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'coupon_empty', 'Enter a coupon code.']);
    r = await c.post('/api/cart/coupon', { code: 'FREE' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'coupon_unknown', "We don't know this code."]);
  } finally { await s.handle.close(); }
});

test('cart: same class increases, spots range, full and ended classes, patch and delete', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    const { json: { classes } } = await c.get('/api/classes');
    const k = await freeClass(c);
    await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    const cart = (await c.post('/api/cart/items', { classId: k.id, spots: 2 })).json;
    assert.equal(cart.items.length, 1);
    assert.equal(cart.items[0].spots, 3);
    let r = await c.post('/api/cart/items', { classId: k.id, spots: 6 });
    assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'spots_range', 'Choose between 1 and 5 spots.']);
    r = await c.patch(`/api/cart/items/${cart.items[0].id}`, { spots: 0 });
    assert.equal(r.json.error, 'spots_range');
    r = await c.patch(`/api/cart/items/${cart.items[0].id}`, { spots: 5 });
    assert.equal(r.json.items[0].spots, 5);
    const full = classes.find((x) => x.spotsLeft === 0);
    r = await c.post('/api/cart/items', { classId: full.id, spots: 1 });
    assert.deepEqual([r.status, r.json.error], [409, 'class_full']);
    const ended = classes.find((x) => x.ended);
    r = await c.post('/api/cart/items', { classId: ended.id, spots: 1 });
    assert.deepEqual([r.status, r.json.error], [409, 'class_ended']);
    r = await c.del(`/api/cart/items/${cart.items[0].id}`);
    assert.equal(r.json.items.length, 0);
  } finally { await s.handle.close(); }
});

test('checkout: without login 401, terms, empty cart, success, double booking 409', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    const k = await freeClass(c);
    await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    let r = await c.post('/api/checkout', { acceptTerms: true });
    assert.deepEqual([r.status, r.json.error, r.json.message], [401, 'login_required', 'Please log in to continue.']);
    await c.login();
    r = await c.post('/api/checkout', { acceptTerms: false });
    assert.deepEqual([r.status, r.json.error], [400, 'terms_required']);
    r = await c.post('/api/checkout', { acceptTerms: true });
    assert.equal(r.status, 200);
    assert.match(r.json.reference, /^SW-[A-Z0-9]{4}$/);
    assert.equal((await c.get('/api/cart')).json.items.length, 0);
    r = await c.post('/api/checkout', { acceptTerms: true });
    assert.deepEqual([r.status, r.json.error], [400, 'cart_empty']);
    await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    r = await c.post('/api/checkout', { acceptTerms: true });
    assert.deepEqual([r.status, r.json.error, r.json.message], [409, 'already_booked', 'You already booked this class.']);
    const after = (await c.get(`/api/classes/${k.id}`)).json;
    assert.equal(after.spotsLeft, k.spotsLeft - 1);
  } finally { await s.handle.close(); }
});

test('bookings: cancel frees spots, reschedule only same style, future, not full', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    await c.login();
    const { json: { bookings } } = await c.get('/api/bookings');
    const b = bookings[0];
    const before = (await c.get(`/api/classes/${b.classId}`)).json.spotsLeft;
    const classes = (await c.get('/api/classes')).json.classes;
    const sameStyle = classes.find((k) => k.style === b.class.style && k.id !== b.classId && !k.ended && k.spotsLeft >= b.spots);
    const otherStyle = classes.find((k) => k.style !== b.class.style && !k.ended && k.spotsLeft > 0);
    let r = await c.post(`/api/bookings/${b.id}/reschedule`, { classId: otherStyle.id });
    assert.deepEqual([r.status, r.json.error], [400, 'reschedule_style']);
    const endedSame = classes.find((k) => k.style === b.class.style && k.ended);
    if (endedSame) assert.equal((await c.post(`/api/bookings/${b.id}/reschedule`, { classId: endedSame.id })).json.error, 'class_ended');
    r = await c.post(`/api/bookings/${b.id}/reschedule`, { classId: sameStyle.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.booking.classId, sameStyle.id);
    assert.equal((await c.get(`/api/classes/${b.classId}`)).json.spotsLeft, before + b.spots);
    r = await c.post(`/api/bookings/${b.id}/cancel`);
    assert.equal(r.status, 200);
    assert.equal((await c.get(`/api/classes/${sameStyle.id}`)).json.spotsLeft, sameStyle.spotsLeft);
    assert.equal((await c.get('/api/bookings')).json.bookings.length, 1);
  } finally { await s.handle.close(); }
});

test('auth: login failure, register rules, logout clears cookie and cart', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    let r = await c.post('/api/auth/login', { email: MAYA.email, password: 'wrong' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [401, 'login_failed', 'Email or password is wrong.']);
    r = await c.post('/api/auth/register', { name: '', email: 'x@y.test', password: 'longenough' });
    assert.equal(r.json.error, 'name_required');
    r = await c.post('/api/auth/register', { name: 'X', email: 'nope', password: 'longenough' });
    assert.equal(r.json.error, 'email_invalid');
    r = await c.post('/api/auth/register', { name: 'X', email: 'MAYA@stillwater.test', password: 'longenough' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [409, 'email_taken', 'An account with this email already exists.']);
    r = await c.post('/api/auth/register', { name: 'X', email: 'new@y.test', password: 'short' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'password_short', 'Use at least 8 characters.']);
    r = await c.post('/api/auth/register', { name: 'Neo', email: 'new@y.test', password: 'longenough' });
    assert.equal(r.status, 201);
    assert.equal((await c.get('/api/me')).json.name, 'Neo');
    const k = await freeClass(c);
    await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    const oldSid = c.jar.get('sw_sid');
    const withOld = () => fetch(`${s.base}/api/cart`, { headers: { cookie: `sw_sid=${oldSid}` } }).then((x) => x.json());
    assert.equal((await withOld()).items.length, 1);
    r = await c.post('/api/auth/logout');
    assert.equal((await withOld()).items.length, 0, 'logout drops the cart of that sw_sid');
    assert.equal(r.status, 200);
    assert.equal(c.jar.has('sw_sid'), false);
    assert.equal((await c.get('/api/me')).json.error, 'login_required');
    assert.equal((await c.get('/api/cart')).json.items.length, 0);
    const kinds = lines(s.eventsFile).map((e) => e.type);
    for (const t of ['login_failed', 'register', 'logout']) assert.ok(kinds.includes(t), t);
  } finally { await s.handle.close(); }
});

test('profile phone survives a new GET; settings defaults; profile ranges', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    await c.login(SAM);
    assert.deepEqual((await c.get('/api/settings')).json, { emailReminders: true, newsletter: false });
    assert.equal((await c.put('/api/settings', { newsletter: true })).json.newsletter, true);
    assert.equal((await c.get('/api/settings')).json.newsletter, true);
    let r = await c.put('/api/profile', { name: 'Sam Ortega', phone: '+1 555-0100' });
    assert.equal(r.status, 200);
    assert.equal((await c.get('/api/profile')).json.phone, '+1 555-0100');
    r = await c.put('/api/profile', { name: 'Sam', phone: 'call me' });
    assert.deepEqual([r.status, r.json.error], [400, 'phone_invalid']);
    r = await c.put('/api/profile', { name: '', phone: '' });
    assert.deepEqual([r.status, r.json.error], [400, 'name_invalid']);
    r = await c.put('/api/profile', { name: 'x'.repeat(61) });
    assert.equal(r.json.error, 'name_invalid');
    assert.equal((await c.get('/api/profile')).json.phone, '+1 555-0100');
  } finally { await s.handle.close(); }
});

test('single mode: two cookie-less clients share bookings, but login and cart stay per client (Review Focus 1)', async () => {
  const s = await start();
  try {
    const a = client(s.base);
    const b = client(s.base);
    const k = await freeClass(a);
    let r = await a.post('/api/cart/items', { classId: k.id, spots: 1 });
    assert.ok(a.jar.has('sw_sid'), 'anonymous sw_sid on first cart write');
    assert.match(r.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(r.headers.get('set-cookie'), /SameSite=Lax/i);
    r = await b.get('/api/cart');
    assert.equal(r.json.items.length, 0);
    assert.equal(b.jar.has('sw_sid'), false, 'GET /api/cart sets no cookie');
    const sidBefore = a.jar.get('sw_sid');
    await a.login();
    assert.equal(a.jar.get('sw_sid'), sidBefore, 'login keeps the cookie');
    assert.equal((await a.get('/api/cart')).json.items[0].classId, k.id);
    assert.equal((await a.post('/api/checkout', { acceptTerms: true })).status, 200);
    // b sees the capacity change, but must log in itself
    assert.equal((await b.get(`/api/classes/${k.id}`)).json.spotsLeft, k.spotsLeft - 1);
    assert.equal((await b.get('/api/bookings')).json.error, 'login_required');
    await b.login();
    assert.ok((await b.get('/api/bookings')).json.bookings.some((x) => x.classId === k.id));
    assert.equal((await b.get('/api/cart')).json.items.length, 0);
  } finally { await s.handle.close(); }
});

test('protected route without cookie: 401 login_required without a session_expired line', async () => {
  const s = await start();
  try {
    const c = client(s.base);
    const r = await c.get('/api/profile');
    assert.deepEqual([r.status, r.json.error, r.json.message], [401, 'login_required', 'Please log in to continue.']);
    // anonymous sw_sid (never logged in) behaves the same
    const k = await freeClass(c);
    await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    assert.equal((await c.get('/api/settings')).json.error, 'login_required');
    const ev = lines(s.eventsFile);
    assert.equal(ev.filter((e) => e.type === 'session_expired').length, 0);
    assert.ok(ev.some((e) => e.type === 'api' && e.route === 'GET /api/profile' && e.status === 401 && e.authed === false));
  } finally { await s.handle.close(); }
});

test('expireSession hook: protected requests answer session_expired, cart stays, new login works', async () => {
  const hooks = createHookSet();
  let fired = false;
  hooks.before('GET /api/cart', (ctx) => { if (!fired) { fired = true; ctx.expireSession(); } });
  const s = await start({ makeEngine: () => ({ ...nullEngine, hooks }) });
  try {
    const c = client(s.base);
    await c.login();
    const k = await freeClass(c);
    await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    const cart = await c.get('/api/cart');
    assert.equal(cart.status, 200);
    assert.equal(cart.json.items.length, 1, 'cart of the sw_sid stays');
    assert.ok(c.jar.has('sw_sid'), 'cookie stays');
    let r = await c.get('/api/profile');
    assert.deepEqual([r.status, r.json.error, r.json.message], [401, 'session_expired', 'Your session expired. Please log in again.']);
    r = await c.get('/api/me');
    assert.equal(r.json.error, 'session_expired');
    assert.ok(lines(s.eventsFile).some((e) => e.type === 'session_expired'));
    assert.equal((await c.login()).status, 200);
    assert.equal((await c.get('/api/profile')).status, 200);
    assert.equal((await c.get('/api/cart')).json.items.length, 1);
  } finally { await s.handle.close(); }
});

test('hooks: before respond skips the route; validate=false lets spots -1 through; after rewrites body; cart() in hook', async () => {
  const hooks = createHookSet();
  let seenCart = null;
  hooks.before('POST /api/cart/coupon', async (ctx) => { seenCart = await ctx.cart(); ctx.respond(200, { hooked: true }); });
  hooks.before('POST /api/cart/items', (ctx) => { ctx.validate = false; });
  hooks.after('GET /api/classes/:id', (ctx, body) => ({ ...body, name: 'Patched' }));
  const s = await start({ makeEngine: () => ({ ...nullEngine, hooks }) });
  try {
    const c = client(s.base);
    const k = await freeClass(c);
    let r = await c.post('/api/cart/items', { classId: k.id, spots: -1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.items[0].spots, -1);
    r = await c.post('/api/cart/coupon', { code: 'SPRING25' });
    assert.deepEqual([r.status, r.json], [200, { hooked: true }]);
    assert.equal(seenCart.items[0].classId, k.id);
    assert.equal((await c.get(`/api/classes/${k.id}`)).json.name, 'Patched');
  } finally { await s.handle.close(); }
  // control: without the hook, spots -1 is rejected
  const s2 = await start();
  try {
    const c = client(s2.base);
    const k = await freeClass(c);
    assert.equal((await c.post('/api/cart/items', { classId: k.id, spots: -1 })).json.error, 'spots_range');
  } finally { await s2.handle.close(); }
});

test('createHookSet: runBefore reports an answer, async hooks run in order, runAfter chains', async () => {
  const h = createHookSet();
  const order = [];
  h.before('GET /x', async () => { await new Promise((r) => setTimeout(r, 5)); order.push(1); });
  h.before('GET /x', (ctx) => { order.push(2); ctx.respond(201, { ok: 1 }); });
  h.before('GET /x', () => { order.push(3); });
  let answered = null;
  const ctx = { respond: (st, b) => { answered = [st, b]; } };
  assert.equal(await h.runBefore('GET /x', ctx), true);
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(answered, [201, { ok: 1 }]);
  assert.equal(await h.runBefore('GET /y', { respond() {} }), false);
  h.after('GET /x', (c, b) => ({ ...b, a: 1 }));
  h.after('GET /x', async (c, b) => ({ ...b, b: 2 }));
  assert.deepEqual(await h.runAfter('GET /x', {}, { z: 0 }), { z: 0, a: 1, b: 2 });
  assert.deepEqual(await h.runAfter('GET /y', {}, { z: 0 }), { z: 0 });
});

test('events.jsonl has login and api lines; /api/metrics writes none and calls decodeBeacon', async () => {
  const calls = [];
  const engine = { ...nullEngine, decodeBeacon: (b, e) => { calls.push([b, e]); return b === 'aaaaaaaa' ? { bug: 'F03', event: 'reached' } : null; } };
  const s = await start({ makeEngine: () => engine });
  try {
    const c = client(s.base);
    await c.login();
    await c.get('/api/classes');
    let r = await c.post('/api/metrics', { b: 'bbbbbbbb', e: '12345678' });
    assert.equal(r.status, 204);
    // sendBeacon posts text/plain
    const raw = await fetch(`${s.base}/api/metrics`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ b: 'aaaaaaaa', e: '12345678' }) });
    assert.equal(raw.status, 204);
    r = await c.post('/api/metrics', 'not json');
    assert.equal(r.status, 204);
    const ev = lines(s.eventsFile);
    const login = ev.find((e) => e.type === 'login');
    assert.ok(login && typeof login.t === 'string' && login.sb && /^[0-9a-f]{8}$/.test(login.sid));
    assert.ok(ev.some((e) => e.type === 'api' && e.route === 'POST /api/auth/login' && e.status === 200));
    assert.ok(ev.some((e) => e.type === 'api' && e.route === 'GET /api/classes' && e.authed === true));
    assert.equal(ev.filter((e) => e.type === 'api' && String(e.route).includes('/api/metrics')).length, 0);
    assert.deepEqual(calls.slice(0, 2), [['bbbbbbbb', '12345678'], ['aaaaaaaa', '12345678']]);
    const bugs = ev.filter((e) => e.type === 'bug');
    assert.equal(bugs.length, 1);
    assert.deepEqual([bugs[0].bug, bugs[0].event], ['F03', 'reached']);
  } finally { await s.handle.close(); }
});

test('reports: line format, tester normalized, too long 400, empty 400, 31st report 429', async () => {
  process.env.CODER_PARCOURS_COMMIT = 'abc1234';
  const s = await start();
  try {
    const c = client(s.base);
    let r = await c.post('/api/reports', { text: 'x'.repeat(4001), path: '/cart', viewportPx: 390, tester: 'Anna' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [400, 'report_long', 'Keep the report under 4000 characters.']);
    r = await c.post('/api/reports', { text: '   ', path: '/cart' });
    assert.deepEqual([r.status, r.json.error], [400, 'report_empty']);
    r = await c.post('/api/reports', { text: 'Button too small', path: '/c' + 'x'.repeat(400), viewportPx: 390, tester: 'Anna Müller' });
    assert.equal(r.status, 201);
    const [line] = lines(s.reportsFile);
    assert.equal(line.tester, 'anna-m-ller');
    assert.equal(line.text, 'Button too small');
    assert.equal(line.path.length, 300);
    assert.equal(line.viewportPx, 390);
    assert.equal(line.seed, 2601);
    assert.equal(line.commit, 'abc1234');
    assert.ok(line.t && line.sb);
    for (let i = 2; i <= 30; i++) assert.equal((await c.post('/api/reports', { text: `r${i}`, path: '/' })).status, 201, `report ${i}`);
    r = await client(s.base).post('/api/reports', { text: 'r31', path: '/' });
    assert.deepEqual([r.status, r.json.error, r.json.message], [429, 'too_many_reports', 'Too many reports. Please wait a few minutes.']);
    assert.equal(lines(s.reportsFile).length, 30);
  } finally { delete process.env.CODER_PARCOURS_COMMIT; await s.handle.close(); }
  const s2 = await start();
  try {
    await client(s2.base).post('/api/reports', { text: 'x', path: '/' });
    assert.equal(lines(s2.reportsFile)[0].commit, null);
  } finally { await s2.handle.close(); }
});

test('admin export: 404 without token, 401 wrong token, identical lines with token', async () => {
  const s0 = await start();
  try {
    assert.equal((await client(s0.base).get('/api/admin/reports', { authorization: 'Bearer x' })).status, 404);
  } finally { await s0.handle.close(); }
  const s = await start({ adminToken: 'tok-123' });
  try {
    const c = client(s.base);
    let r = await c.get('/api/admin/reports', { authorization: 'Bearer tok-123' });
    assert.deepEqual([r.status, r.text], [200, '']);
    assert.equal((await c.get('/api/admin/reports', { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await c.get('/api/admin/reports')).status, 401);
    await c.post('/api/reports', { text: 'one', path: '/a', viewportPx: 768, tester: 't' });
    await c.post('/api/reports', { text: 'two', path: '/b', viewportPx: 1440, tester: 't' });
    r = await c.get('/api/admin/reports', { authorization: 'Bearer tok-123' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/x-ndjson/);
    assert.equal(r.text, readFileSync(s.reportsFile, 'utf8'));
    assert.equal(r.text.split('\n').filter(Boolean).length, 2);
  } finally { await s.handle.close(); }
});

test('pages: index.html gets the runtime script first in <head>; runtime.js no-store', async () => {
  const s = await start({ makeEngine: () => ({ ...nullEngine, runtimeScript: () => '/*rt*/' }) });
  try {
    const c = client(s.base);
    for (const p of ['/', '/cart', '/classes/c08']) {
      const r = await c.get(p);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/html/);
      const i = r.text.indexOf('<script src="/assets/runtime.js"></script>');
      const j = r.text.indexOf('<script type="module" src="/assets/app.js">');
      assert.ok(i > r.text.indexOf('<head>') && j > 0 && i < j, p);
    }
    const r = await c.get('/assets/runtime.js');
    assert.equal(r.text, '/*rt*/');
    assert.match(r.headers.get('content-type'), /javascript/);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.equal((await c.get('/api/nope')).json.error, 'not_found');
  } finally { await s.handle.close(); }
});

test('hosted: sandbox per sw_sb, invalid ?seed= falls back to loadSeeds()[0], other seed new sandbox, config from hostedConfigForSeed', async () => {
  const catalog = await loadCatalog({ publicDir: 'fixtures/bugs' });
  const configForSeed = hostedConfigForSeed(catalog);
  /** @type {any[]} */
  const seen = [];
  const s = await start({
    mode: 'hosted', runConfig: undefined, configForSeed,
    makeEngine: (cfg) => { seen.push(cfg); return nullEngine; },
  });
  try {
    const [s0, s1] = loadSeeds();
    const a = client(s.base);
    await a.get('/?seed=abc');
    assert.ok(a.jar.has('sw_sb'));
    assert.equal(seen.at(-1).seed, s0);
    assert.deepEqual(seen.at(-1), buildRunConfig({ seed: s0, sessionType: 'explore', catalog }));
    await a.post('/api/reports', { text: 'x', path: '/' });
    assert.equal(lines(s.reportsFile)[0].seed, s0);
    // another visitor gets another sandbox: bookings are not shared
    const b = client(s.base);
    await b.get(`/?seed=${s1}`);
    assert.deepEqual(seen.at(-1), buildRunConfig({ seed: s1, sessionType: 'explore', catalog }));
    await a.login();
    const k = await freeClass(a);
    await a.post('/api/cart/items', { classId: k.id, spots: 1 });
    await a.post('/api/checkout', { acceptTerms: true });
    await b.login();
    assert.equal((await b.get('/api/bookings')).json.bookings.length, 2);
    assert.equal((await a.get('/api/bookings')).json.bookings.length, 3);
    // same seed again keeps the sandbox, a different seed starts a new one
    const sbA = a.jar.get('sw_sb');
    await a.get(`/?seed=${s0}`);
    assert.equal(a.jar.get('sw_sb'), sbA);
    const n = seen.length;
    await a.get(`/?seed=${s1}`);
    assert.notEqual(a.jar.get('sw_sb'), sbA);
    assert.equal(seen.length, n + 1);
  } finally { await s.handle.close(); }
});

test('single mode ignores ?seed=', async () => {
  const seen = [];
  const s = await start({ makeEngine: (cfg) => { seen.push(cfg); return nullEngine; } });
  try {
    const c = client(s.base);
    await c.get('/?seed=2602');
    await c.post('/api/reports', { text: 'x', path: '/' });
    assert.equal(lines(s.reportsFile)[0].seed, 2601);
    assert.equal(c.jar.has('sw_sb'), false);
    assert.equal(seen.length, 1);
  } finally { await s.handle.close(); }
});

test('hosted sandbox pool: expires after 2 h idle, keeps at most 500 (oldest go first)', async () => {
  const { createSandboxPool, createSandbox, SANDBOX_IDLE_MS, SANDBOX_MAX } = await import('./store.mjs');
  assert.equal(SANDBOX_IDLE_MS, 2 * 60 * 60 * 1000);
  assert.equal(SANDBOX_MAX, 500);
  let t = 0;
  let n = 0;
  const pool = createSandboxPool({ create: (seed) => createSandbox({ id: `s${n++}`, seed, runConfig: null }), now: () => t });
  const first = pool.add(1);
  t = SANDBOX_IDLE_MS - 1;
  assert.equal(pool.get(first.id), first, 'still alive just before 2 h');
  t += SANDBOX_IDLE_MS + 1;
  assert.equal(pool.get(first.id), null, 'gone after 2 h idle');
  const ids = [];
  for (let i = 0; i < SANDBOX_MAX; i++) { t += 1; ids.push(pool.add(1).id); }
  t += 1;
  pool.get(ids[0]); // touch the oldest: now ids[1] is the least recently used
  t += 1;
  pool.add(2);
  assert.equal(pool.size, SANDBOX_MAX);
  assert.ok(pool.get(ids[0]), 'recently used survives');
  assert.equal(pool.get(ids[1]), null, 'least recently used is evicted');
  assert.ok(pool.get(ids[2]));
});

// --- Fix round 1: rights, limits, public ids -------------------------------------------------------

/** Hosted server with a plain config per seed. @param {any} [overrides] */
function startHosted(overrides = {}) {
  const configForSeed = (seed) => ({ seed, sessionType: 'explore', variant: null, sources: { public: 0, secret: 0 }, active: [], change: null, capture: null, decoys: [] });
  return start({ mode: 'hosted', runConfig: undefined, configForSeed, ...overrides });
}

test('hosted: a sw_sid of sandbox A is anonymous in sandbox B and shows no foreign cart', async () => {
  const s = await startHosted();
  try {
    const a = client(s.base);
    await a.get('/');
    await a.login();
    const k = await freeClass(a);
    await a.post('/api/cart/items', { classId: k.id, spots: 1 });
    assert.equal((await a.get('/api/cart')).json.items.length, 1);
    const b = client(s.base);
    await b.get('/');
    assert.notEqual(b.jar.get('sw_sb'), a.jar.get('sw_sb'));
    b.jar.set('sw_sid', a.jar.get('sw_sid'));
    const me = await b.get('/api/me');
    assert.deepEqual([me.status, me.json.error], [401, 'login_required']);
    assert.equal((await b.get('/api/cart')).json.items.length, 0);
    assert.equal((await a.get('/api/me')).status, 200, 'counter-check: A itself is still logged in');
  } finally { await s.handle.close(); }
});

test('session ages out after 8 h (session_expired line), not before', async () => {
  const { SESSION_TTL_MS } = await import('./store.mjs');
  const hooks = createHookSet();
  let shift = 0;
  hooks.before('GET /api/cart', (ctx) => { ctx.session.loginAt -= shift; });
  const s = await start({ makeEngine: () => ({ ...nullEngine, hooks }) });
  try {
    const c = client(s.base);
    await c.login();
    shift = SESSION_TTL_MS - 60_000;
    await c.get('/api/cart');
    assert.equal((await c.get('/api/me')).status, 200, 'just under 8 h still logged in');
    assert.equal(lines(s.eventsFile).filter((e) => e.type === 'session_expired').length, 0);
    shift = 120_000;
    await c.get('/api/cart');
    const r = await c.get('/api/me');
    assert.deepEqual([r.status, r.json.error], [401, 'session_expired']);
    assert.equal(lines(s.eventsFile).filter((e) => e.type === 'session_expired').length, 1);
  } finally { await s.handle.close(); }
});

test('reports: global and per-IP limits apply across sandboxes; full files answer 507', async () => {
  const sg = await startHosted({ limits: { reportsGlobal: 3, reportsPerIp: 100 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await client(sg.base).post('/api/reports', { text: `g${i}`, path: '/' })).status, 201);
    const r = await client(sg.base).post('/api/reports', { text: 'g3', path: '/' });
    assert.deepEqual([r.status, r.json.error], [429, 'too_many_reports']);
  } finally { await sg.handle.close(); }
  const si = await startHosted({ limits: { reportsGlobal: 100, reportsPerIp: 2 } });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await client(si.base).post('/api/reports', { text: `i${i}`, path: '/' })).status, 201);
    assert.equal((await client(si.base).post('/api/reports', { text: 'i2', path: '/' })).status, 429, 'third sandbox, same IP');
  } finally { await si.handle.close(); }
  const sf = await start({ limits: { reportsBytes: 1 } });
  try {
    assert.equal((await client(sf.base).post('/api/reports', { text: 'one', path: '/' })).status, 201);
    const r = await client(sf.base).post('/api/reports', { text: 'two', path: '/' });
    assert.deepEqual([r.status, r.json.error], [507, 'reports_full']);
    assert.equal(lines(sf.reportsFile).length, 1);
  } finally { await sf.handle.close(); }
});

test('events file at its cap: events are dropped, logged once, requests keep working', async () => {
  const orig = console.error;
  /** @type {string[]} */
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  const s = await start({ limits: { eventsBytes: 1 } });
  try {
    const c = client(s.base);
    for (let i = 0; i < 4; i++) assert.equal((await c.get('/api/classes')).status, 200);
    assert.equal(lines(s.eventsFile).length, 1, 'only the line written before the cap');
    assert.equal(logged.filter((m) => /events file reached/.test(m)).length, 1);
  } finally { console.error = orig; await s.handle.close(); }
});

test('hosted: assets, reads and favicon open no sandbox; over the IP limit pages fall back to a guest, writes get 429', async () => {
  const s = await startHosted({ limits: { sandboxesPerIp: 2 } });
  try {
    const c = client(s.base);
    for (const p of ['/api/classes', '/assets/runtime.js', '/favicon.ico', '/api/cart']) await c.get(p);
    assert.equal(c.jar.has('sw_sb'), false, 'no cookie for reads and assets');
    assert.equal((await c.get('/')).status, 200);
    assert.ok(c.jar.has('sw_sb'), 'counter-check: a page load opens a sandbox');
    const c2 = client(s.base);
    await c2.get('/');
    assert.ok(c2.jar.has('sw_sb'));
    const c3 = client(s.base);
    const page = await c3.get('/');
    assert.equal(page.status, 200);
    assert.equal(c3.jar.has('sw_sb'), false, 'third page load from this IP: guest, no sandbox');
    const w = await c3.login();
    assert.deepEqual([w.status, w.json.error], [429, 'too_many_sandboxes']);
    assert.equal((await c.login()).status, 200, 'counter-check: a visitor with a sandbox is not affected');
  } finally { await s.handle.close(); }
});

test('hosted: only seeds from loadSeeds() count; other numbers fall back to the first', async () => {
  const seen = [];
  const s = await startHosted({ makeEngine: (cfg) => { seen.push(cfg.seed); return nullEngine; } });
  try {
    const [s0, s1] = loadSeeds();
    await client(s.base).get('/?seed=999999');
    assert.equal(seen.at(-1), s0);
    await client(s.base).get(`/?seed=${s1}`);
    assert.equal(seen.at(-1), s1);
  } finally { await s.handle.close(); }
});

test('sessions per sandbox are capped; anonymous ones go first, logged-in ones survive', async () => {
  const s = await start({ limits: { sessionsPerSandbox: 3 } });
  try {
    const a = client(s.base);
    await a.login();
    const k = await freeClass(a);
    const others = [client(s.base), client(s.base), client(s.base), client(s.base)];
    for (const o of others) await o.post('/api/cart/items', { classId: k.id, spots: 1 });
    assert.equal((await a.get('/api/me')).status, 200, 'logged-in session survives the flood');
    assert.equal((await others[0].get('/api/cart')).json.items.length, 0, 'oldest anonymous cart was dropped');
    assert.equal((await others[3].get('/api/cart')).json.items.length, 1, 'newest anonymous cart is there');
  } finally { await s.handle.close(); }
});

test('admin token: wrong tokens of any length answer 401, the 5th wrong try locks the IP even for the right token', async () => {
  const s = await start({ adminToken: 'tok-123' });
  try {
    const c = client(s.base);
    assert.equal((await c.get('/api/admin/reports', { authorization: 'x' })).status, 401);
    assert.equal((await c.get('/api/admin/reports', { authorization: 'Bearer ' + 'y'.repeat(500) })).status, 401);
    for (let i = 0; i < 2; i++) assert.equal((await c.get('/api/admin/reports', { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await c.get('/api/admin/reports', { authorization: 'Bearer tok-123' })).status, 200, 'right token under the limit works');
    assert.equal((await c.get('/api/admin/reports', { authorization: 'Bearer nope' })).status, 401);
    const r = await c.get('/api/admin/reports', { authorization: 'Bearer tok-123' });
    assert.deepEqual([r.status, r.json.error], [429, 'too_many_attempts']);
  } finally { await s.handle.close(); }
});

test('files carry a derived sandbox id, never the sw_sb cookie value; events, reports and engine agree', async () => {
  let engineId = null;
  const s = await startHosted({ makeEngine: (cfg, { sandboxId }) => { engineId = sandboxId; return nullEngine; } });
  try {
    const c = client(s.base);
    await c.get('/');
    const cookie = c.jar.get('sw_sb');
    await c.login();
    await c.post('/api/reports', { text: 'x', path: '/' });
    const ev = lines(s.eventsFile);
    const [rep] = lines(s.reportsFile);
    assert.ok(ev.length >= 2 && rep);
    for (const e of ev) assert.notEqual(e.sb, cookie);
    assert.notEqual(rep.sb, cookie);
    assert.equal(rep.sb, ev.at(-1).sb, 'same sandbox, same public id');
    assert.equal(rep.sb, engineId);
    assert.ok(!readFileSync(s.eventsFile, 'utf8').includes(cookie) && !readFileSync(s.reportsFile, 'utf8').includes(cookie));
  } finally { await s.handle.close(); }
});

test('cookies: Secure only in hosted mode; a broken percent code is ignored, not a 500', async () => {
  const h = await startHosted();
  const l = await start();
  try {
    let r = await client(h.base).get('/');
    assert.match(r.headers.get('set-cookie'), /;\s*Secure/i);
    const c = client(l.base);
    const k = await freeClass(c);
    r = await c.post('/api/cart/items', { classId: k.id, spots: 1 });
    assert.doesNotMatch(r.headers.get('set-cookie'), /Secure/i);
    r = await client(l.base).get('/api/cart', { cookie: 'sw_sid=%E0%A4%A; sw_sb=%' });
    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, 0, 'the broken cookie counts as absent');
  } finally { await h.handle.close(); await l.handle.close(); }
});
