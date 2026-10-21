// In-memory state: one sandbox per app instance (single) or per visitor (hosted), plus read views for the API.
import { randomBytes } from 'node:crypto';
import { createInitialData, isEnded } from './data.mjs';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SANDBOX_IDLE_MS = 2 * 60 * 60 * 1000;
export const SANDBOX_MAX = 500;

/**
 * Login state of one sw_sid. accountId null + expired false = anonymous (never logged in or logged out of a
 * previous account via logout, which deletes the record). expired true = the login was dropped server side.
 * @typedef {{ sid: string, accountId: string|null, loginAt: number|null, expired: boolean }} Session
 * @typedef {{ id: string, classId: string, spots: number }} CartItem
 * @typedef {{ items: CartItem[], coupon: string|null, nextItem: number }} Cart
 */

/**
 * @param {{ id: string, seed: number, runConfig: any }} opts
 */
export function createSandbox({ id, seed, runConfig }) {
  const data = createInitialData();
  return {
    id,
    /** public id for files and engines (the id itself is the sw_sb cookie value); set by the server */
    pub: '',
    seed,
    runConfig,
    /** @type {any} set by the server: engine of this sandbox */
    engine: null,
    classes: new Map(data.classes.map((k) => [k.id, k])),
    accounts: data.accounts,
    bookings: data.bookings,
    nextBooking: data.bookings.length + 1,
    /** @type {Map<string, Session>} */
    sessions: new Map(),
    /** @type {Map<string, Cart>} carts belong to the sw_sid, not to the account */
    carts: new Map(),
    /** @type {number[]} timestamps of accepted reports */
    reportTimes: [],
    lastUsed: Date.now(),
  };
}

/** @typedef {ReturnType<typeof createSandbox>} Sandbox */

/**
 * Hosted sandboxes: expire after SANDBOX_IDLE_MS idle, at most SANDBOX_MAX (oldest by last use go first).
 * @param {{ create: (seed: number) => Sandbox, max?: number, idleMs?: number, now?: () => number }} opts
 */
export function createSandboxPool({ create, max = SANDBOX_MAX, idleMs = SANDBOX_IDLE_MS, now = Date.now }) {
  /** @type {Map<string, Sandbox>} */
  const pool = new Map();
  const purge = () => {
    const t = now();
    for (const [id, sb] of pool) if (t - sb.lastUsed > idleMs) pool.delete(id);
  };
  return {
    /** @param {string|undefined} id */
    get(id) {
      if (!id) return null;
      const sb = pool.get(id);
      if (!sb) return null;
      if (now() - sb.lastUsed > idleMs) {
        pool.delete(id);
        return null;
      }
      sb.lastUsed = now();
      return sb;
    },
    /** @param {number} seed */
    add(seed) {
      purge();
      while (pool.size >= max) {
        let oldest = null;
        for (const sb of pool.values()) if (!oldest || sb.lastUsed < oldest.lastUsed) oldest = sb;
        pool.delete(oldest.id);
      }
      const sb = create(seed);
      sb.lastUsed = now();
      pool.set(sb.id, sb);
      return sb;
    },
    get size() {
      return pool.size;
    },
  };
}

export const newId = (bytes = 12) => randomBytes(bytes).toString('hex');

/** @param {any} k */
export function spotsLeft(k) {
  return k.capacity - k.booked;
}

/**
 * @param {Sandbox} sb
 * @param {any} k
 */
export function classView(sb, k) {
  const left = spotsLeft(k);
  return {
    id: k.id, name: k.name, style: k.style, level: k.level, teacher: k.teacher, day: k.day, start: k.start,
    durationMin: k.durationMin, priceCents: k.priceCents, currency: 'USD', capacity: k.capacity,
    spotsLeft: left, full: left <= 0, ended: isEnded(k), description: k.description,
  };
}

/**
 * @param {Sandbox} sb
 * @param {string|null} sid
 * @returns {Cart}
 */
export function cartOf(sb, sid) {
  if (!sid) return { items: [], coupon: null, nextItem: 1 };
  if (!sb.carts.has(sid)) sb.carts.set(sid, { items: [], coupon: null, nextItem: 1 });
  return sb.carts.get(sid);
}

/**
 * Shape of GET /api/cart.
 * @param {Sandbox} sb
 * @param {string|null} sid
 */
export function cartView(sb, sid) {
  const cart = sid && sb.carts.has(sid) ? sb.carts.get(sid) : { items: [], coupon: null };
  const items = cart.items.map((it) => {
    const k = sb.classes.get(it.classId);
    return {
      id: it.id, classId: it.classId, name: k.name, style: k.style, day: k.day, start: k.start, teacher: k.teacher,
      spots: it.spots, priceCents: k.priceCents, lineCents: k.priceCents * it.spots,
    };
  });
  const subtotalCents = items.reduce((s, it) => s + it.lineCents, 0);
  const discountCents = cart.coupon === 'YOGA10' ? Math.round(subtotalCents * 0.1) : 0;
  return {
    items,
    count: items.reduce((s, it) => s + it.spots, 0),
    coupon: cart.coupon,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    currency: 'USD',
  };
}

/**
 * @param {Sandbox} sb
 * @param {any} b booking
 */
export function bookingView(sb, b) {
  return { id: b.id, classId: b.classId, spots: b.spots, reference: b.reference, class: classView(sb, sb.classes.get(b.classId)) };
}

/** 'SW-' + 4 characters from A-Z and 0-9. */
export function newReference() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(4);
  return 'SW-' + [...bytes].map((x) => abc[x % abc.length]).join('');
}
