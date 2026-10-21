// Session result (SESSION_SCHEMA) and graded result (GRADED_SCHEMA): file names and validation.
import { homedir } from 'node:os';
import { runConfigSha } from './seed.mjs';

export const SESSION_SCHEMA = 'coder-parcours/session@1';
export const GRADED_SCHEMA = 'coder-parcours/graded@1';

const KINDS = ['mcp', 'cli', 'human'];
const TYPES = ['explore', 'capture'];
const STATUSES = ['ok', 'budget', 'timeout', 'aborted'];
const EVENT_TYPES = ['api', 'login', 'login_failed', 'logout', 'register', 'session_expired', 'bug'];
const HARNESS_KEYS = ['claude_code_version', 'os', 'node', 'chrome_version', 'wall_clock_s', 'exit_code', 'num_turns',
  'flags', 'tool_lock', 'session_jsonl_sha256', 'calls_ledger', 'integrity'];
const TOKEN_KEYS = ['delta', 'rounds', 'dedup', 'result_usage_total'];
const HUMAN_KEYS = ['schema', 'participant', 'session', 'status', 'report', 'events', 'notes'];
const CONFIDENCES = ['high', 'medium', 'low'];

/**
 * @param {{ slug: string, type: string, seed: number }} p
 * @returns {string}
 */
export function sessionFileName({ slug, type, seed }) {
  return `${slug}-${type}-seed${seed}.json`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const strOrNull = (v) => v === null || typeof v === 'string';

/**
 * @param {any} obj
 * @param {string} expectedSchema
 * @returns {string[]}
 */
function validateBase(obj, expectedSchema) {
  if (!isObj(obj)) return ['result must be an object'];
  const p = [];
  if (obj.schema !== expectedSchema) p.push(`schema must be ${expectedSchema}`);

  const part = obj.participant;
  const human = isObj(part) && part.kind === 'human';
  if (!isObj(part)) p.push('participant missing');
  else {
    if (!isStr(part.slug) || part.slug === '') p.push('participant.slug missing');
    if (!isStr(part.display)) p.push('participant.display missing');
    if (!KINDS.includes(part.kind)) p.push(`participant.kind must be one of ${KINDS.join(', ')}`);
    if (!('package' in part) || !strOrNull(part.package)) p.push('participant.package must be a string or null');
    if (!('version' in part) || !strOrNull(part.version)) p.push('participant.version must be a string or null');
  }

  const s = obj.session;
  if (!isObj(s)) p.push('session missing');
  else {
    if (!TYPES.includes(s.type)) p.push(`session.type must be one of ${TYPES.join(', ')}`);
    if (!Number.isInteger(s.seed)) p.push('session.seed must be an integer');
    if (!isStr(s.round) || s.round === '') p.push('session.round missing');
    if (!isObj(s.run_config)) p.push('session.run_config missing');
    else if (s.run_config_sha256 !== runConfigSha(s.run_config)) p.push('session.run_config_sha256 does not match run_config');
    if (human) {
      if (s.type !== 'explore') p.push("human sessions are of type 'explore'");
      if (!('hosted_commit' in s) || !strOrNull(s.hosted_commit)) p.push('session.hosted_commit must be a string or null');
    }
  }

  if (!STATUSES.includes(obj.status)) p.push(`status must be one of ${STATUSES.join(', ')}`);

  if (!Array.isArray(obj.events)) p.push('events must be a list');
  else if (human && obj.events.length) p.push('events must be empty for human sessions');
  else obj.events.forEach((e, i) => {
    if (!isObj(e) || !isStr(e.t) || !isStr(e.sb) || !EVENT_TYPES.includes(e.type)) p.push(`events[${i}] is not a valid event line`);
  });

  if (!(isStr(obj.notes) || (Array.isArray(obj.notes) && obj.notes.every(isStr)))) p.push('notes must be a string or a list of strings');

  const isExplore = isObj(s) && s.type === 'explore';
  if (isExplore || human) {
    const r = obj.report;
    if (!isObj(r) || typeof r.ok !== 'boolean' || !Array.isArray(r.problems) || !isObj(r.normalized)) p.push('report {ok, problems, normalized} missing');
  }

  if (human) {
    for (const k of Object.keys(obj)) if (!HUMAN_KEYS.includes(k)) p.push(`human sessions must not have ${k}`);
  } else {
    if (!isStr(obj.model) || obj.model === '') p.push('model missing');
    const h = obj.harness;
    if (!isObj(h)) p.push('harness missing');
    else {
      for (const k of HARNESS_KEYS) if (!(k in h)) p.push(`harness.${k} missing`);
      if ('integrity' in h && (!isObj(h.integrity) || typeof h.integrity.read_bug_script !== 'boolean' || typeof h.integrity.capture_outside_access !== 'boolean')) {
        p.push('harness.integrity {read_bug_script, capture_outside_access} must be booleans');
      }
      if ('integrity' in h && isObj(h.integrity) && 'local_file_access' in h.integrity && typeof h.integrity.local_file_access !== 'boolean') {
        p.push('harness.integrity.local_file_access must be a boolean');
      }
    }
    const t = obj.tokens;
    if (!isObj(t)) p.push('tokens missing');
    else for (const k of TOKEN_KEYS) if (!(k in t)) p.push(`tokens.${k} missing`);
    if (!Array.isArray(obj.cost_usd_list)) p.push('cost_usd_list must be a list');
    if (isObj(s) && s.type === 'capture') {
      const c = obj.capture;
      if (!isObj(c) || !['command', 'healthy', 'broken', 'reason'].every((k) => k in c) || typeof c.valid !== 'boolean') {
        p.push('capture {command, healthy, broken, valid, reason} missing');
      }
    }
  }

  const home = homedir();
  if (home && home.length > 1 && JSON.stringify(obj).includes(home)) p.push('result contains the home path; replace it with ~');
  return p;
}

/**
 * @param {any} obj
 * @returns {string[]} problems, empty when valid
 */
export function validateSessionResult(obj) {
  return validateBase(obj, SESSION_SCHEMA);
}

/**
 * Graded result = session result with schema GRADED_SCHEMA plus grading and metrics.
 * @param {any} obj
 * @returns {string[]} problems, empty when valid
 */
export function validateGradedResult(obj) {
  if (!isObj(obj)) return ['result must be an object'];
  const { grading, metrics, ...base } = obj;
  const p = validateBase(base, GRADED_SCHEMA);
  if (!isObj(grading)) p.push('grading missing');
  else {
    if (!isStr(grading.model) || grading.model === '') p.push('grading.model missing');
    if (!Array.isArray(grading.flags)) p.push('grading.flags must be a list');
    if (!isStr(grading.prompt_sha256)) p.push('grading.prompt_sha256 missing');
    if (!isObj(grading.usage)) p.push('grading.usage missing');
    if (!Array.isArray(grading.matches)) p.push('grading.matches must be a list');
    else grading.matches.forEach((m, i) => {
      if (!isObj(m) || !Number.isInteger(m.i) || !isStr(m.match) || !CONFIDENCES.includes(m.confidence)) p.push(`grading.matches[${i}] is not a valid match`);
    });
  }
  if (!isObj(metrics)) p.push('metrics missing');
  return p;
}
