// Shared catalog vocabulary and validation for bug modules and decoys.
// The contract for bug authors is bugs/README.md.

export const CATEGORIES = ['fiddly', 'next-step', 'layout', 'function', 'timing', 'background'];
export const STATIONS = ['home', 'schedule', 'class-detail', 'cart', 'checkout', 'login', 'register', 'profile', 'settings', 'bookings'];
export const WIDTHS = {
  phone: { px: 390, media: '(max-width: 600px)' },
  tablet: { px: 768, media: '(min-width: 601px) and (max-width: 1100px)' },
  desktop: { px: 1440, media: '(min-width: 1101px)' },
};
export const SEVERITIES = ['low', 'medium', 'high'];

const WIDTH_VALUES = ['phone', 'tablet', 'desktop', 'all'];
const BUG_ID = /^[A-Z]\d{2}$/;
const DECOY_ID = /^D\d{2}$/;

/**
 * @typedef {{ station: string, width: string, media: string, section: string }} ClientCtx
 *   section is the CSS selector of the station root, e.g. '[data-section="cart"]'.
 */
/**
 * @typedef {{ id: string, category: string, title: string, stations: string[],
 *   widths: Array<'phone'|'tablet'|'desktop'|'all'>, severity: string, symptom: string, grader: string,
 *   roles?: { change?: { feature: string }, capture?: { flow: string }, trap?: { reached: string, passed: string } },
 *   removesDecoys?: string[],
 *   source?: 'public'|'secret',
 *   client?: { css?: (ctx: ClientCtx) => string, setup?: (api: object, ctx: ClientCtx) => void },
 *   server?: { setup: (api: object, ctx: { station: string, seed: number }) => void } }} Bug
 *   removesDecoys: decoy ids whose explanation this bug can remove (required for secret bugs).
 *   source: set by loadCatalog, never written in the module.
 */
/**
 * @typedef {{ id: string, station: string, title: string, grader: string, conflicts?: string[] }} Decoy
 *   conflicts: bug ids that can remove this decoy's explanation.
 */

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyAll = (widths) => Array.isArray(widths) && widths.length === 1 && widths[0] === 'all';

/**
 * Validates the default export of a bug module.
 * @param {any} mod
 * @returns {string[]} problems, empty when valid
 */
export function validateBug(mod) {
  if (!isObj(mod)) return ['bug must be an object (the default export of the module)'];
  const p = [];
  if (typeof mod.id !== 'string' || !BUG_ID.test(mod.id)) p.push(`id must match ${BUG_ID} (got ${JSON.stringify(mod.id)})`);
  if (!CATEGORIES.includes(mod.category)) p.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (!isText(mod.title)) p.push('title must not be empty');
  if (!Array.isArray(mod.stations) || mod.stations.length === 0) p.push('stations must be a non-empty list');
  else for (const s of mod.stations) if (!STATIONS.includes(s)) p.push(`unknown station ${JSON.stringify(s)}`);
  if (!Array.isArray(mod.widths) || mod.widths.length === 0) p.push('widths must be a non-empty list');
  else {
    for (const w of mod.widths) if (!WIDTH_VALUES.includes(w)) p.push(`unknown width ${JSON.stringify(w)}`);
    if (mod.widths.includes('all') && mod.widths.length > 1) p.push("width 'all' must stand alone");
  }
  if (!SEVERITIES.includes(mod.severity)) p.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!isText(mod.symptom)) p.push('symptom must not be empty');
  if (!isText(mod.grader)) p.push('grader must not be empty');

  if (mod.client === undefined && mod.server === undefined) p.push('bug needs a client or server part');
  if (mod.client !== undefined) {
    if (!isObj(mod.client)) p.push('client must be an object');
    else {
      if (mod.client.css !== undefined && typeof mod.client.css !== 'function') p.push('client.css must be a function');
      if (mod.client.setup !== undefined && typeof mod.client.setup !== 'function') p.push('client.setup must be a function');
      if (mod.client.css === undefined && mod.client.setup === undefined) p.push('client needs css or setup');
    }
  }
  if (mod.server !== undefined) {
    if (!isObj(mod.server) || typeof mod.server.setup !== 'function') p.push('server.setup must be a function');
    if (!onlyAll(mod.widths)) p.push("a bug with a server part must have widths ['all']");
  }

  if (mod.roles !== undefined) {
    if (!isObj(mod.roles)) p.push('roles must be an object');
    else {
      const { change, capture, trap } = mod.roles;
      if (change !== undefined) {
        if (!isObj(change) || !isText(change.feature)) p.push('roles.change.feature must not be empty');
        if (!onlyAll(mod.widths)) p.push("a bug with roles.change must have widths ['all']");
      }
      if (capture !== undefined) {
        if (!isObj(capture) || !isText(capture.flow)) p.push('roles.capture.flow must not be empty');
        if (!onlyAll(mod.widths)) p.push("a bug with roles.capture must have widths ['all']");
      }
      if (trap !== undefined) {
        if (!isObj(trap) || !isText(trap.reached) || !isText(trap.passed)) p.push('roles.trap needs reached and passed texts');
        if (mod.category !== 'timing') p.push("roles.trap is only allowed for category 'timing'");
      }
    }
  }

  if (mod.removesDecoys !== undefined) {
    if (!Array.isArray(mod.removesDecoys)) p.push('removesDecoys must be a list');
    else for (const d of mod.removesDecoys) if (typeof d !== 'string' || !DECOY_ID.test(d)) p.push(`removesDecoys: ${JSON.stringify(d)} must match ${DECOY_ID}`);
  }
  if (mod.source !== undefined) p.push('source is set by loadCatalog and must not be in the module');
  return p;
}

/**
 * @param {any} d
 * @returns {string[]} problems, empty when valid
 */
export function validateDecoy(d) {
  if (!isObj(d)) return ['decoy must be an object'];
  const p = [];
  if (typeof d.id !== 'string' || !DECOY_ID.test(d.id)) p.push(`id must match ${DECOY_ID} (got ${JSON.stringify(d.id)})`);
  if (!STATIONS.includes(d.station)) p.push(`unknown station ${JSON.stringify(d.station)}`);
  if (!isText(d.title)) p.push('title must not be empty');
  if (!isText(d.grader)) p.push('grader must not be empty');
  if (d.conflicts !== undefined) {
    if (!Array.isArray(d.conflicts)) p.push('conflicts must be a list');
    else for (const c of d.conflicts) if (typeof c !== 'string' || !BUG_ID.test(c)) p.push(`conflicts: ${JSON.stringify(c)} must match ${BUG_ID}`);
  }
  return p;
}

/**
 * Width class for a viewport width in CSS pixels, following WIDTHS[*].media.
 * @param {number} px
 * @returns {'phone'|'tablet'|'desktop'}
 */
export function widthClassForPx(px) {
  if (px <= 600) return 'phone';
  if (px <= 1100) return 'tablet';
  return 'desktop';
}
