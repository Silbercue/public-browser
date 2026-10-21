// Seeded run configuration: which bugs are active where, the change target, the capture target, the decoys.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @typedef {import('../catalog/schema.mjs').Bug} Bug */
/** @typedef {import('../catalog/load.mjs').Catalog} Catalog */
/** @typedef {{ id: string, station: string, width: 'phone'|'tablet'|'desktop'|'all' }} Activation */
/**
 * @typedef {{ seed: number, sessionType: 'explore'|'capture', variant: 'healthy'|'broken'|null,
 *   sources: { public: number, secret: number }, active: Activation[],
 *   change: { bugId: string, broken: boolean, activation: Activation } | null,
 *   capture: { bugId: string } | null, decoys: string[] }} RunConfig
 *   decoys: decoy ids without a conflict with an active bug.
 */

/**
 * mulberry32 seeded from the first 4 bytes of sha256(key).
 * @param {string} key
 * @returns {() => number} in [0, 1)
 */
export function prng(key) {
  let a = createHash('sha256').update(String(key)).digest().readUInt32BE(0);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Whether the change target is broken for this seed. Depends only on the seed.
 * @param {number} seed
 * @returns {boolean}
 */
export function changeBrokenFor(seed) {
  return prng(`${seed}:broken`)() < 0.5;
}

/**
 * round(0.4 * poolSize) + one of {-1, 0, 1}, at least 1. Uses exactly one draw.
 * @param {number} poolSize
 * @param {() => number} rand
 * @returns {number}
 */
export function activeCountFor(poolSize, rand) {
  const delta = Math.floor(rand() * 3) - 1;
  return Math.max(1, Math.round(0.4 * poolSize) + delta);
}

/**
 * @template T
 * @param {T[]} list non-empty
 * @param {() => number} r
 * @returns {T}
 */
const pick = (list, r) => list[Math.floor(r() * list.length)];

/**
 * @param {Bug} bug
 * @param {() => number} r
 * @param {Activation['width']} [width] fixed width, else drawn from bug.widths
 * @returns {Activation}
 */
function activate(bug, r, width) {
  const station = pick(bug.stations, r);
  return { id: bug.id, station, width: width ?? /** @type {Activation['width']} */ (pick(bug.widths, r)) };
}

/**
 * Public part of an explore run: stratified, then filled at random.
 * @param {Bug[]} pool public bugs without the change target, sorted by id
 * @param {number} publicSize size of the whole public pool
 * @param {() => number} r
 * @returns {Activation[]}
 */
function stratifiedPublic(pool, publicSize, r) {
  const count = Math.min(activeCountFor(publicSize, r), pool.length);
  /** @type {Array<{ bug: Bug, act: Activation }>} */
  const chosen = [];
  const free = (pred) => pool.filter((b) => pred(b) && !chosen.some((c) => c.bug.id === b.id));
  const take = (cands, width) => {
    const bug = pick(cands, r);
    chosen.push({ bug, act: activate(bug, r, width) });
  };

  const traps = free((b) => !!b.roles?.trap);
  if (traps.length) take(traps);
  for (const w of /** @type {const} */ (['phone', 'tablet', 'desktop'])) {
    if (chosen.some((c) => c.act.width === w)) continue;
    const cands = free((b) => b.widths.includes(w));
    if (cands.length) take(cands, w);
  }
  for (const cat of ['fiddly', 'next-step']) {
    if (chosen.some((c) => c.bug.category === cat)) continue;
    const cands = free((b) => b.category === cat);
    if (cands.length) take(cands);
  }
  while (chosen.length < count) {
    const cands = free(() => true);
    if (!cands.length) break;
    take(cands);
  }
  return chosen.map((c) => c.act);
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * @param {{ seed: number, sessionType: 'explore'|'capture', catalog: Catalog,
 *   variant?: 'healthy'|'broken'|null, activate?: Activation[]|null }} opts
 * @returns {RunConfig}
 */
export function buildRunConfig({ seed, sessionType, catalog, variant = null, activate: activateList = null }) {
  if (!Number.isInteger(seed)) throw new Error(`buildRunConfig: seed must be an integer (got ${JSON.stringify(seed)})`);
  if (sessionType !== 'explore' && sessionType !== 'capture') throw new Error(`buildRunConfig: unknown sessionType ${JSON.stringify(sessionType)}`);
  if (variant !== null && variant !== 'healthy' && variant !== 'broken') throw new Error(`buildRunConfig: unknown variant ${JSON.stringify(variant)}`);

  const publicBugs = catalog.bugs.filter((b) => b.source !== 'secret').sort(byId);
  const secretBugs = catalog.bugs.filter((b) => b.source === 'secret').sort(byId);
  const bugById = new Map(catalog.bugs.map((b) => [b.id, b]));

  /** @type {Activation[]} */
  let active = [];
  /** @type {RunConfig['change']} */
  let change = null;
  /** @type {RunConfig['capture']} */
  let capture = null;

  if (sessionType === 'explore') {
    variant = null;
    const broken = changeBrokenFor(seed);
    const changeCands = publicBugs.filter((b) => b.roles?.change);
    if (changeCands.length) {
      const target = pick(changeCands, prng(`${seed}:change`));
      change = { bugId: target.id, broken, activation: { id: target.id, station: target.stations[0], width: 'all' } };
      if (broken) active.push({ ...change.activation });
    }
    const pool = publicBugs.filter((b) => !change || b.id !== change.bugId);
    active.push(...stratifiedPublic(pool, publicBugs.length, prng(`${seed}:active`)));
    if (secretBugs.length) {
      const r = prng(`${seed}:secret`);
      const n = Math.min(activeCountFor(secretBugs.length, r), secretBugs.length);
      const rest = [...secretBugs];
      for (let i = 0; i < n; i++) {
        const bug = rest.splice(Math.floor(r() * rest.length), 1)[0];
        active.push(activate(bug, r));
      }
    }
  } else {
    const captureCands = publicBugs.filter((b) => b.roles?.capture);
    if (captureCands.length) {
      const target = pick(captureCands, prng(`${seed}:capture`));
      capture = { bugId: target.id };
      if (variant === 'broken') active = [{ id: target.id, station: target.stations[0], width: 'all' }];
    }
  }

  if (activateList) {
    for (const a of activateList) if (!bugById.has(a.id)) throw new Error(`buildRunConfig: --activate names unknown bug ${a.id}`);
    active = activateList.map((a) => ({ id: a.id, station: a.station, width: a.width }));
  }

  const activeIds = new Set(active.map((a) => a.id));
  const removed = new Set(active.flatMap((a) => bugById.get(a.id)?.removesDecoys ?? []));
  const decoys = catalog.decoys
    .filter((d) => !removed.has(d.id) && !(d.conflicts ?? []).some((id) => activeIds.has(id)))
    .map((d) => d.id);

  return {
    seed,
    sessionType,
    variant,
    sources: { public: publicBugs.length, secret: secretBugs.length },
    active,
    change,
    capture,
    decoys,
  };
}

/**
 * @param {any} v
 * @returns {any}
 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/**
 * sha256 hex over canonical JSON (keys sorted at every level).
 * @param {object} cfg
 * @returns {string}
 */
export function runConfigSha(cfg) {
  return createHash('sha256').update(JSON.stringify(canonical(cfg))).digest('hex');
}

/** @returns {number[]} */
export function loadSeeds() {
  return JSON.parse(readFileSync(join(HERE, 'seeds.json'), 'utf8'));
}
