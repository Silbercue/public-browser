import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { SESSION_SCHEMA, GRADED_SCHEMA, sessionFileName, validateSessionResult, validateGradedResult } from './result-schema.mjs';
import { runConfigSha } from './seed.mjs';

const runConfig = {
  seed: 11, sessionType: 'explore', variant: null, sources: { public: 3, secret: 0 },
  active: [{ id: 'F01', station: 'cart', width: 'phone' }], change: null, capture: null, decoys: [],
};

/** @returns {any} */
function agentResult(type = 'explore') {
  const rc = { ...runConfig, sessionType: type };
  return {
    schema: SESSION_SCHEMA,
    participant: { slug: 'public-browser', display: 'Public Browser', kind: 'mcp', package: 'public-browser', version: '3.1.0' },
    session: { type, seed: 11, round: 'r1', run_config: rc, run_config_sha256: runConfigSha(rc) },
    status: 'ok',
    model: 'claude-opus-5-20261001',
    harness: {
      claude_code_version: '2.0.0', os: 'darwin', node: 'v22.0.0', chrome_version: '150', wall_clock_s: 12,
      exit_code: 0, num_turns: 3, flags: [], tool_lock: {}, session_jsonl_sha256: 'a'.repeat(64), calls_ledger: [],
      integrity: { read_bug_script: false, capture_outside_access: false },
    },
    tokens: { delta: 1, rounds: 1, dedup: 1, result_usage_total: 1 },
    cost_usd_list: [0.1],
    ...(type === 'explore'
      ? { report: { ok: true, problems: [], normalized: { change_check: { verdict: null, evidence: '' }, findings: [] } } }
      : { capture: { command: 'node t.mjs', healthy: { exit: 0 }, broken: { exit: 1 }, valid: true, reason: null } }),
    events: [{ t: '2026-10-21T10:00:00.000Z', sb: 'single', type: 'api', route: 'GET /api/cart', status: 200, authed: false }],
    notes: [],
  };
}

/** @returns {any} */
function humanResult() {
  return {
    schema: SESSION_SCHEMA,
    participant: { slug: 'human-anna', display: 'anna', kind: 'human', package: null, version: null },
    session: { type: 'explore', seed: 11, round: 'r1', run_config: runConfig, run_config_sha256: runConfigSha(runConfig), hosted_commit: null },
    status: 'ok',
    report: { ok: true, problems: [], normalized: { change_check: { verdict: null, evidence: '' }, findings: [] } },
    events: [],
    notes: [],
  };
}

test('sessionFileName', () => {
  assert.equal(sessionFileName({ slug: 'public-browser', type: 'explore', seed: 11 }), 'public-browser-explore-seed11.json');
});

test('valid agent results (explore, capture) and human result pass', () => {
  assert.deepEqual(validateSessionResult(agentResult('explore')), []);
  assert.deepEqual(validateSessionResult(agentResult('capture')), []);
  assert.deepEqual(validateSessionResult(humanResult()), []);
});

test('missing status is reported', () => {
  const r = agentResult();
  delete r.status;
  assert.ok(validateSessionResult(r).some((p) => /status/.test(p)));
  const h = humanResult();
  delete h.status;
  assert.ok(validateSessionResult(h).some((p) => /status/.test(p)));
});

test('agent fields are checked', () => {
  /** @type {Array<[(r: any) => void, RegExp]>} */
  const cases = [
    [(r) => { r.schema = 'x'; }, /schema/],
    [(r) => { r.status = 'done'; }, /status/],
    [(r) => { delete r.model; }, /model/],
    [(r) => { delete r.harness.integrity; }, /integrity/],
    [(r) => { delete r.harness.calls_ledger; }, /calls_ledger/],
    [(r) => { delete r.tokens.dedup; }, /dedup/],
    [(r) => { delete r.cost_usd_list; }, /cost_usd_list/],
    [(r) => { delete r.report; }, /report/],
    [(r) => { r.participant.kind = 'robot'; }, /kind/],
    [(r) => { r.session.run_config_sha256 = 'f'.repeat(64); }, /run_config_sha256/],
    [(r) => { r.events = [{ t: 'x', sb: 's', type: 'nope' }]; }, /events/],
    [(r) => { delete r.notes; }, /notes/],
  ];
  for (const [mutate, re] of cases) {
    const r = agentResult();
    mutate(r);
    const p = validateSessionResult(r);
    assert.ok(p.some((x) => re.test(x)), `${re}: ${p.join(' | ')}`);
  }
  const c = agentResult('capture');
  delete c.capture.valid;
  assert.ok(validateSessionResult(c).some((p) => /capture/.test(p)));
});

test('human: only the allowed fields, events empty, hosted_commit present', () => {
  const extra = humanResult();
  extra.harness = agentResult().harness;
  assert.ok(validateSessionResult(extra).some((p) => /harness/.test(p)));
  const ev = humanResult();
  ev.events = agentResult().events;
  assert.ok(validateSessionResult(ev).some((p) => /events/.test(p)));
  const hc = humanResult();
  delete hc.session.hosted_commit;
  assert.ok(validateSessionResult(hc).some((p) => /hosted_commit/.test(p)));
});

test('home path anywhere in the result is reported', () => {
  const r = agentResult();
  r.notes = [`log at ${homedir()}/x.jsonl`];
  assert.ok(validateSessionResult(r).some((p) => /home/i.test(p)));
});

test('graded result: session result plus grading and metrics', () => {
  const g = {
    ...agentResult(),
    schema: GRADED_SCHEMA,
    grading: { model: 'claude-sonnet-5', flags: [], prompt_sha256: 'b'.repeat(64), usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 }, matches: [{ i: 0, match: 'none', confidence: 'low', reason: 'r' }] },
    metrics: { hit_ids: [] },
  };
  assert.deepEqual(validateGradedResult(g), []);
  const noGrading = { ...g };
  delete noGrading.grading;
  assert.ok(validateGradedResult(noGrading).some((p) => /grading/.test(p)));
  const noMetrics = { ...g };
  delete noMetrics.metrics;
  assert.ok(validateGradedResult(noMetrics).some((p) => /metrics/.test(p)));
  const noStatus = { ...g };
  delete noStatus.status;
  assert.ok(validateGradedResult(noStatus).some((p) => /status/.test(p)));
  assert.ok(validateGradedResult({ ...g, schema: SESSION_SCHEMA }).some((p) => /schema/.test(p)));
});
