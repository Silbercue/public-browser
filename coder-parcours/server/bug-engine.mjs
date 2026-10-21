// Bug engine: loads the active bug modules of one run and turns them into server hooks plus a browser runtime script.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIDTHS } from '../catalog/schema.mjs';
import { createHookSet } from './hooks.mjs';

/** Name of a function defined in the runtime file; present in every shipped script, absent from normal page output. */
export const RUNTIME_MARKER = 'function __swBoot(';

const RUNTIME_FILE = join(dirname(fileURLToPath(import.meta.url)), 'client-runtime.js');
const HEX8 = /^[0-9a-f]{8}$/;
const BEACON_URL = '/api/metrics';

/**
 * Source text of a function as a standalone expression (method shorthand `setup(api) {}` becomes `function setup(api) {}`).
 * @param {Function} fn
 * @returns {string}
 */
function expressionSource(fn) {
  const src = fn.toString().trim();
  if (/^(async\s+)?function\b/.test(src)) return src;
  if (/^(async\s*)?\(/.test(src) || /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(src)) return src;
  return src.replace(/^(async\s+)?/, (m) => `${m}function `);
}

/**
 * @param {{ catalog: import('../catalog/load.mjs').Catalog, runConfig: import('../harness/seed.mjs').RunConfig,
 *   salt?: string, logEvent?: (entry: object) => void }} opts
 * @returns {{ hooks: ReturnType<typeof createHookSet>, runtimeScript: () => string,
 *   decodeBeacon: (b: any, e: any) => ({ bug: string, event: 'reached'|'passed' }) | null,
 *   activeIds: string[], codesFor: (id: string) => { key: string, reached: string, passed: string } }}
 */
export function createBugEngine({ catalog, runConfig, salt = randomBytes(8).toString('hex'), logEvent = () => {} }) {
  const hooks = createHookSet();
  const byId = new Map(catalog.bugs.map((b) => [b.id, b]));
  const keyOf = (id) => createHash('sha256').update(salt + id).digest('hex').slice(0, 8);

  /** @type {Map<string, { key: string, reached: string, passed: string }>} */
  const codes = new Map();
  /** @type {Map<string, { bug: string, event: 'reached'|'passed' }>} */
  const table = new Map();
  /** @type {string[]} */
  const activeIds = [];
  const parts = [];

  for (const act of runConfig.active) {
    if (codes.has(act.id)) continue;
    const bug = byId.get(act.id);
    if (!bug) throw new Error(`bug engine: active bug ${act.id} is not in the catalog`);
    const key = keyOf(act.id);
    const c = { key, reached: randomBytes(4).toString('hex'), passed: randomBytes(4).toString('hex') };
    codes.set(act.id, c);
    table.set(`${c.key}:${c.reached}`, { bug: act.id, event: 'reached' });
    table.set(`${c.key}:${c.passed}`, { bug: act.id, event: 'passed' });
    activeIds.push(act.id);

    const width = act.width;
    const ctx = {
      station: act.station,
      width,
      media: width === 'all' ? '' : WIDTHS[width].media,
      section: `[data-section="${act.station}"]`,
    };
    if (bug.client?.css) {
      const css = String(bug.client.css(ctx));
      parts.push(`__sw.css(${JSON.stringify(ctx.media ? `@media ${ctx.media} {\n${css}\n}` : css)});`);
    }
    if (bug.client?.setup) {
      parts.push(`__sw.run(${JSON.stringify(key)}, ${JSON.stringify(ctx)}, ${expressionSource(bug.client.setup)});`);
    }
    if (bug.server?.setup) {
      const wrap = (fn) => (hctx, ...rest) => fn(new Proxy(hctx, {
        get: (t, p) => (p === 'event' ? (name) => t.event(name, act.id) : t[p]),
        set: (t, p, v) => { t[p] = v; return true; },
      }), ...rest);
      bug.server.setup({
        before: (route, fn) => hooks.before(route, wrap(fn)),
        after: (route, fn) => hooks.after(route, wrap(fn)),
        event: (name) => logEvent({ type: 'bug', bug: act.id, event: name }),
      }, { station: act.station, seed: runConfig.seed });
    }
  }

  const beaconCodes = Object.fromEntries([...codes.values()].map((c) => [c.key, [c.reached, c.passed]]));
  let script = null;

  return {
    hooks,
    activeIds,
    runtimeScript() {
      script ??= [
        readFileSync(RUNTIME_FILE, 'utf8'),
        `__swBoot(${JSON.stringify({ url: BEACON_URL, codes: beaconCodes })});`,
        ...parts,
        '',
      ].join('\n');
      return script;
    },
    decodeBeacon(b, e) {
      if (typeof b !== 'string' || typeof e !== 'string' || !HEX8.test(b) || !HEX8.test(e)) return null;
      return table.get(`${b}:${e}`) ?? null;
    },
    codesFor(id) {
      const c = codes.get(id);
      if (!c) throw new Error(`bug engine: ${id} is not active`);
      return { ...c };
    },
  };
}
