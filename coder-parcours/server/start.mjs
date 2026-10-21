// CLI: starts the Stillwater Yoga app server and prints `READY <port>` once it listens.
//   node server/start.mjs --seed <n> --session explore|capture [--variant healthy|broken] [--port <n>]
//     [--events <file>] [--reports <file>] [--secret-dir <dir>] [--static <dir>]
//     [--activate P01@schedule:phone,...] [--no-bugs] [--hosted] [--admin-token-env <VAR>]
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog } from '../catalog/load.mjs';
import { buildRunConfig, loadSeeds } from '../harness/seed.mjs';
import { createServer, nullEngine } from './app.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * RunConfig per seed for hosted mode: always the explore configuration of that seed (including a broken
 * change target when changeBrokenFor(seed)), so people see the same state as the explore sessions.
 * @param {import('../catalog/load.mjs').Catalog} catalog
 * @param {{ noBugs?: boolean }} [opts]
 * @returns {(seed: number) => import('../harness/seed.mjs').RunConfig}
 */
export function hostedConfigForSeed(catalog, { noBugs = false } = {}) {
  return (seed) => withoutBugs(buildRunConfig({ seed, sessionType: 'explore', catalog }), noBugs);
}

/** @param {any} cfg @param {boolean} noBugs */
function withoutBugs(cfg, noBugs) {
  return noBugs ? { ...cfg, active: [], change: null } : cfg;
}

/**
 * Parses `P01@schedule:phone,P02@cart:all`.
 * @param {string} text
 * @returns {Array<{ id: string, station: string, width: any }>}
 */
export function parseActivate(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const m = /^([A-Z]\d{2})@([a-z-]+):(phone|tablet|desktop|all)$/.exec(part);
    if (!m) throw new Error(`--activate: cannot read "${part}" (expected ID@station:width)`);
    return { id: m[1], station: m[2], width: m[3] };
  });
}

/** @param {string[]} argv */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      seed: { type: 'string' },
      session: { type: 'string', default: 'explore' },
      variant: { type: 'string' },
      port: { type: 'string', default: '4300' },
      events: { type: 'string' },
      reports: { type: 'string' },
      'secret-dir': { type: 'string' },
      static: { type: 'string', default: 'app/dist' },
      activate: { type: 'string' },
      'no-bugs': { type: 'boolean', default: false },
      hosted: { type: 'boolean', default: false },
      'admin-token-env': { type: 'string' },
    },
  });
  if (values.hosted && values['secret-dir']) {
    process.stderr.write('start: --hosted with --secret-dir is refused: the secret part must never be served publicly.\n');
    return 2;
  }
  const catalog = await loadCatalog({ secretDir: values['secret-dir'] ?? null });
  const noBugs = values['no-bugs'];
  const fromRoot = (p) => (p ? resolve(process.cwd(), p) : null);
  const common = {
    eventsFile: fromRoot(values.events),
    reportsFile: fromRoot(values.reports),
    staticDir: values.static === 'app/dist' ? resolve(ROOT, 'app/dist') : resolve(process.cwd(), values.static),
    adminToken: values['admin-token-env'] ? process.env[values['admin-token-env']] || null : null,
    makeEngine: () => nullEngine,
  };

  let srv;
  if (values.hosted) {
    srv = createServer({ mode: 'hosted', configForSeed: hostedConfigForSeed(catalog, { noBugs }), ...common });
  } else {
    const seed = values.seed === undefined ? loadSeeds()[0] : Number(values.seed);
    if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer (got ${values.seed})`);
    const runConfig = withoutBugs(buildRunConfig({
      seed,
      sessionType: /** @type {any} */ (values.session),
      catalog,
      variant: /** @type {any} */ (values.variant ?? null),
      activate: values.activate ? parseActivate(values.activate) : null,
    }), noBugs);
    srv = createServer({ mode: 'single', runConfig, ...common });
  }
  const handle = await srv.listen(Number(values.port));
  process.stdout.write(`READY ${handle.port}\n`);
  const stop = () => handle.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== null) process.exit(code); },
    (err) => { process.stderr.write(`start: ${err.message}\n`); process.exit(1); },
  );
}
