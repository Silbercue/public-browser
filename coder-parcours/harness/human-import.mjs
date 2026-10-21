// Turns human report lines (reports.jsonl or the admin export, same format) into one session file per
// tester and seed: results/<round>/sessions/human-<nn>-explore-seed<seed>.json. Testers appear under a
// pseudonym (human-01, human-02, ...); the mapping name -> pseudonym stays local (results/<round>/human-tester-map.json,
// gitignored), so no name reaches the published result files.
// CLI: node harness/human-import.mjs --reports <file> --round <r> [--results <dir>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCatalog } from '../catalog/load.mjs';
import { widthClassForPx } from '../catalog/schema.mjs';
import { buildRunConfig, loadSeeds, runConfigSha } from './seed.mjs';
import { normalizeTester } from './report-schema.mjs';
import { SESSION_SCHEMA, sessionFileName, validateSessionResult } from './result-schema.mjs';
import { CP_ROOT, RESULTS_ROOT, parseArgs } from './grade.mjs';

const REPO_ROOT = resolve(CP_ROOT, '..');
/** Paths that make up the catalog state; a change since the hosted commit means a different run config. */
const CATALOG_PATHS = ['coder-parcours/bugs', 'coder-parcours/catalog', 'coder-parcours/harness/seed.mjs', 'coder-parcours/harness/seeds.json'];
const TITLE_MAX = 80;

/** @param {string[]} args */
async function defaultGit(args) {
  const r = spawnSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1 };
}

/**
 * @param {{ reportsJsonl: string, round: string, resultsRoot?: string }} opts
 * @param {{ resultsRoot?: string, git?: (args: string[]) => Promise<{ code: number }>, loadCatalog?: () => Promise<any>, seeds?: number[], stderr?: (l: string) => void }} [deps]
 * @returns {Promise<string[]>} written session files
 */
export async function importHumanReports({ reportsJsonl, round, resultsRoot }, deps = {}) {
  const root = resultsRoot ?? deps.resultsRoot ?? RESULTS_ROOT;
  const git = deps.git ?? defaultGit;
  const warn = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const knownSeeds = deps.seeds ?? loadSeeds();
  const catalog = await (deps.loadCatalog ?? (() => loadCatalog()))();

  /** @type {Map<string, { tester: string, seed: number, rows: any[] }>} */
  const groups = new Map();
  readFileSync(reportsJsonl, 'utf8').split(/\r?\n/).forEach((line, n) => {
    if (!line.trim()) return;
    let row;
    try { row = JSON.parse(line); } catch { warn(`human-import: line ${n + 1} is not JSON, skipped`); return; }
    if (!Number.isInteger(row?.seed)) { warn(`human-import: line ${n + 1} has no integer seed, skipped`); return; }
    if (!knownSeeds.includes(row.seed)) throw new Error(`human-import: line ${n + 1} has seed ${row.seed}, which is not one of the seeds of this parcours (${knownSeeds.join(', ')}); nothing imported`);
    if (typeof row.text !== 'string' || !row.text.trim()) { warn(`human-import: line ${n + 1} has no text, skipped`); return; }
    const tester = normalizeTester(row.tester);
    const key = `${tester}\0${row.seed}`;
    if (!groups.has(key)) groups.set(key, { tester, seed: row.seed, rows: [] });
    groups.get(key).rows.push(row);
  });

  // Pseudonyms: stable over repeated imports (mapping file), new testers get the next free number in name order.
  const mapFile = join(root, round, 'human-tester-map.json');
  /** @type {Record<string, string>} */
  const aliases = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, 'utf8')) : {};
  const names = [...new Set([...groups.values()].map((g) => g.tester))].sort();
  for (const name of names) {
    if (!aliases[name]) aliases[name] = `${String(Object.keys(aliases).length + 1).padStart(2, '0')}`;
  }
  /** @type {Map<string, number>} */
  const gitCache = new Map();
  const outDir = join(root, round, 'sessions');
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const { tester: realName, seed, rows } of groups.values()) {
    const tester = aliases[realName];
    rows.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')));
    const slug = `human-${tester}`;
    const name = sessionFileName({ slug, type: 'explore', seed });
    const notes = [];
    const commits = [...new Set(rows.map((r) => r.commit).filter((c) => typeof c === 'string' && c))];
    const hosted = commits[0] ?? null;
    if (commits.length > 1) notes.push(`reports carry several commits (${commits.join(', ')}); using ${hosted}`);
    if (!hosted) {
      notes.push('reports carry no commit; the catalog state of the hosted app is unknown, run_config uses the current catalog');
    } else {
      if (!gitCache.has(hosted)) gitCache.set(hosted, (await git(['diff', '--quiet', hosted, 'HEAD', '--', ...CATALOG_PATHS])).code);
      const code = gitCache.get(hosted);
      if (code === 1) notes.push(`catalog changed since hosted commit ${hosted}; run_config uses the current catalog and may differ from what the tester saw`);
      else if (code !== 0) notes.push(`could not compare the catalog with hosted commit ${hosted} (git exit ${code}); run_config uses the current catalog`);
    }
    for (const note of notes) warn(`human-import: ${name}: ${note}`);

    const runConfig = buildRunConfig({ seed, sessionType: 'explore', catalog });
    const findings = rows.map((r) => {
      const text = r.text.trim();
      return {
        title: text.slice(0, TITLE_MAX), where: typeof r.path === 'string' ? r.path : '',
        viewport: typeof r.viewportPx === 'number' && r.viewportPx > 0 ? widthClassForPx(r.viewportPx) : 'all',
        steps: '', expected: '', actual: text, severity: '',
      };
    });
    const result = {
      schema: SESSION_SCHEMA,
      participant: { slug, display: slug, kind: 'human', package: null, version: null },
      session: { type: 'explore', seed, round, run_config: runConfig, run_config_sha256: runConfigSha(runConfig), hosted_commit: hosted },
      status: 'ok',
      report: { ok: true, problems: [], normalized: { change_check: { verdict: null, evidence: '' }, findings } },
      events: [],
      notes,
    };
    const problems = validateSessionResult(result);
    if (problems.length) throw new Error(`human-import: ${name}: ${problems.join('; ')}`);
    const out = join(outDir, name);
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    written.push(out);
  }
  if (Object.keys(aliases).length) {
    mkdirSync(join(root, round), { recursive: true });
    writeFileSync(mapFile, `${JSON.stringify(aliases, null, 2)}\n`);
  }
  return written;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.reports !== 'string' || typeof args.round !== 'string') {
    process.stderr.write('usage: node harness/human-import.mjs --reports <file> --round <r> [--results <dir>]\n');
    process.exit(2);
  }
  const paths = await importHumanReports({
    reportsJsonl: resolve(args.reports), round: args.round,
    resultsRoot: typeof args.results === 'string' ? resolve(args.results) : RESULTS_ROOT,
  });
  for (const p of paths) process.stdout.write(`${p}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
