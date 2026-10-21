// Express 5 app of the Stillwater Yoga studio: JSON API with hooks, sandboxes, event and report files, pages.
import express from 'express';
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream';
import { createHookSet } from './hooks.mjs';
import { isEnded } from './data.mjs';
import {
  SESSION_TTL_MS, bookingView, cartOf, cartView, classView, createSandbox, createSandboxPool, newId, newReference, spotsLeft,
} from './store.mjs';
import { REPORT_LIMITS, normalizeTester } from '../harness/report-schema.mjs';
import { loadSeeds } from '../harness/seed.mjs';

/** Engine without bugs: no hooks, empty runtime, no beacon matches. */
export const nullEngine = { hooks: createHookSet(), runtimeScript: () => '', decodeBeacon: () => null, activeIds: [] };

const RUNTIME_TAG = '<script src="/assets/runtime.js"></script>';

/** Safety limits; every value can be overridden through the `limits` option (tests do). */
export const SERVER_LIMITS = {
  /** Event file stops growing here (events are dropped, logged once). */
  eventsBytes: 200 * 1024 * 1024,
  /** Report file stops growing here (reports answer 507). */
  reportsBytes: 20 * 1024 * 1024,
  /** Reports over all sandboxes per REPORT_LIMITS.windowMin. */
  reportsGlobal: REPORT_LIMITS.perSandbox * 10,
  /** Reports per client IP per REPORT_LIMITS.windowMin. */
  reportsPerIp: REPORT_LIMITS.perSandbox,
  /** New hosted sandboxes per client IP per sandboxWindowMs. */
  sandboxesPerIp: 20,
  sandboxWindowMs: 10 * 60 * 1000,
  /** Wrong admin tokens per client IP per adminWindowMs before the IP is locked out. */
  adminFailsPerIp: 5,
  adminWindowMs: 10 * 60 * 1000,
  /** sw_sid sessions (with their carts) per sandbox. */
  sessionsPerSandbox: 50,
};

/** Sliding-window counter per key (client IP or 'all'); memory stays bounded. */
function slidingWindow(max, windowMs) {
  /** @type {Map<string, number[]>} */
  const m = new Map();
  const live = (key, now) => {
    const ts = (m.get(key) ?? []).filter((t) => now - t < windowMs);
    if (ts.length) m.set(key, ts); else m.delete(key);
    return ts;
  };
  return {
    full: (key, now = Date.now()) => live(key, now).length >= max,
    add(key, now = Date.now()) {
      const ts = live(key, now);
      ts.push(now);
      m.set(key, ts);
      while (m.size > 5000) m.delete(m.keys().next().value);
    },
  };
}

/** A hosted admin token must be long and random: at least 32 chars, 10+ distinct chars, not a repeated block. */
export function isStrongAdminToken(t) {
  return typeof t === 'string' && t.length >= 32 && new Set(t).size >= 10 && !/^([\s\S]+?)\1+$/.test(t);
}

const COOKIE_BASE = { httpOnly: true, sameSite: /** @type {'lax'} */ ('lax'), path: '/' };

/** @param {string} sid */
const sidHash = (sid) => createHash('sha256').update(sid).digest('hex').slice(0, 8);

/** @param {string|undefined} header */
function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* broken percent code: ignore this cookie */ }
  }
  return out;
}

/**
 * @param {number} status
 * @param {string} error
 * @param {string} message
 */
const fail = (status, error, message) => ({ status, body: { error, message } });
/** @param {any} body @param {number} [status] */
const ok = (body, status = 200) => ({ status, body });

const MSG = {
  login_required: 'Please log in to continue.',
  session_expired: 'Your session expired. Please log in again.',
  spots_range: 'Choose between 1 and 5 spots.',
  class_full: 'This class is full.',
  class_ended: 'This class has ended.',
  already_booked: 'You already booked this class.',
};

/**
 * @param {{ mode: 'single'|'hosted', runConfig?: any, configForSeed?: (seed: number) => any,
 *   makeEngine?: (runConfig: any, opts: { sandboxId: string, logEvent: (entry: object) => void }) => any,
 *   eventsFile?: string|null, reportsFile?: string|null, staticDir?: string, adminToken?: string|null,
 *   trustProxy?: number|false, secureCookies?: boolean, limits?: Partial<typeof SERVER_LIMITS>, clock?: () => number }} opts
 *   makeEngine is called once per sandbox; logEvent writes an event line with that sandbox's public `sb`.
 *   trustProxy (hop count; 0/false = direct, default env CODER_PARCOURS_TRUST_PROXY) decides where req.ip comes from.
 *   Hosted mode refuses to start unless it is set explicitly (option or env, "0" for direct operation).
 *   secureCookies defaults to true in hosted mode only.
 *   Hosted mode refuses to start without a strong adminToken (isStrongAdminToken); single mode takes any or none.
 *   clock (default Date.now) drives the admin lockout; tests inject it.
 */
export function createServer({
  mode, runConfig, configForSeed, makeEngine = () => nullEngine, eventsFile = null, reportsFile = null, staticDir, adminToken = null,
  trustProxy = /^\d+$/.test(process.env.CODER_PARCOURS_TRUST_PROXY ?? '') ? Number(process.env.CODER_PARCOURS_TRUST_PROXY) : undefined,
  secureCookies = mode === 'hosted', limits = {}, clock = Date.now,
}) {
  if (mode === 'hosted' && trustProxy === undefined) {
    throw new Error('createServer: hosted mode needs an explicit trust-proxy setting: set CODER_PARCOURS_TRUST_PROXY to the number of reverse proxies in front (or 0 for direct operation).');
  }
  trustProxy = trustProxy || false;
  const L = { ...SERVER_LIMITS, ...limits };
  const cookieBase = { ...COOKIE_BASE, ...(secureCookies ? { secure: true } : {}) };
  if (mode !== 'single' && mode !== 'hosted') throw new Error(`createServer: unknown mode ${mode}`);
  if (mode === 'single' && !runConfig) throw new Error('createServer: single mode needs runConfig');
  if (mode === 'hosted' && typeof configForSeed !== 'function') throw new Error('createServer: hosted mode needs configForSeed');
  if (mode === 'hosted' && !isStrongAdminToken(adminToken)) {
    throw new Error('createServer: hosted mode needs a strong admin token (at least 32 random characters). Create one with `openssl rand -base64 32` and pass it via --admin-token-env <VAR> (e.g. CODER_PARCOURS_ADMIN_TOKEN).');
  }

  const fileSize = (file) => (file && existsSync(file) ? statSync(file).size : 0);
  let eventsBytes = fileSize(eventsFile);
  let reportsBytes = fileSize(reportsFile);
  let eventsFullLogged = false;

  /** @param {string} sb public sandbox id @param {object} entry */
  const writeEvent = (sb, entry) => {
    if (!eventsFile) return;
    if (eventsBytes >= L.eventsBytes) {
      if (!eventsFullLogged) { eventsFullLogged = true; console.error(`events file reached ${L.eventsBytes} bytes; dropping further events`); }
      return;
    }
    const line = JSON.stringify({ t: new Date().toISOString(), sb, ...entry }) + '\n';
    appendFileSync(eventsFile, line);
    eventsBytes += Buffer.byteLength(line);
  };

  // The sw_sb cookie value is the key to a sandbox. Files and engines only ever see this derived id.
  const idKey = randomBytes(32);
  /** @param {string} id */
  const publicId = (id) => createHmac('sha256', idKey).update(id).digest('hex').slice(0, 12);

  /** @param {string} id @param {number} seed @param {any} cfg */
  const makeSandbox = (id, seed, cfg) => {
    const sb = createSandbox({ id, seed, runConfig: cfg });
    sb.pub = id === 'single' ? id : publicId(id);
    sb.engine = makeEngine(cfg, { sandboxId: sb.pub, logEvent: (entry) => writeEvent(sb.pub, entry) }) ?? nullEngine;
    return sb;
  };

  const reportsAll = slidingWindow(L.reportsGlobal, REPORT_LIMITS.windowMin * 60 * 1000);
  const reportsIp = slidingWindow(L.reportsPerIp, REPORT_LIMITS.windowMin * 60 * 1000);
  const sandboxesIp = slidingWindow(L.sandboxesPerIp, L.sandboxWindowMs);
  const adminFails = slidingWindow(L.adminFailsPerIp, L.adminWindowMs);
  const tokenHash = (t) => createHash('sha256').update(t).digest();

  const single = mode === 'single' ? makeSandbox('single', runConfig.seed, runConfig) : null;
  const pool = mode === 'hosted' ? createSandboxPool({ create: (seed) => makeSandbox(newId(), seed, configForSeed(seed)) }) : null;
  const seeds = mode === 'hosted' ? loadSeeds() : [];
  const defaultSeed = mode === 'hosted' ? seeds[0] : null;
  /** Hosted visitors without their own sandbox (assets, reads, over-limit page loads): one read-only sandbox per allowed seed. */
  const guests = new Map();
  const guestFor = (seed) => {
    if (!guests.has(seed)) {
      const g = makeSandbox(`guest-${seed}`, seed, configForSeed(seed));
      g.guest = true;
      guests.set(seed, g);
    }
    return guests.get(seed);
  };
  // Express matches paths case-insensitively, so every path test works on the lower-cased path.
  const lowerPath = (req) => req.path.toLowerCase();
  const isSafeMethod = (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const isPage = (req) => req.method === 'GET' && !lowerPath(req).startsWith('/api') && !lowerPath(req).startsWith('/assets/') && !/\.[A-Za-z0-9]+$/.test(req.path);
  const isStateChange = (req) => !isSafeMethod(req) && lowerPath(req).startsWith('/api/') && lowerPath(req) !== '/api/metrics';

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  // --- request state: sandbox and sw_sid ---------------------------------------------------------
  app.use((req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let sb = single;
    if (pool && !lowerPath(req).startsWith('/api/admin/')) {
      const q = req.query.seed;
      const given = typeof q === 'string';
      const wanted = given && /^\d{1,9}$/.test(q) && seeds.includes(Number(q)) ? Number(q) : defaultSeed;
      sb = pool.get(cookies.sw_sb);
      // Only page loads and state-changing requests may open a sandbox, and only a few per client IP.
      const creates = isPage(req) || isStateChange(req);
      if (creates && (!sb || (given && wanted !== sb.seed))) {
        if (!sandboxesIp.full(req.ip ?? '')) {
          sandboxesIp.add(req.ip ?? '');
          sb = pool.add(wanted);
          res.cookie('sw_sb', sb.id, cookieBase);
        } else if (isStateChange(req)) {
          return res.status(429).json({ error: 'too_many_sandboxes', message: 'Too many new sessions. Please wait a few minutes.' });
        } else {
          sb = guestFor(wanted);
        }
      }
      if (!sb) sb = guestFor(wanted);
    }
    const sid = sb && cookies.sw_sid && sb.sessions.has(cookies.sw_sid) ? cookies.sw_sid : null;
    res.locals.sb = sb;
    res.locals.sid = sid;
    next();
  });

  /** @param {any} res */
  const sessionOf = (res) => (res.locals.sid ? res.locals.sb.sessions.get(res.locals.sid) : null);

  /** Live login of this client: the account, or why there is none. */
  const authState = (res) => {
    const s = sessionOf(res);
    if (s && s.accountId && Date.now() - s.loginAt > SESSION_TTL_MS) {
      s.accountId = null;
      s.expired = true;
    }
    if (s && s.accountId) return { account: res.locals.sb.accounts.find((a) => a.id === s.accountId) };
    return { reason: s && s.expired ? 'session_expired' : 'login_required' };
  };

  /** @param {any} res @param {object} entry */
  const event = (res, entry) => writeEvent(res.locals.sb ? res.locals.sb.pub : 'admin', {
    ...entry, ...(res.locals.sid ? { sid: sidHash(res.locals.sid) } : {}),
  });

  /** Gives the client an sw_sid (anonymous) if it has none yet. */
  const ensureSid = (res) => {
    if (res.locals.sid) return res.locals.sid;
    const sessions = res.locals.sb.sessions;
    while (sessions.size >= L.sessionsPerSandbox) {
      // make room: anonymous sessions go first, then the oldest
      const victim = [...sessions.values()].find((x) => !x.accountId) ?? sessions.values().next().value;
      sessions.delete(victim.sid);
      res.locals.sb.carts.delete(victim.sid);
    }
    const sid = newId(16);
    res.locals.sb.sessions.set(sid, { sid, accountId: null, loginAt: null, expired: false });
    res.locals.sid = sid;
    res.cookie('sw_sid', sid, { ...cookieBase, maxAge: SESSION_TTL_MS });
    return sid;
  };

  // --- /api/metrics: no api line, always 204 ----------------------------------------------------
  app.post('/api/metrics', express.text({ type: () => true, limit: '4kb' }), (req, res) => {
    let data = null;
    try { data = JSON.parse(typeof req.body === 'string' ? req.body : ''); } catch { /* ignore */ }
    if (data && typeof data.b === 'string' && typeof data.e === 'string' && res.locals.sb) {
      const hit = res.locals.sb.engine.decodeBeacon(data.b, data.e);
      if (hit) event(res, { type: 'bug', bug: hit.bug, event: hit.event });
    }
    res.status(204).end();
  });

  // --- api line for every other /api request ---------------------------------------------------
  app.use('/api', (req, res, next) => {
    res.on('finish', () => {
      event(res, {
        type: 'api', route: res.locals.routeKey ?? `${req.method} ${req.baseUrl}${req.path}`, status: res.statusCode,
        authed: Boolean(res.locals.sb) && Boolean(authState(res).account),
      });
    });
    next();
  });

  app.get('/api/admin/reports', (req, res) => {
    res.locals.routeKey = 'GET /api/admin/reports';
    if (!adminToken) return res.status(404).json({ error: 'not_found', message: 'Not found.' });
    const ip = req.ip ?? '';
    const now = clock();
    // Fail closed: a locked IP gets 429 for every admin request, right token or not, so the answer never tells a hit.
    if (adminFails.full(ip, now)) return res.status(429).json({ error: 'too_many_attempts', message: 'Too many wrong tokens. Please wait.' });
    const given = String(req.headers.authorization ?? '');
    if (!timingSafeEqual(tokenHash(given), tokenHash(`Bearer ${adminToken}`))) {
      adminFails.add(ip, now);
      return res.status(401).json({ error: 'unauthorized', message: 'Wrong token.' });
    }
    res.status(200).type('application/x-ndjson');
    if (!reportsFile || !existsSync(reportsFile)) return res.end();
    pipeline(createReadStream(reportsFile), res, () => { /* client went away or file vanished: nothing to add */ });
  });

  app.use('/api', express.json({ limit: '64kb' }));

  /**
   * Registers one API route. Order: (cart write: sw_sid) -> before hooks -> login check -> logic -> after hooks.
   * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
   * @param {string} path
   * @param {{ auth?: boolean, cartWrite?: boolean }} opts
   * @param {(ctx: any, res: any, account: any) => any} logic returns { status, body }
   */
  const route = (method, path, opts, logic) => {
    const key = `${method} ${path}`;
    /** @type {any} */ (app)[method.toLowerCase()](path, async (req, res) => {
      res.locals.routeKey = key;
      const sb = res.locals.sb;
      // Hard guard: the shared guest sandbox is never written to, whatever the path looked like.
      if (sb.guest && !isSafeMethod(req)) {
        return res.status(429).json({ error: 'too_many_sandboxes', message: 'Too many new sessions. Please wait a few minutes.' });
      }
      if (opts.cartWrite) ensureSid(res);
      /** @type {{status:number, body:any}|null} */
      let answer = null;
      const ctx = {
        req,
        body: req.body ?? {},
        sandbox: sb,
        session: sessionOf(res),
        validate: true,
        respond(status, body) { if (!answer) answer = { status, body }; },
        event(name, bug) { event(res, { type: 'bug', ...(bug ? { bug } : {}), event: name, route: key }); },
        expireSession() {
          const s = sessionOf(res);
          if (s && s.accountId) {
            s.accountId = null;
            s.expired = true;
          }
        },
        cart: async () => cartView(sb, res.locals.sid),
      };
      const hooks = sb.engine.hooks;
      if (await hooks.runBefore(key, ctx)) return res.status(answer.status).json(answer.body);
      let out;
      let account = null;
      if (opts.auth) {
        const st = authState(res);
        if (st.account) account = st.account;
        else {
          if (st.reason === 'session_expired') event(res, { type: 'session_expired', route: key });
          out = fail(401, st.reason, MSG[st.reason]);
        }
      }
      if (!out) out = await logic(ctx, res, account);
      const body = await hooks.runAfter(key, ctx, out.body);
      res.status(out.status).json(body);
    });
  };

  // --- classes ---------------------------------------------------------------------------------
  route('GET', '/api/classes', {}, (ctx, res) => {
    const { day, style, level } = ctx.req.query;
    const eq = (a, b) => typeof b !== 'string' || b === '' || a.toLowerCase() === b.toLowerCase();
    const classes = [...res.locals.sb.classes.values()]
      .filter((k) => eq(k.day, day) && eq(k.style, style) && eq(k.level, level))
      .map((k) => classView(res.locals.sb, k));
    return ok({ classes });
  });
  route('GET', '/api/classes/:id', {}, (ctx, res) => {
    const k = res.locals.sb.classes.get(ctx.req.params.id);
    return k ? ok(classView(res.locals.sb, k)) : fail(404, 'class_not_found', 'We could not find this class.');
  });
  route('GET', '/api/classes/:id/reviews', {}, (ctx, res) => {
    const k = res.locals.sb.classes.get(ctx.req.params.id);
    return k ? ok({ reviews: k.reviews }) : fail(404, 'class_not_found', 'We could not find this class.');
  });

  // --- auth --------------------------------------------------------------------------------------
  const userView = (a) => ({ name: a.name, email: a.email });
  /** Attaches the account to this client's sw_sid (creating one if needed); cart and cookie stay. */
  const attachLogin = (res, account) => {
    const sid = ensureSid(res);
    const s = res.locals.sb.sessions.get(sid);
    s.accountId = account.id;
    s.loginAt = Date.now();
    s.expired = false;
  };

  route('POST', '/api/auth/login', {}, (ctx, res) => {
    const email = String(ctx.body.email ?? '').trim().toLowerCase();
    const password = String(ctx.body.password ?? '');
    const account = res.locals.sb.accounts.find((a) => a.email === email && a.password === password);
    if (!account) {
      event(res, { type: 'login_failed' });
      return fail(401, 'login_failed', 'Email or password is wrong.');
    }
    attachLogin(res, account);
    event(res, { type: 'login' });
    return ok({ user: userView(account) });
  });

  route('POST', '/api/auth/logout', {}, (ctx, res) => {
    event(res, { type: 'logout' });
    const sid = res.locals.sid;
    if (sid) {
      res.locals.sb.sessions.delete(sid);
      res.locals.sb.carts.delete(sid);
      res.locals.sid = null;
    }
    res.clearCookie('sw_sid', cookieBase);
    return ok({ ok: true });
  });

  route('POST', '/api/auth/register', {}, (ctx, res) => {
    const name = String(ctx.body.name ?? '').trim();
    const email = String(ctx.body.email ?? '').trim().toLowerCase();
    const password = String(ctx.body.password ?? '');
    if (!name) return fail(400, 'name_required', 'Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'email_invalid', 'Enter a valid email address.');
    const sb = res.locals.sb;
    if (sb.accounts.some((a) => a.email === email)) return fail(409, 'email_taken', 'An account with this email already exists.');
    if (password.length < 8) return fail(400, 'password_short', 'Use at least 8 characters.');
    const account = {
      id: `a${sb.accounts.length + 1}`, email, password, name: name.slice(0, 60), phone: '',
      settings: { emailReminders: true, newsletter: false },
    };
    sb.accounts.push(account);
    attachLogin(res, account);
    event(res, { type: 'register' });
    return ok({ user: userView(account) }, 201);
  });

  // Status check, not a protected page: guests and unknown sessions get 200 { user: null } so the first
  // page load never logs a failed request. Only a known, expired session answers 401 session_expired.
  route('GET', '/api/me', {}, (ctx, res) => {
    const st = authState(res);
    if (st.account) return ok(userView(st.account));
    if (st.reason === 'session_expired') {
      event(res, { type: 'session_expired', route: 'GET /api/me' });
      return fail(401, 'session_expired', MSG.session_expired);
    }
    return ok({ user: null });
  });

  // --- profile and settings ----------------------------------------------------------------------
  const profileView = (a) => ({ name: a.name, email: a.email, phone: a.phone });
  route('GET', '/api/profile', { auth: true }, (ctx, res, account) => ok(profileView(account)));
  route('PUT', '/api/profile', { auth: true }, (ctx, res, account) => {
    const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim() : account.name;
    const phone = typeof ctx.body.phone === 'string' ? ctx.body.phone.trim() : account.phone;
    if (ctx.validate) {
      if (!name) return fail(400, 'name_invalid', 'Enter your name.');
      if (name.length > 60) return fail(400, 'name_invalid', 'Use at most 60 characters.');
      if (!/^[0-9 +-]{0,20}$/.test(phone)) return fail(400, 'phone_invalid', 'Use only digits, spaces, + and - (up to 20 characters).');
    }
    account.name = name;
    account.phone = phone;
    return ok(profileView(account));
  });
  route('GET', '/api/settings', { auth: true }, (ctx, res, account) => ok({ ...account.settings }));
  route('PUT', '/api/settings', { auth: true }, (ctx, res, account) => {
    const next = { ...account.settings };
    for (const k of ['emailReminders', 'newsletter']) {
      if (ctx.body[k] === undefined) continue;
      if (typeof ctx.body[k] !== 'boolean') return fail(400, 'settings_invalid', 'Settings must be on or off.');
      next[k] = ctx.body[k];
    }
    account.settings = next;
    return ok({ ...next });
  });

  // --- cart --------------------------------------------------------------------------------------
  const spotsOk = (n) => Number.isInteger(n) && n >= 1 && n <= 5;
  /** Capacity and time checks for `spots` of class `k`; null when fine. */
  const bookable = (k, spots) => {
    if (isEnded(k)) return fail(409, 'class_ended', MSG.class_ended);
    const left = spotsLeft(k);
    if (left <= 0) return fail(409, 'class_full', MSG.class_full);
    if (spots > left) return fail(409, 'class_full', `Only ${left} ${left === 1 ? 'spot' : 'spots'} left in this class.`);
    return null;
  };

  route('GET', '/api/cart', {}, (ctx, res) => ok(cartView(res.locals.sb, res.locals.sid)));
  route('POST', '/api/cart/items', { cartWrite: true }, (ctx, res) => {
    const sb = res.locals.sb;
    const k = sb.classes.get(String(ctx.body.classId ?? ''));
    if (!k) return fail(404, 'class_not_found', 'We could not find this class.');
    const spots = ctx.body.spots === undefined ? 1 : ctx.body.spots;
    const cart = cartOf(sb, res.locals.sid);
    const existing = cart.items.find((it) => it.classId === k.id);
    const total = existing ? existing.spots + spots : spots;
    if (ctx.validate && (!spotsOk(spots) || !spotsOk(total))) return fail(400, 'spots_range', MSG.spots_range);
    const problem = bookable(k, total);
    if (problem) return problem;
    if (existing) existing.spots = total;
    else cart.items.push({ id: `i${cart.nextItem++}`, classId: k.id, spots: total });
    return ok(cartView(sb, res.locals.sid));
  });
  route('PATCH', '/api/cart/items/:id', { cartWrite: true }, (ctx, res) => {
    const sb = res.locals.sb;
    const cart = cartOf(sb, res.locals.sid);
    const item = cart.items.find((it) => it.id === ctx.req.params.id);
    if (!item) return fail(404, 'item_not_found', 'This item is no longer in your cart.');
    const spots = ctx.body.spots;
    if (ctx.validate && !spotsOk(spots)) return fail(400, 'spots_range', MSG.spots_range);
    const problem = bookable(sb.classes.get(item.classId), spots);
    if (problem) return problem;
    item.spots = spots;
    return ok(cartView(sb, res.locals.sid));
  });
  route('DELETE', '/api/cart/items/:id', { cartWrite: true }, (ctx, res) => {
    const sb = res.locals.sb;
    const cart = cartOf(sb, res.locals.sid);
    const i = cart.items.findIndex((it) => it.id === ctx.req.params.id);
    if (i < 0) return fail(404, 'item_not_found', 'This item is no longer in your cart.');
    cart.items.splice(i, 1);
    return ok(cartView(sb, res.locals.sid));
  });
  route('POST', '/api/cart/coupon', { cartWrite: true }, (ctx, res) => {
    const code = String(ctx.body.code ?? '').trim().toUpperCase();
    if (!code) return fail(400, 'coupon_empty', 'Enter a coupon code.');
    if (code === 'SPRING25') return fail(400, 'coupon_expired', 'This code expired on March 31.');
    if (code !== 'YOGA10') return fail(400, 'coupon_unknown', "We don't know this code.");
    cartOf(res.locals.sb, res.locals.sid).coupon = 'YOGA10';
    return ok(cartView(res.locals.sb, res.locals.sid));
  });

  // --- checkout and bookings ---------------------------------------------------------------------
  const activeBookings = (sb, account) => sb.bookings.filter((b) => b.accountId === account.id && !b.cancelled);

  route('POST', '/api/checkout', { auth: true }, (ctx, res, account) => {
    const sb = res.locals.sb;
    if (ctx.body.acceptTerms !== true) return fail(400, 'terms_required', 'Please accept the studio terms to continue.');
    const cart = cartOf(sb, res.locals.sid);
    if (!cart.items.length) return fail(400, 'cart_empty', 'Your cart is empty.');
    if (ctx.validate) {
      const mine = new Set(activeBookings(sb, account).map((b) => b.classId));
      if (cart.items.some((it) => mine.has(it.classId))) return fail(409, 'already_booked', MSG.already_booked);
    }
    for (const it of cart.items) {
      const problem = bookable(sb.classes.get(it.classId), it.spots);
      if (problem) return problem;
    }
    const reference = newReference();
    const created = cart.items.map((it) => {
      sb.classes.get(it.classId).booked += it.spots;
      const b = { id: `b${sb.nextBooking++}`, accountId: account.id, classId: it.classId, spots: it.spots, reference };
      sb.bookings.push(b);
      return bookingView(sb, b);
    });
    cart.items = [];
    cart.coupon = null;
    return ok({ reference, bookings: created });
  });

  route('GET', '/api/bookings', { auth: true }, (ctx, res, account) =>
    ok({ bookings: activeBookings(res.locals.sb, account).map((b) => bookingView(res.locals.sb, b)) }));

  const findBooking = (sb, account, id) => activeBookings(sb, account).find((b) => b.id === id);
  route('POST', '/api/bookings/:id/cancel', { auth: true }, (ctx, res, account) => {
    const sb = res.locals.sb;
    const b = findBooking(sb, account, ctx.req.params.id);
    if (!b) return fail(404, 'booking_not_found', 'We could not find this booking.');
    b.cancelled = true;
    sb.classes.get(b.classId).booked -= b.spots;
    return ok({ booking: bookingView(sb, b) });
  });
  route('POST', '/api/bookings/:id/reschedule', { auth: true }, (ctx, res, account) => {
    const sb = res.locals.sb;
    const b = findBooking(sb, account, ctx.req.params.id);
    if (!b) return fail(404, 'booking_not_found', 'We could not find this booking.');
    const from = sb.classes.get(b.classId);
    const to = sb.classes.get(String(ctx.body.classId ?? ''));
    if (!to) return fail(404, 'class_not_found', 'We could not find this class.');
    if (to.id === from.id || to.style !== from.style) return fail(400, 'reschedule_style', 'Pick another class of the same style.');
    if (ctx.validate && activeBookings(sb, account).some((x) => x.classId === to.id)) return fail(409, 'already_booked', MSG.already_booked);
    const problem = bookable(to, b.spots);
    if (problem) return problem;
    from.booked -= b.spots;
    to.booked += b.spots;
    b.classId = to.id;
    return ok({ booking: bookingView(sb, b) });
  });

  // --- reports -----------------------------------------------------------------------------------
  route('POST', '/api/reports', {}, (ctx, res) => {
    const sb = res.locals.sb;
    const text = typeof ctx.body.text === 'string' ? ctx.body.text : '';
    if (!text.trim()) return fail(400, 'report_empty', 'Please describe the problem.');
    if (text.length > REPORT_LIMITS.textMax) return fail(400, 'report_long', 'Keep the report under 4000 characters.');
    const now = Date.now();
    const ip = ctx.req.ip ?? '';
    sb.reportTimes = sb.reportTimes.filter((t) => now - t < REPORT_LIMITS.windowMin * 60 * 1000);
    if (sb.reportTimes.length >= REPORT_LIMITS.perSandbox || reportsAll.full('all', now) || reportsIp.full(ip, now)) {
      return fail(429, 'too_many_reports', 'Too many reports. Please wait a few minutes.');
    }
    if (reportsFile && reportsBytes >= L.reportsBytes) return fail(507, 'reports_full', 'Reports are closed for now. Please try again later.');
    sb.reportTimes.push(now);
    reportsAll.add('all', now);
    reportsIp.add(ip, now);
    const line = {
      t: new Date(now).toISOString(),
      sb: sb.pub,
      seed: sb.seed,
      commit: process.env.CODER_PARCOURS_COMMIT || null,
      text,
      path: String(ctx.body.path ?? '').slice(0, REPORT_LIMITS.pathMax),
      viewportPx: Number.isFinite(Number(ctx.body.viewportPx)) ? Math.round(Number(ctx.body.viewportPx)) : 0,
      tester: normalizeTester(ctx.body.tester),
    };
    if (reportsFile) {
      const out = JSON.stringify(line) + '\n';
      appendFileSync(reportsFile, out);
      reportsBytes += Buffer.byteLength(out);
    }
    return ok({ ok: true }, 201);
  });

  // --- pages -------------------------------------------------------------------------------------
  app.get('/assets/runtime.js', (req, res) => {
    res.set('Cache-Control', 'no-store').type('text/javascript').send(res.locals.sb.engine.runtimeScript());
  });
  if (staticDir) app.use(express.static(staticDir, { index: false }));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api') return next();
    const file = staticDir ? join(staticDir, 'index.html') : null;
    if (!file || !existsSync(file)) return res.status(503).type('text/plain').send('App not built. Run npm run build in coder-parcours/.');
    const html = readFileSync(file, 'utf8');
    const m = /<head[^>]*>/i.exec(html);
    const out = m ? html.slice(0, m.index + m[0].length) + RUNTIME_TAG + html.slice(m.index + m[0].length) : RUNTIME_TAG + html;
    res.set('Cache-Control', 'no-store').type('html').send(out);
  });
  // --- unknown /api, broken JSON -----------------------------------------------------------------
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'Not found.' });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'The request body is not valid JSON.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'The request is too large.' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on our side.' });
  });

  return {
    app,
    /**
     * @param {number} port 0 = free port
     * @param {string} [host] default 127.0.0.1 (single) or 0.0.0.0 (hosted)
     */
    listen(port, host = mode === 'hosted' ? '0.0.0.0' : '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const server = app.listen(port, host, (err) => {
          if (err) return reject(err);
          const addr = server.address();
          resolve({
            port: typeof addr === 'object' && addr ? addr.port : port,
            close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done(undefined)); }),
          });
        });
        server.on('error', reject);
      });
    },
  };
}
