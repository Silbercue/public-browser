// Runden: Plan, Lauf (nacheinander, mit Fingerabdruck und Modell-Pruefung) und Token-Bericht.
// CLI: node harness/round.mjs run --round <r> [--probe] [--participants a,b] [--types explore,capture] [--resume] [--secret-dir <dir>]
//        [--overwrite-fingerprint] (ohne --resume trotz vorhandener fingerprint.json) [--accept-drift] (bei --resume trotz Abweichung)
//      node harness/round.mjs report --round <r>
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CP_ROOT, RESULTS_ROOT, parseArgs } from './grade.mjs';
import { fingerprint as computeFingerprint, compareFingerprints } from './fingerprint.mjs';
import { CP_PARTICIPANTS } from './participants.mjs';
import { sessionFileName } from './result-schema.mjs';
import { loadSeeds } from './seed.mjs';

const SEEDS_PER_ROUND = 5;
const EXPLORE_PER_ROUND = 20;

/**
 * Seed fuer Seed; innerhalb eines Seeds die Teilnehmer je Seed um eine Stelle rotiert, Typen in der gegebenen Reihenfolge.
 * @param {{ seeds: number[], participants: string[], types: string[] }} p
 * @returns {{ slug: string, type: string, seed: number }[]}
 */
export function planRound({ seeds, participants, types }) {
  const plan = [];
  seeds.forEach((seed, i) => {
    const n = participants.length;
    const rotated = participants.map((_, j) => participants[(j + i) % n]);
    for (const type of types) for (const slug of rotated) plan.push({ slug, type, seed });
  });
  return plan;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Exakte Modell-ID der ersten Agenten-Sitzung, die schon in sessions/ liegt (bei --resume). */
function existingModel(sessionsDir) {
  if (!existsSync(sessionsDir)) return null;
  for (const name of readdirSync(sessionsDir).filter((n) => n.endsWith('.json')).sort()) {
    const r = readJson(join(sessionsDir, name));
    if (r.participant?.kind !== 'human' && typeof r.model === 'string' && r.model) return r.model;
  }
  return null;
}

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: CP_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * @param {{ round: string, probe?: boolean, resume?: boolean, participants?: string[], types?: string[], seeds?: number[],
 *   secretDir?: string|null, resultsRoot?: string, overwriteFingerprint?: boolean, acceptDrift?: boolean }} opts
 * @param {{ runSession?: Function, sessionDeps?: any, fingerprint?: () => any, commit?: () => string|null, now?: () => string,
 *   log?: (l: string) => void, stderr?: (l: string) => void }} [deps]
 */
export async function runRound(opts, deps = {}) {
  const { round, probe = false, resume = false, secretDir = null, resultsRoot = RESULTS_ROOT, overwriteFingerprint = false, acceptDrift = false } = opts;
  const log = deps.log ?? ((l) => process.stdout.write(`${l}\n`));
  const warn = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const allSeeds = opts.seeds ?? loadSeeds();
  const seeds = probe ? allSeeds.slice(0, 1) : allSeeds;
  const plan = planRound({ seeds, participants: opts.participants ?? Object.keys(CP_PARTICIPANTS), types: opts.types ?? ['explore', 'capture'] });

  const roundDir = join(resultsRoot, round);
  const sessionsDir = join(roundDir, 'sessions');
  const fp = (deps.fingerprint ?? computeFingerprint)();
  const fpFile = join(roundDir, 'fingerprint.json');
  const fpExists = existsSync(fpFile);
  if (fpExists && !resume && !overwriteFingerprint) {
    throw new Error(`round: ${fpFile} already exists (the measurement setup fixed for this round); use --resume to continue the round, or --overwrite-fingerprint to replace it on purpose`);
  }
  if (resume && fpExists) {
    const { fields } = compareFingerprints(readJson(fpFile), fp);
    const changed = Object.entries(fields).filter(([, v]) => v === 'changed').map(([k]) => k);
    if (changed.length) {
      const msg = `round: fingerprint differs from the one written at the start of this round: ${changed.join(', ')}`;
      if (!acceptDrift) throw new Error(`${msg}; aborted (use --accept-drift if the change is intended)`);
      warn(msg);
    }
  } else {
    mkdirSync(roundDir, { recursive: true });
    writeFileSync(fpFile, `${JSON.stringify({ ...fp, commit: (deps.commit ?? gitHead)(), time: (deps.now ?? (() => new Date().toISOString()))() }, null, 2)}\n`);
  }

  const runSession = deps.runSession ?? (await import(/** @type {string} */ ('./run-session.mjs'))).runSession;
  let baseline = resume ? existingModel(sessionsDir) : null;
  const out = { planned: plan.length, ran: 0, skipped: 0, aborted: /** @type {{slug:string,type:string,seed:number}[]} */ ([]), stopped: /** @type {any} */ (null) };

  for (const item of plan) {
    if (resume && existsSync(join(sessionsDir, sessionFileName(item)))) { out.skipped++; continue; }
    log(`round ${round}: ${item.slug} ${item.type} seed ${item.seed}`);
    const { result } = await runSession({ ...item, round, secretDir, replace: false }, deps.sessionDeps ?? {});
    out.ran++;
    if (result.status === 'aborted') { out.aborted.push(item); continue; }
    if (baseline === null) baseline = result.model;
    else if (result.model !== baseline) {
      out.stopped = { ...item, first: baseline, other: result.model };
      warn(`round: model id changed from ${baseline} to ${result.model} at ${item.slug} ${item.type} seed ${item.seed}; round stopped (rerun the round, or the affected sessions with --replace)`);
      break;
    }
  }
  if (out.aborted.length) log(`round ${round}: aborted sessions: ${out.aborted.map((a) => `${a.slug}/${a.type}/seed${a.seed}`).join(', ')}`);
  return out;
}

// ---------- Token-Bericht ----------

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const costOf = (l) => (Array.isArray(l) ? (l.length ? l.reduce((a, b) => a + (num(b) ?? 0), 0) : null) : num(l));
const mean = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const total = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const int = (x) => (x === null ? '—' : String(Math.round(x)));
const usd = (x) => (x === null ? '—' : x.toFixed(2));
const hours = (s) => (s === null ? '—' : (s / 3600).toFixed(1));

function readJsonOr(file, fallback) {
  return existsSync(file) ? readJson(file) : fallback;
}

function readDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => readJson(join(dir, n)));
}

/**
 * @param {{ round: string, resultsRoot?: string }} o
 * @returns {string} Markdown
 */
export function buildTokenReport({ round, resultsRoot = RESULTS_ROOT }) {
  const roundDir = join(resultsRoot, round);
  const sessions = readDir(join(roundDir, 'sessions'));
  const rows = sessions.map((r) => {
    const human = r.participant?.kind === 'human';
    return {
      slug: r.participant.slug, type: r.session.type, seed: r.session.seed, status: r.status, human,
      tokens: human ? null : num(r.tokens?.delta), rounds: human ? null : num(r.tokens?.rounds),
      cost: human ? null : costOf(r.cost_usd_list), wall: human ? null : num(r.harness?.wall_clock_s), turns: human ? null : num(r.harness?.num_turns),
    };
  }).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.type < b.type ? -1 : a.type > b.type ? 1 : a.seed - b.seed));

  const out = [`# Token report, round ${round}`, ''];
  out.push('## Sessions', '', '| Participant | Type | Seed | Status | Tokens (delta) | Rounds | Cost (USD list) | Wall clock (s) | Turns |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) out.push(`| ${r.slug} | ${r.type} | ${r.seed} | ${r.status} | ${int(r.tokens)} | ${int(r.rounds)} | ${usd(r.cost)} | ${int(r.wall)} | ${int(r.turns)} |`);
  out.push('', 'Human sessions carry no cost data and are left out of all sums and projections.', '');

  const agents = rows.filter((r) => !r.human);
  out.push('## Totals', '', '| | Tokens | Rounds | Cost (USD list) | Hours |', '|---|---|---|---|---|');
  out.push(`| Sum | ${int(total(agents.map((r) => r.tokens)))} | ${int(total(agents.map((r) => r.rounds)))} | ${usd(total(agents.map((r) => r.cost)))} | ${hours(total(agents.map((r) => r.wall)))} |`, '');

  const groups = new Map();
  for (const r of agents) groups.set(`${r.slug}\0${r.type}`, [...(groups.get(`${r.slug}\0${r.type}`) ?? []), r]);
  out.push('## Projection', '', `Mean per (participant, type) times ${SEEDS_PER_ROUND} seeds.`, '', '| Participant | Type | Sessions | Tokens | Cost (USD list) | Hours |', '|---|---|---|---|---|---|');
  let pt = 0; let pc = 0; let pw = 0;
  for (const [key, g] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [slug, type] = key.split('\0');
    const t = mean(g.map((r) => r.tokens)); const c = mean(g.map((r) => r.cost)); const w = mean(g.map((r) => r.wall));
    pt += (t ?? 0) * SEEDS_PER_ROUND; pc += (c ?? 0) * SEEDS_PER_ROUND; pw += (w ?? 0) * SEEDS_PER_ROUND;
    out.push(`| ${slug} | ${type} | ${g.length} | ${int(t === null ? null : t * SEEDS_PER_ROUND)} | ${usd(c === null ? null : c * SEEDS_PER_ROUND)} | ${hours(w === null ? null : w * SEEDS_PER_ROUND)} |`);
  }
  out.push(`| Total (${agents.length} sessions) | | ${agents.length} | ${int(pt)} | ${usd(pc)} | ${hours(pw)} |`, '');

  // Pruefer: echter Verbrauch (Ruling K9). grading.usage ist die kumulative Summe aller Pruefer-Aufrufe einer Sitzung,
  // auch bei "n/a ..."-Eintraegen, die frueheren Verbrauch erhalten; fehlgeschlagene Aufrufe liegen in grading-spent.json.
  const tokOf = (u) => (num(u?.input_tokens) ?? 0) + (num(u?.output_tokens) ?? 0);
  const spentUsage = Object.values(readJsonOr(join(roundDir, 'grading-spent.json'), {}));
  const graded = readDir(join(roundDir, 'graded')).filter((r) => r.grading?.usage && (tokOf(r.grading.usage) > 0 || (num(r.grading.usage.cost_usd) ?? 0) > 0 || !String(r.grading.model ?? '').startsWith('n/a')));
  if (graded.length || spentUsage.length) {
    const gt = total(graded.map((r) => tokOf(r.grading.usage))); const gc = total(graded.map((r) => num(r.grading.usage.cost_usd) ?? 0));
    const st = total(spentUsage.map(tokOf)); const sc = total(spentUsage.map((u) => num(u?.cost_usd) ?? 0));
    out.push('## Grader', '', `Graded sessions: ${graded.length}`, '', '| | Tokens | Cost (USD) |', '|---|---|---|');
    out.push(`| Sum, graded sessions | ${int(gt)} | ${usd(gc)} |`, `| Failed grader calls (not yet graded sessions) | ${int(st)} | ${usd(sc)} |`, `| Sum, grader | ${int(gt + st)} | ${usd(gc + sc)} |`);
    if (graded.length) {
      out.push(`| Mean per graded session | ${int(gt / graded.length)} | ${usd(gc / graded.length)} |`,
        `| Projection, ${EXPLORE_PER_ROUND} explore sessions | ${int((gt / graded.length) * EXPLORE_PER_ROUND)} | ${usd((gc / graded.length) * EXPLORE_PER_ROUND)} |`);
    }
    out.push(`| Sum, agents + grader | ${int(total(agents.map((r) => r.tokens)) + gt + st)} | ${usd(total(agents.map((r) => r.cost)) + gc + sc)} |`, '');
  }
  return `${out.join('\n')}\n`;
}

/**
 * @param {{ round: string, resultsRoot?: string }} o
 * @returns {string} path written
 */
export function writeTokenReport({ round, resultsRoot = RESULTS_ROOT }) {
  const file = join(resultsRoot, round, 'token-report.md');
  mkdirSync(join(resultsRoot, round), { recursive: true });
  writeFileSync(file, buildTokenReport({ round, resultsRoot }));
  return file;
}

// ---------- CLI ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = /** @type {any} */ (args._)[0];
  const resultsRoot = typeof args.results === 'string' ? resolve(args.results) : RESULTS_ROOT;
  if (typeof args.round !== 'string' || !['run', 'report'].includes(cmd)) {
    process.stderr.write('usage: node harness/round.mjs run --round <r> [--probe] [--participants a,b] [--types explore,capture] [--resume] [--secret-dir <dir>]\n       node harness/round.mjs report --round <r>\n');
    process.exit(2);
  }
  if (cmd === 'report') {
    process.stdout.write(`${writeTokenReport({ round: args.round, resultsRoot })}\n`);
    return;
  }
  const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const out = await runRound({
    round: args.round, probe: args.probe === true, resume: args.resume === true, resultsRoot,
    overwriteFingerprint: args['overwrite-fingerprint'] === true, acceptDrift: args['accept-drift'] === true,
    participants: list(args.participants), types: list(args.types),
    secretDir: typeof args['secret-dir'] === 'string' ? resolve(args['secret-dir']) : null,
  });
  if (out.stopped) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
