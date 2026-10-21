// Ergebnistafel: aggregiert bewertete Sitzungen (results/<r>/graded/*.json) je Teilnehmer.
// Keine Hervorhebung eines Siegers. CLI: node harness/score.mjs --round <r> [--results <dir>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RESULTS_ROOT, parseArgs, sessionFileOf } from './grade.mjs';

/**
 * @param {any[]} values nur endliche Zahlen zaehlen
 * @returns {{ median: number|null, min: number|null, max: number|null, n: number }}
 */
export function medianRange(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { median: null, min: null, max: null, n: 0 };
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { median, min: v[0], max: v[v.length - 1], n: v.length };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const costOf = (l) => (Array.isArray(l) ? (l.length ? sum(l.filter((x) => Number.isFinite(x))) : null) : Number.isFinite(l) ? l : null);

/** @param {Record<string,{active:number,hits:number}>[]} maps */
function pool(maps) {
  /** @type {Record<string,{active:number,hits:number}>} */
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m ?? {})) {
    out[k] ??= { active: 0, hits: 0 };
    out[k].active += v.active;
    out[k].hits += v.hits;
  }
  return out;
}

/** @param {any[]} graded */
function checkModels(graded) {
  /** @type {Map<string,string[]>} */
  const byModel = new Map();
  for (const r of graded) {
    if (r.participant?.kind === 'human') continue;
    const m = r.model ?? 'unknown';
    byModel.set(m, [...(byModel.get(m) ?? []), sessionFileOf(r)]);
  }
  if (byModel.size > 1) {
    const lines = [...byModel].map(([m, files]) => `${m}: ${files.join(', ')}`);
    throw new Error(`score: more than one exact model id among agent sessions (round not comparable):\n${lines.join('\n')}`);
  }
  return [...byModel.keys()];
}

/**
 * @param {any[]} sessions explore sessions of one group
 */
function groupStats(sessions) {
  const m = sessions.map((r) => r.metrics);
  const withChange = m.filter((x) => x.change);
  const traps = m.map((x) => x.traps).filter(Boolean);
  const logins = m.map((x) => x.login).filter(Boolean);
  return {
    sessions: sessions.length,
    change: { correct: withChange.filter((x) => x.change.correct === true).length, n: withChange.length, false_works: withChange.filter((x) => x.change.false_works).length },
    hit_rate: medianRange(m.map((x) => x.bugs?.hit_rate)),
    by_category: pool(m.map((x) => x.bugs?.by_category)),
    by_width: pool(m.map((x) => x.bugs?.by_width)),
    false_alarms: medianRange(m.map((x) => x.false_alarms?.total)),
    duplicates: medianRange(m.map((x) => x.duplicates)),
    silent_bypass: (() => {
      const silently = sum(traps.map((t) => t.silently_bypassed));
      const reached = sum(traps.map((t) => t.reached));
      return { silently_bypassed: silently, reached, share: reached ? silently / reached : null };
    })(),
    login: { success: logins.filter((l) => l.success).length, n: logins.length },
    logins: medianRange(logins.map((l) => l.logins)),
    unreviewed: sum(m.map((x) => x.false_alarms?.unreviewed ?? 0)),
  };
}

/**
 * @param {any[]} gradedResults
 */
export function aggregate(gradedResults) {
  const models = checkModels(gradedResults);
  const agents = gradedResults.filter((r) => r.participant?.kind !== 'human');
  const humans = gradedResults.filter((r) => r.participant?.kind === 'human');

  /** Menschen-Treffer je Seed (Vereinigung ueber alle Menschen-Sitzungen des Seeds). */
  /** @type {Map<number,Set<string>>} */
  const humanBySeed = new Map();
  for (const h of humans) {
    const set = humanBySeed.get(h.session.seed) ?? new Set();
    for (const id of h.metrics?.hit_ids ?? []) set.add(id);
    humanBySeed.set(h.session.seed, set);
  }

  /** @type {Record<string, any>} */
  const participants = {};
  for (const slug of [...new Set(agents.map((r) => r.participant.slug))].sort()) {
    const mine = agents.filter((r) => r.participant.slug === slug);
    const explore = mine.filter((r) => r.session.type === 'explore');
    const captures = mine.filter((r) => r.session.type === 'capture');
    const caps = captures.map((r) => r.metrics?.capture).filter(Boolean);
    const costs = mine.map((r) => r.metrics?.cost).filter(Boolean);
    const ratios = [];
    const overlaps = [];
    for (const r of explore) {
      const hum = humanBySeed.get(r.session.seed);
      if (!hum || !hum.size) continue;
      const mineHits = new Set(r.metrics?.hit_ids ?? []);
      ratios.push(mineHits.size / hum.size);
      overlaps.push([...mineHits].filter((id) => hum.has(id)).length / hum.size);
    }
    participants[slug] = {
      display: mine[0].participant.display ?? slug,
      ...groupStats(explore),
      capture: { valid: caps.filter((c) => c.valid).length, n: caps.length },
      tokens: medianRange(costs.map((c) => c.tokens)),
      calls: medianRange(costs.map((c) => c.calls)),
      wall_s: medianRange(costs.map((c) => c.wall_s)),
      cost_usd: medianRange(costs.map((c) => costOf(c.cost_usd_list))),
      integrity: {
        read_bug_script: mine.filter((r) => r.harness?.integrity?.read_bug_script).length,
        capture_outside_access: mine.filter((r) => r.harness?.integrity?.capture_outside_access).length,
      },
      human_ratio: medianRange(ratios).median,
      human_overlap: medianRange(overlaps).median,
    };
  }

  const humanRow = humans.length ? (() => {
    const s = groupStats(humans);
    return { sessions: s.sessions, hit_rate: s.hit_rate, by_category: s.by_category, by_width: s.by_width, false_alarms: s.false_alarms, duplicates: s.duplicates, unreviewed: s.unreviewed };
  })() : null;

  return {
    models,
    participants,
    humans: humanRow,
    unreviewed: sum(Object.values(participants).map((p) => p.unreviewed)) + (humanRow?.unreviewed ?? 0),
  };
}

// ---------- Markdown ----------

const fmt = (x, d = 2) => (x === null || x === undefined ? '—' : Number.isInteger(x) ? String(x) : x.toFixed(d));
const mr = (r, d = 2) => (r.n ? `${fmt(r.median, d)} (${fmt(r.min, d)}–${fmt(r.max, d)}, n=${r.n})` : '—');
const xn = (o, k) => (o.n ? `${o[k]}/${o.n}` : '—');
const pct = (b) => (b.active ? `${b.hits}/${b.active}` : '—');

/**
 * @param {ReturnType<typeof aggregate>} sb
 * @returns {string}
 */
export function renderScoreboard(sb) {
  const slugs = Object.keys(sb.participants).sort();
  const P = (slug) => sb.participants[slug];
  const out = [];
  out.push('# Scoreboard', '');
  out.push(`Agent model (exact id): ${sb.models.length ? sb.models.join(', ') : '—'}. Participants in alphabetical order; no ranking.`, '');
  out.push(`Unreviewed findings (open until decided): ${sb.unreviewed}.`, '');

  const row = (label, cells) => `| ${label} | ${cells.join(' | ')} |`;
  const header = (first, cols) => [`| ${first} | ${cols.join(' | ')} |`, `|${Array(cols.length + 1).fill('---').join('|')}|`];

  out.push('## Explore', '');
  out.push(...header('Participant', ['Sessions', 'Change verdicts right', 'False "works"', 'Hit rate', 'False alarms', 'Duplicates', 'Silent bypass', 'Login ok', 'Logins', 'Unreviewed']));
  for (const s of slugs) {
    const p = P(s);
    out.push(row(p.display, [p.sessions, xn(p.change, 'correct'), p.change.false_works, mr(p.hit_rate), mr(p.false_alarms), mr(p.duplicates),
      p.silent_bypass.reached ? `${p.silent_bypass.silently_bypassed}/${p.silent_bypass.reached}` : '—', xn(p.login, 'success'), mr(p.logins), p.unreviewed]));
  }
  if (sb.humans) {
    const h = sb.humans;
    out.push(row('Human testers', [h.sessions, '—', '—', mr(h.hit_rate), mr(h.false_alarms), mr(h.duplicates), '—', '—', '—', h.unreviewed]));
  }
  out.push('');

  out.push('## Capture and integrity', '');
  out.push(...header('Participant', ['Capture valid', 'Sessions that read the bug script', 'Capture outside access']));
  for (const s of slugs) out.push(row(P(s).display, [xn(P(s).capture, 'valid'), P(s).integrity.read_bug_script, P(s).integrity.capture_outside_access]));
  out.push('');

  out.push('## Cost (agents; median, range)', '');
  out.push(...header('Participant', ['Tokens', 'Calls', 'Wall clock (s)', 'List price (USD)']));
  for (const s of slugs) out.push(row(P(s).display, [mr(P(s).tokens, 0), mr(P(s).calls, 0), mr(P(s).wall_s, 0), mr(P(s).cost_usd)]));
  if (sb.humans) out.push(row('Human testers', ['—', '—', '—', '—']));
  out.push('');

  const keys = (sel) => [...new Set(slugs.flatMap((s) => Object.keys(P(s)[sel])).concat(Object.keys(sb.humans?.[sel] ?? {})))].sort();
  for (const [title, sel] of [['Hits by category (hits/active, summed over sessions)', 'by_category'], ['Hits by width (hits/active, summed over sessions)', 'by_width']]) {
    const cols = keys(sel);
    if (!cols.length) continue;
    out.push(`## ${title}`, '');
    out.push(...header('Participant', cols));
    for (const s of slugs) out.push(row(P(s).display, cols.map((c) => pct(P(s)[sel][c] ?? { active: 0, hits: 0 }))));
    if (sb.humans) out.push(row('Human testers', cols.map((c) => pct(sb.humans[sel][c] ?? { active: 0, hits: 0 }))));
    out.push('');
  }

  if (sb.humans) {
    out.push('## Agents against human testers (seeds with a human run)', '');
    out.push(...header('Participant', ['Hits agent / hits human (median)', 'Share of human hits also found (median)']));
    for (const s of slugs) out.push(row(P(s).display, [fmt(P(s).human_ratio), fmt(P(s).human_overlap)]));
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

// ---------- CLI ----------

/**
 * @param {{ round: string, resultsRoot?: string }} o
 */
export function readGraded({ round, resultsRoot = RESULTS_ROOT }) {
  const dir = join(resultsRoot, round, 'graded');
  if (!existsSync(dir)) throw new Error(`score: no graded folder ${dir} (run node harness/grade.mjs first)`);
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
}

/**
 * @param {{ round: string, resultsRoot?: string }} o
 */
export function writeScoreboard({ round, resultsRoot = RESULTS_ROOT }) {
  const sb = aggregate(readGraded({ round, resultsRoot }));
  const dir = join(resultsRoot, round);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scoreboard.json'), `${JSON.stringify(sb, null, 2)}\n`);
  writeFileSync(join(dir, 'scoreboard.md'), renderScoreboard(sb));
  return sb;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.round !== 'string') {
    process.stderr.write('usage: node harness/score.mjs --round <r> [--results <dir>]\n');
    process.exit(2);
  }
  writeScoreboard({ round: args.round, resultsRoot: typeof args.results === 'string' ? resolve(args.results) : RESULTS_ROOT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (err) { process.stderr.write(`${err.message}\n`); process.exit(1); }
}
