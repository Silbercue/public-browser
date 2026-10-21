// Julian's review of the grader, blinded: he never sees which participant a finding comes from.
// CLI: node harness/review.mjs pending|apply|sample|agreement --round <r> [--n 20] [--results <dir>] [--secret-dir <dir>]
//   pending   -> review/pending.json (open findings, shuffled, names replaced by [tool])
//   apply     -> reads review/decisions.json, adds new bugs to catalog/unplanned.json, regrades the round (--recall)
//   sample    -> review/sample.md (random matches, low confidence first)
//   agreement -> reads review/sample-verdicts.json and prints the agreement
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CP_ROOT, RESULTS_ROOT, catalogFor, classifyFindings, gradeRound, makeScrubber, parseArgs, participantTerms, readDecisions, readJson, sessionBugIds as sessionBugsOf, staleDecisionKeys } from './grade.mjs';
import { prng } from './seed.mjs';
import { STATIONS } from '../catalog/schema.mjs';

const DEFAULT_UNPLANNED = join(CP_ROOT, 'catalog', 'unplanned.json');
const FIELDS = ['title', 'where', 'steps', 'expected', 'actual'];

/**
 * @template T
 * @param {T[]} list
 * @param {() => number} r
 * @returns {T[]} new shuffled list (Fisher-Yates)
 */
function shuffle(list, r) {
  const out = [...list];
  for (let k = out.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    [out[k], out[j]] = [out[j], out[k]];
  }
  return out;
}

/** @param {string} dir */
const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []);

/**
 * Graded explore results of a round plus a scrubber built from the participants of all its session files.
 * @param {string} roundDir
 */
function loadRound(roundDir) {
  const gradedDir = join(roundDir, 'graded');
  const graded = jsonFiles(gradedDir).map((name) => ({ name, g: JSON.parse(readFileSync(join(gradedDir, name), 'utf8')) }));
  const terms = [];
  for (const dir of ['sessions', 'graded']) {
    for (const name of jsonFiles(join(roundDir, dir))) {
      terms.push(...participantTerms(JSON.parse(readFileSync(join(roundDir, dir, name), 'utf8')).participant));
    }
  }
  return { explore: graded.filter((x) => x.g.session?.type === 'explore'), scrub: makeScrubber(terms) };
}

/**
 * @param {any} f finding
 * @param {(t: any) => string} scrub
 */
const blindFinding = (f, scrub) => Object.fromEntries(FIELDS.map((k) => [k, scrub(f[k])]));

/**
 * Writes review/pending.json: every open (none) finding without a decision yet, blinded and shuffled.
 * @param {{ round: string, resultsRoot?: string, secretDir?: string|null }} opts
 * @param {object} [deps]
 * @returns {Promise<string>} path
 */
export async function pendingReview({ round, resultsRoot = RESULTS_ROOT, secretDir = null }, deps = {}) {
  const roundDir = join(resultsRoot, round);
  const catalog = await catalogFor({ secretDir }, /** @type {any} */ (deps));
  const decisions = readDecisions(roundDir);
  const { explore, scrub } = loadRound(roundDir);
  const items = [];
  for (const { g } of explore) {
    for (const c of classifyFindings({ result: g, catalog, grading: g.grading, decisions })) {
      if (c.kind !== 'open' || decisions[c.key]) continue;
      const b = blindFinding(c.finding, scrub);
      items.push({ finding_key: c.key, seed: g.session.seed, where: b.where, viewport: c.finding.viewport, title: b.title,
        steps: b.steps, expected: b.expected, actual: b.actual });
    }
  }
  const out = join(roundDir, 'review', 'pending.json');
  mkdirSync(join(roundDir, 'review'), { recursive: true });
  writeFileSync(out, `${JSON.stringify(shuffle(items, prng(round)), null, 2)}\n`);
  return out;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Reads review/decisions.json, maps keys to sessions, adds new bugs to unplanned.json and regrades the round
 * with a fresh grader call (recall).
 * @param {{ round: string, resultsRoot?: string, secretDir?: string|null }} opts
 * @param {object} [deps] gradeRound deps; unplannedFile overrides catalog/unplanned.json
 * @returns {Promise<string[]>} regraded paths
 */
export async function applyReview({ round, resultsRoot = RESULTS_ROOT, secretDir = null }, deps = {}) {
  const d = /** @type {any} */ (deps);
  const roundDir = join(resultsRoot, round);
  const decisions = readDecisions(roundDir);
  const catalog = await catalogFor({ secretDir }, { ...d, catalog: undefined });
  const { explore } = loadRound(roundDir);
  /** @type {Map<string, { seed: number, ids: Set<string> }>} */
  const keys = new Map();
  /** @type {Set<string>} */
  const stale = new Set();
  for (const { g } of explore) {
    const { active, unplanned, changeId } = sessionBugsOf(g, catalog);
    const ids = new Set([...active, ...unplanned, ...(changeId ? [changeId] : [])]);
    for (const c of classifyFindings({ result: g, catalog, grading: g.grading, decisions: {} })) keys.set(c.key, { seed: g.session.seed, ids });
    for (const k of staleDecisionKeys(g, decisions)) stale.add(k);
  }

  const taken = new Set([...catalog.bugs.map((b) => b.id), ...catalog.decoys.map((x) => x.id)]);
  const unplannedFile = d.unplannedFile ?? DEFAULT_UNPLANNED;
  /** @type {Map<string, any>} */
  const unplanned = new Map(readJson(unplannedFile, []).map((u) => [u.id, u]));
  const problems = [];
  const warn = d.log ?? ((l) => process.stderr.write(`${l}\n`));
  for (const [key, dec] of Object.entries(decisions)) {
    const where = keys.get(key);
    if (!where && stale.has(key)) { warn(`review apply: decision ${key} is stale (the finding changed since); skipped`); continue; }
    if (!where) { problems.push(`${key}: no finding of round ${round} has this key`); continue; }
    if (dec?.verdict === 'false-alarm') continue;
    if (dec?.verdict === 'bug') {
      if (typeof dec.id !== 'string' || !where.ids.has(dec.id)) problems.push(`${key}: id ${JSON.stringify(dec.id)} is not a bug of this session (use new-bug for bugs that are not in the catalog)`);
      continue;
    }
    if (dec?.verdict !== 'new-bug') { problems.push(`${key}: verdict must be false-alarm, bug or new-bug`); continue; }
    if (typeof dec.id !== 'string' || !/^[A-Z]\d{2}$/.test(dec.id)) { problems.push(`${key}: id must look like N01`); continue; }
    if (taken.has(dec.id)) { problems.push(`${key}: id ${dec.id} is already a catalog bug or decoy`); continue; }
    if (!nonEmpty(dec.title) || !nonEmpty(dec.grader)) { problems.push(`${key}: title and grader must not be empty`); continue; }
    if (!STATIONS.includes(dec.station)) { problems.push(`${key}: unknown station ${JSON.stringify(dec.station)}`); continue; }
    const seeds = dec.seeds;
    if (seeds !== undefined && (!Array.isArray(seeds) || !seeds.length || !seeds.every(Number.isInteger))) { problems.push(`${key}: seeds must be a list of seeds`); continue; }
    if (seeds && !seeds.includes(where.seed)) { problems.push(`${key}: seeds ${JSON.stringify(seeds)} leave out the seed of this finding (${where.seed})`); continue; }
    const prev = unplanned.get(dec.id);
    if (!prev) {
      unplanned.set(dec.id, { id: dec.id, title: dec.title, grader: dec.grader, station: dec.station, ...(seeds ? { seeds: [...seeds].sort((a, b) => a - b) } : {}) });
    } else if (prev.seeds && seeds) {
      prev.seeds = [...new Set([...prev.seeds, ...seeds])].sort((a, b) => a - b);
    } else if (prev.seeds && !seeds) {
      delete prev.seeds;
    }
  }
  if (problems.length) throw new Error(`review apply: decisions.json has problems:\n${problems.join('\n')}`);
  writeFileSync(unplannedFile, `${JSON.stringify([...unplanned.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), null, 2)}\n`);
  return gradeRound({ round, resultsRoot, recall: true, secretDir }, { ...d, catalog: undefined });
}

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();

/**
 * Writes review/sample.md: n random grader answers: matches (bug, decoy or change target; low confidence first) plus a quarter of "none" answers,
 * blinded like pending.json, each with the finding and the catalog entry it was matched to.
 * @param {{ round: string, resultsRoot?: string, n?: number, secretDir?: string|null }} opts
 * @param {object} [deps]
 * @returns {Promise<string>} path
 */
export async function sampleReview({ round, resultsRoot = RESULTS_ROOT, n = 20, secretDir = null }, deps = {}) {
  const roundDir = join(resultsRoot, round);
  const catalog = await catalogFor({ secretDir }, /** @type {any} */ (deps));
  const decisions = readDecisions(roundDir);
  const { explore, scrub } = loadRound(roundDir);
  const pool = [];
  const nonePool = [];
  for (const { g } of explore) {
    for (const c of classifyFindings({ result: g, catalog, grading: g.grading, decisions })) {
      if (c.target && c.target === c.match) pool.push({ c, seed: g.session.seed });
      else if (c.kind === 'open' && c.match === 'none') nonePool.push({ c, seed: g.session.seed });
    }
  }
  const r = prng(`${round}:sample`);
  // a quarter of the sample (rounded up) checks the grader's "none" answers: a missed hit is as wrong as a false one
  const noneN = Math.min(nonePool.length, Math.ceil(n / 4));
  const chosenNone = shuffle(nonePool, r).slice(0, noneN);
  const chosenMatch = ['low', 'medium', 'high'].flatMap((conf) => shuffle(pool.filter((x) => x.c.confidence === conf), r)).slice(0, n - noneN);
  const chosen = [...chosenMatch, ...chosenNone];

  const bugs = new Map(catalog.bugs.map((b) => [b.id, b]));
  const unplanned = new Map((catalog.unplanned ?? []).map((u) => [u.id, u]));
  const decoys = new Map(catalog.decoys.map((x) => [x.id, x]));
  const lines = [`# Grader sample, round ${round}`, '',
    `${chosen.length} matches. For each key, write "agree" or "disagree" into review/sample-verdicts.json, e.g. { "<key>": "agree" }.`, ''];
  for (const { c, seed } of chosen) {
    const f = blindFinding(c.finding, scrub);
    /** @type {any} */
    const entry = bugs.get(c.target) ?? unplanned.get(c.target) ?? decoys.get(c.target);
    const kind = c.kind === 'change' ? 'change target' : decoys.has(c.target) ? 'decoy' : unplanned.has(c.target) ? 'unplanned bug' : 'bug';
    lines.push(`## ${c.key}`, '', `**Finding** (seed ${seed}, viewport ${c.finding.viewport})`, '');
    for (const k of FIELDS) lines.push(`- ${k}: ${oneLine(f[k])}`);
    if (!c.target) {
      lines.push('', `**Matched to** none (confidence ${c.confidence}); if it is a known catalog bug, decide { "verdict": "bug", "id": "<id>" } in review/decisions.json`, '');
      continue;
    }
    lines.push('', `**Matched to** ${c.target} (${kind}, confidence ${c.confidence})`, '');
    lines.push(`- title: ${oneLine(entry?.title)}`);
    if (entry?.symptom) lines.push(`- symptom: ${oneLine(entry.symptom)}`);
    lines.push(`- grader: ${oneLine(entry?.grader)}`, '');
  }
  const out = join(roundDir, 'review', 'sample.md');
  mkdirSync(join(roundDir, 'review'), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  return out;
}

/**
 * Reads review/sample-verdicts.json ({ key: 'agree'|'disagree' }) and prints the agreement.
 * @param {{ round: string, resultsRoot?: string }} opts
 * @param {{ log?: (l: string) => void }} [deps]
 * @returns {Promise<{ agree: number, disagree: number, n: number, rate: number|null, invalid: string[], disagreed: string[] }>}
 */
export async function agreementReview({ round, resultsRoot = RESULTS_ROOT }, deps = {}) {
  const log = deps.log ?? ((l) => process.stdout.write(`${l}\n`));
  const file = join(resultsRoot, round, 'review', 'sample-verdicts.json');
  if (!existsSync(file)) throw new Error(`review agreement: ${file} is missing`);
  const verdicts = JSON.parse(readFileSync(file, 'utf8'));
  const invalid = [];
  const disagreed = [];
  let agree = 0;
  for (const [key, v] of Object.entries(verdicts)) {
    if (v === 'agree') agree++;
    else if (v === 'disagree') disagreed.push(key);
    else invalid.push(key);
  }
  const n = agree + disagreed.length;
  const rate = n ? agree / n : null;
  log(`Agreement: ${agree}/${n}${rate === null ? '' : ` (${(rate * 100).toFixed(1)} %)`}`);
  if (disagreed.length) log(`Disagree: ${disagreed.join(', ')}`);
  if (invalid.length) log(`Ignored (neither agree nor disagree): ${invalid.join(', ')}`);
  return { agree, disagree: disagreed.length, n, rate, invalid, disagreed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = /** @type {any} */ (args._)[0];
  if (typeof args.round !== 'string' || !['pending', 'apply', 'sample', 'agreement'].includes(cmd)) {
    process.stderr.write('usage: node harness/review.mjs pending|apply|sample|agreement --round <r> [--n 20] [--results <dir>] [--secret-dir <dir>]\n');
    process.exit(2);
  }
  const opts = {
    round: args.round,
    resultsRoot: typeof args.results === 'string' ? resolve(args.results) : RESULTS_ROOT,
    secretDir: typeof args['secret-dir'] === 'string' ? resolve(args['secret-dir']) : null,
  };
  if (cmd === 'pending') process.stdout.write(`${await pendingReview(opts)}\n`);
  else if (cmd === 'apply') await applyReview(opts);
  else if (cmd === 'sample') process.stdout.write(`${await sampleReview({ ...opts, n: typeof args.n === 'string' ? Number(args.n) : 20 })}\n`);
  else await agreementReview(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
