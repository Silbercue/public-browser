// Test helpers for grade/review tests: a literal catalog and session results built from it.
import { buildRunConfig, runConfigSha, changeBrokenFor, loadSeeds } from '../../harness/seed.mjs';
import { SESSION_SCHEMA } from '../../harness/result-schema.mjs';

const css = () => '';

/** @returns {import('../../catalog/load.mjs').Catalog} */
export function fixtureCatalog() {
  /** @type {any[]} */
  const bugs = [
    { id: 'B01', category: 'fiddly', title: 'Bug one', stations: ['cart'], widths: ['phone'], severity: 'low', symptom: 'Symptom one', grader: 'Grader one', client: { css } },
    { id: 'B02', category: 'function', title: 'Bug two', stations: ['cart'], widths: ['all'], severity: 'high', symptom: 'Symptom two', grader: 'Grader two',
      roles: { change: { feature: 'Feature two' } }, server: { setup() {} } },
    { id: 'B03', category: 'timing', title: 'Bug three', stations: ['schedule'], widths: ['all'], severity: 'medium', symptom: 'Symptom three', grader: 'Grader three',
      roles: { trap: { reached: 'r', passed: 'p' } }, client: { css } },
    { id: 'B04', category: 'timing', title: 'Bug four', stations: ['bookings'], widths: ['all'], severity: 'medium', symptom: 'Symptom four', grader: 'Grader four',
      roles: { trap: { reached: 'r', passed: 'p' } },
      server: { setup(api) { api.before('GET /api/bookings', (ctx) => { ctx.expireSession(); }); } } },
    { id: 'B05', category: 'next-step', title: 'Bug five', stations: ['checkout', 'cart'], widths: ['tablet', 'desktop'], severity: 'low', symptom: 'Symptom five', grader: 'Grader five', client: { css } },
    { id: 'B06', category: 'layout', title: 'Bug six', stations: ['profile'], widths: ['phone'], severity: 'low', symptom: 'Symptom six', grader: 'Grader six', client: { css } },
    { id: 'B07', category: 'layout', title: 'Bug seven', stations: ['home'], widths: ['desktop'], severity: 'low', symptom: 'Symptom seven', grader: 'Grader seven', client: { css } },
    { id: 'B08', category: 'background', title: 'Bug eight', stations: ['settings'], widths: ['all'], severity: 'low', symptom: 'Symptom eight', grader: 'Grader eight', server: { setup() {} } },
    { id: 'B09', category: 'fiddly', title: 'Bug nine', stations: ['login', 'register'], widths: ['tablet'], severity: 'low', symptom: 'Symptom nine', grader: 'Grader nine', client: { css } },
  ].map((b) => ({ ...b, source: 'public' }));
  return {
    bugs,
    decoys: [
      { id: 'D01', station: 'cart', title: 'Decoy one', grader: 'Decoy grader one' },
      { id: 'D02', station: 'profile', title: 'Decoy two', grader: 'Decoy grader two', conflicts: ['B06'] },
    ],
    unplanned: [],
    sources: { public: bugs.length, secret: 0 },
  };
}

/** First seed from seeds.json whose change target is broken (or healthy). */
export function seedWithChange(broken) {
  const s = loadSeeds().find((x) => changeBrokenFor(x) === broken);
  if (s === undefined) throw new Error('no such seed');
  return s;
}

/**
 * @param {{ catalog: any, seed: number, activate?: any[]|null, findings?: any[], verdict?: string|null,
 *   events?: any[], slug?: string, display?: string, pkg?: string|null, kind?: string, type?: string, round?: string }} o
 * @returns {any}
 */
export function makeSession({ catalog, seed, activate = null, findings = [], verdict = null, events = [], slug = 'public-browser',
  display = 'Public Browser', pkg = 'public-browser', kind = 'mcp', type = 'explore', round = 'r1' }) {
  const rc = buildRunConfig({ seed, sessionType: /** @type {any} */ (type), catalog, activate });
  const fullFindings = findings.map((f) => ({ title: '', where: '/cart', viewport: 'all', steps: '', expected: '', actual: '', severity: '', ...f }));
  const report = { ok: true, problems: [], normalized: { change_check: { verdict, evidence: '' }, findings: fullFindings } };
  const session = { type, seed, round, run_config: rc, run_config_sha256: runConfigSha(rc) };
  const participant = { slug, display, kind, package: pkg, version: kind === 'human' ? null : '1.0.0' };
  if (kind === 'human') {
    return { schema: SESSION_SCHEMA, participant, session: { ...session, hosted_commit: null }, status: 'ok', report, events: [], notes: [] };
  }
  return {
    schema: SESSION_SCHEMA,
    participant,
    session,
    status: 'ok',
    model: 'claude-opus-5-20261001',
    harness: {
      claude_code_version: '2.0.0', os: 'darwin', node: 'v22.0.0', chrome_version: '150', wall_clock_s: 120,
      exit_code: 0, num_turns: 30, flags: [], tool_lock: {}, session_jsonl_sha256: 'a'.repeat(64),
      calls_ledger: [{ i: 1, tool: 'x', chars: 10 }, { i: 2, tool: 'y', chars: 20 }],
      integrity: { read_bug_script: false, capture_outside_access: false },
    },
    tokens: { delta: 5000, rounds: 12, dedup: 1, result_usage_total: 5100 },
    cost_usd_list: [0.42],
    ...(type === 'explore' ? { report } : { capture: { command: 'node t.mjs', healthy: { exit: 0 }, broken: { exit: 1 }, valid: true, reason: null } }),
    events,
    notes: [],
  };
}
