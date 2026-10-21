// Loads public and (optionally) secret bug modules plus decoys into one catalog.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBug, validateDecoy } from './schema.mjs';

/** coder-parcours/ — relative paths resolve against this folder. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {import('./schema.mjs').Bug} Bug */
/** @typedef {import('./schema.mjs').Decoy} Decoy */
/**
 * @typedef {{ bugs: Bug[], decoys: Decoy[],
 *   unplanned: Array<{id: string, title: string, grader: string, station: string, seeds?: number[]}>,
 *   sources: { public: number, secret: number } }} Catalog
 */

/**
 * @param {string} dir absolute
 * @param {'public'|'secret'} source
 * @returns {Promise<Array<Bug & { __file: string }>>}
 */
async function loadBugDir(dir, source) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort();
  } catch (err) {
    throw new Error(`catalog: cannot read ${source} bug folder ${dir}: ${err.message}`);
  }
  const bugs = [];
  for (const name of names) {
    const file = join(dir, name);
    // Content hash in the URL: a changed file is re-imported instead of served from the module cache.
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
    const mod = await import(`${pathToFileURL(file).href}?v=${hash}`);
    const bug = mod.default;
    const problems = validateBug(bug);
    if (problems.length) throw new Error(`catalog: ${name}: ${problems.join('; ')}`);
    if (source === 'secret' && !Array.isArray(bug.removesDecoys)) {
      throw new Error(`catalog: ${name}: secret bugs must list removesDecoys (an empty list is allowed)`);
    }
    bugs.push({ ...bug, source, __file: name });
  }
  return bugs;
}

/**
 * @param {string} file absolute
 * @returns {any[]}
 */
function readJsonList(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`catalog: ${basename(file)}: ${err.message}`);
  }
  if (!Array.isArray(data)) throw new Error(`catalog: ${basename(file)}: must contain a JSON list`);
  return data;
}

/**
 * @param {string} file absolute
 * @returns {Decoy[]}
 */
function readDecoys(file) {
  const decoys = readJsonList(file);
  decoys.forEach((d, i) => {
    const problems = validateDecoy(d);
    if (problems.length) throw new Error(`catalog: ${basename(file)}[${i}]: ${problems.join('; ')}`);
  });
  return decoys;
}

/**
 * Loads the catalog. Relative paths resolve against coder-parcours/.
 * publicDir defaults to $CODER_PARCOURS_PUBLIC_DIR, else bugs/public.
 * With secretDir, also loads `${secretDir}/bugs/*.mjs` and `${secretDir}/decoys.json`.
 * Throws (with the file name) on duplicate ids, invalid modules or decoys,
 * and secret bugs without a removesDecoys list.
 * @param {{ publicDir?: string, secretDir?: string|null, decoysFile?: string, unplannedFile?: string }} [opts]
 * @returns {Promise<Catalog>}
 */
export async function loadCatalog({ publicDir, secretDir = null, decoysFile, unplannedFile } = {}) {
  const pubDir = resolve(ROOT, publicDir ?? process.env.CODER_PARCOURS_PUBLIC_DIR ?? 'bugs/public');
  const loaded = await loadBugDir(pubDir, 'public');
  let decoys = readDecoys(resolve(ROOT, decoysFile ?? 'catalog/decoys.json'));
  let secretCount = 0;
  if (secretDir) {
    const secRoot = resolve(ROOT, secretDir);
    const secret = await loadBugDir(join(secRoot, 'bugs'), 'secret');
    secretCount = secret.length;
    loaded.push(...secret);
    decoys = [...decoys, ...readDecoys(join(secRoot, 'decoys.json'))];
  }

  const seen = new Map();
  const bugs = [];
  for (const { __file, ...bug } of loaded) {
    if (seen.has(bug.id)) throw new Error(`catalog: ${__file}: duplicate id ${bug.id} (already in ${seen.get(bug.id)})`);
    seen.set(bug.id, __file);
    bugs.push(/** @type {Bug} */ (bug));
  }
  const decoyIds = new Set();
  for (const d of decoys) {
    if (decoyIds.has(d.id)) throw new Error(`catalog: decoys: duplicate id ${d.id}`);
    decoyIds.add(d.id);
  }

  const unplanned = readJsonList(resolve(ROOT, unplannedFile ?? 'catalog/unplanned.json'));
  return { bugs, decoys, unplanned, sources: { public: bugs.length - secretCount, secret: secretCount } };
}
