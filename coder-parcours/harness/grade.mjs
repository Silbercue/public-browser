// Grader: an independent Claude model matches each finding of an explore session to the catalog;
// scoreSession turns those matches (plus Julian's decisions) into the per-session metrics.
// CLI: node harness/grade.mjs --round <r> [--recall] [--results <dir>] [--secret-dir <dir>]
import { createHash } from 'node:crypto';
import { spawn as cpSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_PIN, scrubProviderKeys } from './blind-run-lib.mjs';
import { CP_PARTICIPANTS, resolveClaude } from './participants.mjs';
import { prng } from './seed.mjs';
import { GRADED_SCHEMA, sessionFileName, validateGradedResult } from './result-schema.mjs';
import { loadCatalog } from '../catalog/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** coder-parcours/ */
export const CP_ROOT = resolve(HERE, '..');
export const RESULTS_ROOT = join(CP_ROOT, 'results');
export const GRADER_PROMPT_FILE = join(HERE, 'grader-prompt.md');

export const GRADER_MODEL = 'sonnet';
/** Placeholder for the empty MCP config file; runGrader puts the real temp path in its place. */
const MCP_PLACEHOLDER = '<empty-mcp-config>';
/** Flags that keep the grader free of user/project memory, CLAUDE.md, MCP servers and tools. */
export const GRADER_FLAGS = Object.freeze(['--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', MCP_PLACEHOLDER, '--tools', '']);
const CONFIDENCES = ['high', 'medium', 'low'];
const MAX_DISTRACTORS = 5;
const GRADER_TIMEOUT_MS = 10 * 60_000;

/** @typedef {import('../catalog/load.mjs').Catalog} Catalog */
/** @typedef {{ i: number, match: string, confidence: 'high'|'medium'|'low', reason: string }} Match */
/**
 * @typedef {{ change: { verdict: any, truth: 'works'|'broken', correct: boolean|null, false_works: boolean } | null,
 *  bugs: { active: number, hits: number, hit_rate: number|null, by_category: Record<string,{active:number,hits:number}>, by_width: Record<string,{active:number,hits:number}> } | null,
 *  false_alarms: { decoy: number, decided: number, unreviewed: number, total: number } | null, duplicates: number|null,
 *  traps: { reached: number, reported: number, silently_bypassed: number, stuck: number, not_reached: number } | null,
 *  login: { success: boolean, logins: number, expired_relogin: boolean|null } | null,
 *  capture: { valid: boolean, reason: string|null } | null,
 *  cost: { tokens: any, rounds: any, calls: number|null, wall_s: any, cost_usd_list: any } | null,
 *  hit_ids: string[] }} Metrics
 *  Humans: change, traps, login, capture and cost are null. Capture sessions: only capture and cost.
 */

// ---------- blinding ----------

/**
 * Words that give a participant away beyond its slug/display/package: brand words on their own and tool
 * names without the mcp__ prefix. Kept here (participants.mjs stays untouched); keyed by slug.
 */
const TELLTALE = {
  'public-browser': ['public browser', 'public_browser', 'publicbrowser', 'silbercue', 'cortex', 'virtual_desk', 'view_page', 'run_plan',
    'fill_form', 'capture_image', 'dom_snapshot', 'batch_evaluate', 'set_page_data', 'configure_session', 'network_monitor',
    'tab_status', 'switch_tab', 'press_key', 'handle_dialog', 'file_upload', 'console_logs', 'wait_for'],
  'chrome-devtools-mcp': ['chrome devtools', 'chrome-devtools', 'chromedevtools', 'devtools', 'take_snapshot', 'take_screenshot',
    'evaluate_script', 'list_pages', 'new_page', 'select_page', 'navigate_page', 'list_console_messages', 'list_network_requests',
    'get_console_message', 'get_network_request', 'resize_page', 'performance_start_trace', 'wait_for', 'fill_form', 'press_key', 'handle_dialog'],
  'agent-browser': ['agent browser', 'agent-browser', 'agentbrowser', 'dogfood'],
  'playwright-cli': ['playwright', 'playwright-cli', 'playwright cli', 'pwcli', '@playwright/cli'],
};
/** Reference styles of the tools: `@e3` (CLI snapshots) and `uid=1_4` (DevTools snapshots). */
const REF_PATTERNS = ['(?<![\\w.])@e\\d+(?!\\w)', '(?<![\\w.])uid=\\d+_\\d+(?![\\w])'];

/**
 * Names under which a participant could appear in its own texts.
 * @param {any} p participant
 * @returns {string[]}
 */
export function participantTerms(p) {
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= 2) out.push(v.trim()); };
  if (!p) return out;
  add(p.slug);
  add(p.display);
  add(p.package);
  if (typeof p.display === 'string') {
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(p.display);
    if (m) { add(m[1]); add(m[2]); }
  }
  if (typeof p.package === 'string' && p.package.startsWith('@') && p.package.includes('/')) {
    const bare = p.package.split('/').pop();
    if (bare.length >= 4) add(bare);
  }
  const def = /** @type {any} */ (CP_PARTICIPANTS)[p.slug];
  if (def) { add(def.name); add(def.cli); add(def.package); }
  for (const t of TELLTALE[p.slug] ?? []) add(t);
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces every mcp__ tool name, tool reference (`@e3`, `uid=...`) and every given term (case-insensitive, not
 * inside a longer word) by [tool].
 * @param {string[]} terms
 * @returns {(text: any) => string}
 */
export function makeScrubber(terms) {
  const uniq = [...new Set(terms.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
  const re = uniq.length ? new RegExp(`(?<![a-z0-9])(?:${uniq.map(escapeRe).join('|')})(?![a-z0-9])`, 'gi') : null;
  const refs = new RegExp(REF_PATTERNS.join('|'), 'gi');
  return (text) => {
    let s = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
    s = s.replace(/mcp__[a-z0-9_.-]*/gi, '[tool]').replace(refs, '[tool]');
    return re ? s.replace(re, '[tool]') : s;
  };
}

// ---------- session helpers ----------

const KEY_FIELDS = ['title', 'where', 'viewport', 'steps', 'expected', 'actual'];
const sha12 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Key of a finding: 6 hex characters for its place (session file + index) and 6 for its content, so a decision
 * does not silently move to another finding when a session is replaced or an import is rewritten.
 * @param {string} sessionFile session file name (no folder)
 * @param {number} i finding index
 * @param {any} finding
 * @returns {string} 12 hex characters
 */
export function findingKey(sessionFile, i, finding) {
  const content = JSON.stringify(KEY_FIELDS.map((k) => finding?.[k] ?? ''));
  return sha12(`${sessionFile}:${i}`).slice(0, 6) + sha12(content).slice(0, 6);
}

/**
 * Decision keys that point at a finding's place but not at its content (the finding was replaced).
 * @param {any} result
 * @param {Record<string, any>} decisions
 * @returns {string[]}
 */
export function staleDecisionKeys(result, decisions) {
  const file = sessionFileOf(result);
  const findings = result.report?.normalized?.findings ?? [];
  const current = new Set(findings.map((f, i) => findingKey(file, i, f)));
  const places = new Set(findings.map((_, i) => findingKey(file, i, {}).slice(0, 6)));
  return Object.keys(decisions).filter((k) => !current.has(k) && places.has(k.slice(0, 6)));
}

/** @param {any} result */
export function sessionFileOf(result) {
  return sessionFileName({ slug: result.participant.slug, type: result.session.type, seed: result.session.seed });
}

/**
 * Active bugs of a session (from run_config) plus unplanned bugs that apply to its seed.
 * @param {any} result
 * @param {Catalog} catalog
 */
function sessionBugs(result, catalog) {
  const rc = result.session.run_config;
  const byId = new Map(catalog.bugs.map((b) => [b.id, b]));
  const active = rc.active.map((a) => {
    const bug = byId.get(a.id);
    if (!bug) throw new Error(`grade: active bug ${a.id} is not in the loaded catalog (secret part missing? use --secret-dir)`);
    return { id: a.id, station: a.station, width: a.width, category: bug.category, bug };
  });
  const unplanned = (catalog.unplanned ?? [])
    .filter((u) => !Array.isArray(u.seeds) || u.seeds.includes(rc.seed))
    .map((u) => ({ id: u.id, station: u.station, width: 'all', category: 'unplanned', bug: null, entry: u }));
  return { rc, changeId: rc.change?.bugId ?? null, active, unplanned, byId };
}

/**
 * Ids a Julian decision of kind `bug` may name for this session: active bugs and applicable unplanned bugs.
 * @param {any} result
 * @param {Catalog} catalog
 */
export function sessionBugIds(result, catalog) {
  const { active, unplanned, changeId } = sessionBugs(result, catalog);
  return { active: active.map((a) => a.id), unplanned: unplanned.map((u) => u.id), changeId };
}

const pick = (list, r) => list[Math.floor(r() * list.length)];
const byIdOrder = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Input for the grader: active bugs (with the broken change target), applicable unplanned bugs and up to
 * five inactive bugs as distractors, all in one id-sorted list with the same fields, so the grader cannot
 * tell which are active. Decoys: only those of run_config.decoys. Findings: the session's own participant
 * names and mcp__ tool names are replaced by [tool].
 * @param {{ result: any, catalog: Catalog }} p
 */
export function buildGraderInput({ result, catalog }) {
  const { rc, active, unplanned } = sessionBugs(result, catalog);
  const activeIds = new Set(active.map((a) => a.id));
  const entry = (bug, station, width) => ({ id: bug.id, title: bug.title, symptom: bug.symptom, grader: bug.grader, station, width });

  const withSecret = (rc.sources?.secret ?? 0) > 0;
  const rest = catalog.bugs.filter((b) => !activeIds.has(b.id) && (withSecret || b.source !== 'secret')).sort(byIdOrder);
  const r = prng(`${rc.seed}:distract`);
  const distractors = [];
  for (let k = 0; k < MAX_DISTRACTORS && rest.length; k++) {
    const bug = rest.splice(Math.floor(r() * rest.length), 1)[0];
    const station = pick(bug.stations, r);
    distractors.push(entry(bug, station, pick(bug.widths, r)));
  }

  const bugs = [
    ...active.map((a) => entry(a.bug, a.station, a.width)),
    ...unplanned.map((u) => ({ id: u.id, title: u.entry.title, symptom: u.entry.title, grader: u.entry.grader, station: u.station, width: 'all' })),
    ...distractors,
  ].sort(byIdOrder);

  const decoyById = new Map(catalog.decoys.map((d) => [d.id, d]));
  const decoys = (rc.decoys ?? []).map((id) => {
    const d = decoyById.get(id);
    if (!d) throw new Error(`grade: decoy ${id} of the run config is not in the loaded catalog`);
    return { id: d.id, station: d.station, title: d.title, grader: d.grader };
  }).sort(byIdOrder);

  const scrub = makeScrubber(participantTerms(result.participant));
  const findings = (result.report?.normalized?.findings ?? []).map((f, i) => ({
    i, title: scrub(f.title), where: scrub(f.where), viewport: f.viewport, steps: scrub(f.steps), expected: scrub(f.expected), actual: scrub(f.actual),
  }));
  return { bugs, decoys, findings };
}

// ---------- runGrader ----------

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string,string|undefined>, input: string, timeoutMs?: number }} opts
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
function spawnCollect(file, args, { cwd, env, input, timeoutMs = GRADER_TIMEOUT_MS }) {
  return new Promise((resolvePromise) => {
    const child = cpSpawn(file, args, { cwd, env: /** @type {any} */ (env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { stderr += '\n[grader timeout]'; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: `${stderr}${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Parses JSON that may sit in a code fence or between prose.
 * @param {any} text
 * @returns {any} undefined when there is no JSON object
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined;
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(text);
  if (fence) tries.push(fence[1].trim());
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object') return v;
    } catch { /* next */ }
  }
  return undefined;
}

/**
 * One entry per finding, in order; missing answers become none/low, unknown indexes are dropped.
 * @param {Array<{ i: number }>} findings
 * @param {any[]} raw
 * @returns {Match[]}
 */
function normalizeMatches(findings, raw) {
  /** @type {Map<number, any>} */
  const byI = new Map();
  for (const m of raw) if (m && Number.isInteger(m.i) && !byI.has(m.i)) byI.set(m.i, m);
  return findings.map(({ i }) => {
    const m = byI.get(i);
    if (!m) return { i, match: 'none', confidence: 'low', reason: 'no answer from the grader' };
    const match = typeof m.match === 'string' && m.match.trim() ? m.match.trim() : 'none';
    const confidence = CONFIDENCES.includes(m.confidence) ? m.confidence : 'low';
    return { i, match, confidence, reason: typeof m.reason === 'string' ? m.reason : '' };
  });
}

/** @param {any} outer claude --output-format json answer */
function modelOf(outer) {
  const mu = outer?.modelUsage;
  if (mu && typeof mu === 'object' && Object.keys(mu).length) {
    return Object.entries(mu).sort((a, b) => (Number(b[1]?.outputTokens) || 0) - (Number(a[1]?.outputTokens) || 0))[0][0];
  }
  return typeof outer?.model === 'string' && outer.model ? outer.model : GRADER_MODEL;
}

/**
 * Builds the grader prompt: instructions plus the input as a JSON block.
 * @param {string} promptText
 * @param {object} input
 */
export function buildGraderPrompt(promptText, input) {
  return `${promptText.trimEnd()}\n\n## Input\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n`;
}

/**
 * Runs the grader. Default: claude -p --model sonnet --output-format json with GRADER_FLAGS in an empty temp cwd.
 * With CODER_PARCOURS_GRADER_CMD: that shell command gets the prompt on stdin and writes JSON
 * ({ model?, matches }) to stdout; usage is then zero. Invalid JSON: one retry, then an error.
 * A model starting with MODEL_PIN (the agents' model) is an error. Errors carry the usage already spent (`err.usage`).
 * @param {{ bugs: any[], decoys: any[], findings: Array<{ i: number }> }} input
 * @param {{ env?: Record<string,string|undefined>, spawn?: typeof spawnCollect, claudeBin?: string, promptText?: string, timeoutMs?: number }} [deps]
 * @returns {Promise<{ matches: Match[], model: string, flags: string[], usage: { input_tokens: number, output_tokens: number, cost_usd: number }, raw: string }>}
 */
export async function runGrader(input, deps = {}) {
  const env = deps.env ?? process.env;
  const promptText = deps.promptText ?? readFileSync(GRADER_PROMPT_FILE, 'utf8');
  const prompt = buildGraderPrompt(promptText, input);
  const spawn = deps.spawn ?? spawnCollect;
  const cmd = env.CODER_PARCOURS_GRADER_CMD;
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const problems = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = mkdtempSync(join(tmpdir(), 'cp-grader-ctl-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cp-grader-cwd-'));
    try {
      let res;
      if (cmd) {
        res = await spawn('/bin/sh', ['-c', cmd], { cwd, env, input: prompt, timeoutMs: deps.timeoutMs });
      } else {
        const mcpFile = join(ctl, 'empty-mcp.json');
        writeFileSync(mcpFile, JSON.stringify({ mcpServers: {} }));
        const flags = GRADER_FLAGS.map((f) => (f === MCP_PLACEHOLDER ? mcpFile : f));
        const args = ['-p', '--model', GRADER_MODEL, '--output-format', 'json', ...flags];
        const bin = deps.claudeBin ?? resolveClaude(/** @type {any} */ (env));
        res = await spawn(bin, args, { cwd, env: scrubProviderKeys({ ...env }), input: prompt, timeoutMs: deps.timeoutMs });
      }

      let answer;
      let model;
      if (cmd) {
        answer = parseJsonLoose(res.stdout);
        if (answer && !Array.isArray(answer.matches) && typeof answer.result === 'string') answer = parseJsonLoose(answer.result);
        model = typeof answer?.model === 'string' && answer.model ? answer.model : 'custom-grader-cmd';
      } else {
        let outer;
        try { outer = JSON.parse(res.stdout); } catch { outer = undefined; }
        if (outer && typeof outer === 'object') {
          const u = outer.usage ?? {};
          usage.input_tokens += (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
          usage.output_tokens += Number(u.output_tokens) || 0;
          usage.cost_usd += Number(outer.total_cost_usd) || 0;
        }
        answer = parseJsonLoose(outer?.result);
        model = modelOf(outer);
      }
      if (model.startsWith(MODEL_PIN)) {
        throw Object.assign(new Error(`grade: grader model ${model} is the agents' model (${MODEL_PIN}); the grader must be a different model`), { usage });
      }
      if (answer && Array.isArray(answer.matches)) {
        return { matches: normalizeMatches(input.findings, answer.matches), model, flags: [...GRADER_FLAGS], usage, raw: res.stdout };
      }
      problems.push(`attempt ${attempt}: no valid JSON answer (exit ${res.code})${res.stderr ? `: ${res.stderr.trim().slice(0, 300)}` : ''}`);
    } finally {
      rmSync(ctl, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }
  throw Object.assign(new Error(`grade: grader gave no valid JSON after a retry. ${problems.join(' | ')}`), { usage });
}

// ---------- scoring ----------

/**
 * Classifies every finding of an explore session.
 * kind: 'hit' | 'duplicate' | 'decoy' | 'change' | 'decided' (false alarm by Julian) | 'open'.
 * target: the catalog id the finding counts for (bug, unplanned bug, decoy or change target), else null.
 * A decision { verdict: 'bug', id } from Julian overrides the grader's match when id is a bug active in this
 * session (or the change target); `byDecision` is then true. Other ids are ignored.
 * @param {{ result: any, catalog: Catalog, grading: { matches: Match[] } | null, decisions?: Record<string, any> }} p
 */
export function classifyFindings({ result, catalog, grading, decisions = {} }) {
  const findings = result.report?.normalized?.findings ?? [];
  const file = sessionFileOf(result);
  const { rc, changeId, active, unplanned } = sessionBugs(result, catalog);
  const bugIds = new Set([...active.map((a) => a.id), ...unplanned.map((u) => u.id)]);
  if (changeId) bugIds.delete(changeId);
  const unplannedIds = new Set(unplanned.map((u) => u.id));
  const decoyIds = new Set(rc.decoys ?? []);
  /** @type {Map<number, Match>} */
  const byI = new Map();
  for (const m of grading?.matches ?? []) if (!byI.has(m.i)) byI.set(m.i, m);
  const seen = new Set();
  const once = (id, first) => { const dup = seen.has(id); seen.add(id); return dup ? 'duplicate' : first; };

  return findings.map((finding, i) => {
    const m = byI.get(i);
    const match = m?.match ?? 'none';
    const key = findingKey(file, i, finding);
    let kind = 'open';
    let target = null;
    let byDecision = false;
    const dec = decisions[key];
    if (dec?.verdict === 'bug' && (bugIds.has(dec.id) || (changeId && dec.id === changeId))) {
      byDecision = true;
      if (dec.id === changeId) { kind = 'change'; target = changeId; } else { kind = once(dec.id, 'hit'); target = dec.id; }
    } else if (changeId && match === changeId) { kind = 'change'; target = changeId; }
    else if (bugIds.has(match)) { kind = once(match, 'hit'); target = match; }
    else if (decoyIds.has(match)) { kind = once(match, 'decoy'); target = match; }
    else {
      const d = dec;
      if (d?.verdict === 'false-alarm') { kind = 'decided'; byDecision = true; }
      else if (d?.verdict === 'new-bug' && unplannedIds.has(d.id)) { kind = once(d.id, 'hit'); target = d.id; byDecision = true; }
    }
    return { i, key, kind, target, match, confidence: m?.confidence ?? 'low', finding, byDecision };
  });
}

/** A trap that ends the login session (its server part calls expireSession). */
const isSessionTrap = (bug) => !!bug?.roles?.trap && /\bexpireSession\b/.test(String(bug.server?.setup ?? ''));

/**
 * @param {any[]} events
 * @param {boolean} sessionTrap
 */
function loginMetrics(events, sessionTrap) {
  const logins = events.filter((e) => e.type === 'login').length;
  let success = false;
  let loggedIn = false;
  for (const e of events) {
    if (e.type === 'login') loggedIn = true;
    else if (loggedIn && e.type === 'api' && e.authed === true && typeof e.status === 'number' && e.status < 400
      && e.route !== 'POST /api/auth/login') { success = true; break; }
  }
  let expired_relogin = null;
  if (sessionTrap) {
    const idx = events.findIndex((e) => e.type === 'session_expired');
    expired_relogin = idx >= 0 && events.slice(idx + 1).some((e) => e.type === 'login');
  }
  return { success, logins, expired_relogin };
}

/**
 * Per-session metrics. Rules: the first finding per bug is a hit, further ones are duplicates; a decoy match
 * is a false alarm; a match on a distractor or unknown id is none (open until decisions.json decides);
 * a finding about the change target counts nowhere; bugs.active excludes the change target.
 * @param {{ result: any, catalog: Catalog, grading: { matches: Match[] } | null, decisions?: Record<string, any> }} p
 * @returns {Metrics}
 */
export function scoreSession({ result, catalog, grading, decisions = {} }) {
  const human = result.participant?.kind === 'human';
  const ledger = result.harness?.calls_ledger;
  const cost = human ? null : {
    tokens: result.tokens?.delta ?? null,
    rounds: result.tokens?.rounds ?? null,
    calls: Array.isArray(ledger) ? ledger.length : null,
    wall_s: result.harness?.wall_clock_s ?? null,
    cost_usd_list: result.cost_usd_list ?? null,
  };
  if (result.session.type === 'capture') {
    const c = result.capture ?? {};
    return { change: null, bugs: null, false_alarms: null, duplicates: null, traps: null, login: null,
      capture: { valid: c.valid === true, reason: c.reason ?? null }, cost, hit_ids: [] };
  }

  const { rc, changeId, active, unplanned } = sessionBugs(result, catalog);
  const classes = classifyFindings({ result, catalog, grading, decisions });
  const hitIds = new Set(classes.filter((c) => c.kind === 'hit').map((c) => c.target));
  const counted = [...active.filter((a) => a.id !== changeId), ...unplanned];

  /** @type {Record<string,{active:number,hits:number}>} */
  const byCategory = {};
  /** @type {Record<string,{active:number,hits:number}>} */
  const byWidth = {};
  for (const a of counted) {
    for (const [bucket, k] of [[byCategory, a.category], [byWidth, a.width]]) {
      bucket[k] ??= { active: 0, hits: 0 };
      bucket[k].active++;
      if (hitIds.has(a.id)) bucket[k].hits++;
    }
  }
  const hits = counted.filter((a) => hitIds.has(a.id)).length;
  const count = (kind) => classes.filter((c) => c.kind === kind).length;
  const decoy = count('decoy');
  const decided = count('decided');
  const metrics = {
    change: null,
    bugs: { active: counted.length, hits, hit_rate: counted.length ? hits / counted.length : null, by_category: byCategory, by_width: byWidth },
    false_alarms: { decoy, decided, unreviewed: count('open'), total: decoy + decided },
    duplicates: count('duplicate'),
    traps: null,
    login: null,
    capture: null,
    cost: null,
    hit_ids: [...hitIds].sort(),
  };
  if (human) return metrics;

  if (rc.change) {
    const verdict = result.report?.normalized?.change_check?.verdict ?? null;
    const truth = rc.change.broken ? 'broken' : 'works';
    metrics.change = { verdict, truth, correct: verdict === null ? null : verdict === truth, false_works: verdict === 'works' && truth === 'broken' };
  }

  const events = Array.isArray(result.events) ? result.events : [];
  const traps = counted.filter((a) => a.bug?.roles?.trap);
  if (traps.length) {
    const t = { reached: 0, reported: 0, silently_bypassed: 0, stuck: 0, not_reached: 0 };
    for (const a of traps) {
      const has = (name) => events.some((e) => e.type === 'bug' && e.bug === a.id && e.event === name);
      const reached = has('reached');
      if (reached) t.reached++;
      if (hitIds.has(a.id)) t.reported++;
      else if (reached && has('passed')) t.silently_bypassed++;
      else if (reached) t.stuck++;
      else t.not_reached++;
    }
    metrics.traps = t;
  }
  metrics.login = loginMetrics(events, counted.some((a) => isSessionTrap(a.bug)));
  metrics.cost = cost;
  return metrics;
}

// ---------- round ----------

/**
 * @param {string} file
 * @param {any} fallback
 */
export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** @param {string} roundDir */
export function readDecisions(roundDir) {
  return readJson(join(roundDir, 'review', 'decisions.json'), {});
}

/**
 * @param {{ secretDir?: string|null }} opts
 * @param {{ catalog?: Catalog, loadCatalog?: (o?: any) => Promise<Catalog>, unplannedFile?: string }} deps
 * @returns {Promise<Catalog>}
 */
export async function catalogFor({ secretDir = null } = {}, deps = {}) {
  if (deps.catalog) return deps.catalog;
  if (deps.loadCatalog) return deps.loadCatalog({ secretDir });
  return loadCatalog({ secretDir, ...(deps.unplannedFile ? { unplannedFile: deps.unplannedFile } : {}) });
}

const ZERO_USAGE = () => ({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
const addUsage = (a, b) => ({
  input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
  output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  cost_usd: (a?.cost_usd ?? 0) + (b?.cost_usd ?? 0),
});
const isZeroUsage = (u) => !u || (!u.input_tokens && !u.output_tokens && !u.cost_usd);

/**
 * Grades every session file in results/<round>/sessions/ into results/<round>/graded/<same name>.
 * Explore sessions (agents and humans) go through the grader; existing matches are reused unless recall is set
 * or the session changed. Capture sessions get no grader call, only metrics.
 *
 * Grader cost is cumulative (what was really spent): grading.usage is the sum of ALL grader calls ever made for
 * this session file (earlier runs, --recall, apply, failed attempts included); grading.calls lists them one by
 * one ({ model, prompt_sha256, usage }); usage of a failed grader call is parked in <round>/grading-spent.json
 * and added to the next successful grading of that file. grading.decisions records which of Julian's
 * decisions flowed in ({ applied: [{ key, verdict, id? }], stale: [key] }).
 * @param {{ round: string, resultsRoot?: string, recall?: boolean, secretDir?: string|null }} opts
 * @param {object} [deps] runGrader deps plus catalog / loadCatalog / unplannedFile / log
 * @returns {Promise<string[]>} written paths
 */
export async function gradeRound({ round, resultsRoot = RESULTS_ROOT, recall = false, secretDir = null }, deps = {}) {
  const d = /** @type {any} */ (deps);
  const log = d.log ?? ((l) => process.stderr.write(`${l}\n`));
  const catalog = await catalogFor({ secretDir }, d);
  const roundDir = join(resultsRoot, round);
  const sessionsDir = join(roundDir, 'sessions');
  const gradedDir = join(roundDir, 'graded');
  if (!existsSync(sessionsDir)) throw new Error(`grade: no sessions folder ${sessionsDir}`);
  const decisions = readDecisions(roundDir);
  const promptText = d.promptText ?? readFileSync(GRADER_PROMPT_FILE, 'utf8');
  const promptSha = createHash('sha256').update(promptText).digest('hex');
  mkdirSync(gradedDir, { recursive: true });
  const spentFile = join(roundDir, 'grading-spent.json');
  /** @type {Record<string, any>} */
  const spent = readJson(spentFile, {});
  const saveSpent = () => {
    if (Object.keys(spent).length) writeFileSync(spentFile, `${JSON.stringify(spent, null, 2)}\n`);
    else rmSync(spentFile, { force: true });
  };

  const written = [];
  let calls = 0;
  try {
    for (const name of readdirSync(sessionsDir).filter((n) => n.endsWith('.json')).sort()) {
      const result = JSON.parse(readFileSync(join(sessionsDir, name), 'utf8'));
      if (sessionFileOf(result) !== name) throw new Error(`grade: ${name} does not match its content (expected ${sessionFileOf(result)})`);
      const outPath = join(gradedDir, name);
      const prev = readJson(outPath, null);
      // earlier spending on this file, whatever happens to the matches now
      const prevCalls = Array.isArray(prev?.grading?.calls) ? prev.grading.calls
        : !isZeroUsage(prev?.grading?.usage) ? [{ model: prev.grading.model, prompt_sha256: prev.grading.prompt_sha256, usage: prev.grading.usage }] : [];
      const prevUsage = prev?.grading?.usage ?? ZERO_USAGE();
      let grading;
      if (result.session.type === 'capture') {
        grading = { model: 'n/a (capture session)', flags: [], prompt_sha256: promptSha, usage: ZERO_USAGE(), matches: [] };
      } else {
        const same = !recall && prev && prev.session?.run_config_sha256 === result.session.run_config_sha256
          && prev.grading?.prompt_sha256 === promptSha
          && JSON.stringify(prev.report?.normalized?.findings) === JSON.stringify(result.report?.normalized?.findings);
        if (same && prev.grading) grading = prev.grading;
        else {
          const input = buildGraderInput({ result, catalog });
          if (!input.findings.length) {
            grading = { model: 'n/a (no findings)', flags: [], prompt_sha256: promptSha, usage: ZERO_USAGE(), matches: [] };
          } else {
            let g;
            try {
              g = await runGrader(input, { ...d, promptText });
            } catch (err) {
              const lost = /** @type {any} */ (err)?.usage;
              if (!isZeroUsage(lost)) { spent[name] = addUsage(spent[name], lost); saveSpent(); }
              throw err;
            }
            calls++;
            const owed = spent[name];
            delete spent[name];
            const entry = { model: g.model, prompt_sha256: promptSha, usage: addUsage(g.usage, owed) };
            grading = { model: g.model, flags: g.flags, prompt_sha256: promptSha, usage: entry.usage, matches: g.matches, calls: [entry] };
          }
        }
      }
      if (grading !== prev?.grading) {
        // not reused: keep everything spent before
        grading = { ...grading, usage: addUsage(prevUsage, grading.usage), ...(prevCalls.length || grading.calls ? { calls: [...prevCalls, ...(grading.calls ?? [])] } : {}) };
      }
      const graded0 = { ...result, schema: GRADED_SCHEMA, grading };
      const stale = staleDecisionKeys(result, decisions);
      for (const k of stale) log(`grade: ${name}: decision ${k} is stale (the finding changed since); not applied`);
      const classes = result.session.type === 'capture' ? [] : classifyFindings({ result, catalog, grading, decisions });
      grading = { ...grading, decisions: {
        applied: classes.filter((c) => c.byDecision).map((c) => ({ key: c.key, verdict: decisions[c.key].verdict, ...(decisions[c.key].id ? { id: decisions[c.key].id } : {}) })),
        stale,
      } };
      const metrics = scoreSession({ result, catalog, grading, decisions });
      const graded = { ...graded0, grading, metrics };
      const problems = validateGradedResult(graded);
      if (problems.length) throw new Error(`grade: ${name}: ${problems.join('; ')}`);
      writeFileSync(outPath, `${JSON.stringify(graded, null, 2)}\n`);
      written.push(outPath);
    }
  } finally {
    saveSpent(); // also when a later session throws: settled postings must not stay in the file (they would be counted twice)
  }
  log(`grade: ${written.length} sessions graded, ${calls} grader calls -> ${gradedDir}`);
  return written;
}

// ---------- CLI ----------

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = { _: /** @type {any} */ ([]) };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[k + 1];
      if (next === undefined || next.startsWith('--')) out[name] = true;
      else { out[name] = next; k++; }
    } else /** @type {any} */ (out._).push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.round !== 'string') {
    process.stderr.write('usage: node harness/grade.mjs --round <r> [--recall] [--results <dir>] [--secret-dir <dir>]\n');
    process.exit(2);
  }
  await gradeRound({
    round: args.round,
    recall: args.recall === true,
    resultsRoot: typeof args.results === 'string' ? resolve(args.results) : RESULTS_ROOT,
    secretDir: typeof args['secret-dir'] === 'string' ? resolve(args['secret-dir']) : null,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { process.stderr.write(`${err.message}\n`); process.exit(1); });
}
