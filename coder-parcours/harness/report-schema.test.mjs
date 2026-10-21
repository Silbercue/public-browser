import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeExploreReport, readCaptureCommand, normalizeTester, REPORT_LIMITS } from './report-schema.mjs';

test('REPORT_LIMITS', () => {
  assert.deepEqual(REPORT_LIMITS, { textMax: 4000, pathMax: 300, perSandbox: 30, windowMin: 10 });
});

test('half-written JSON: ok false, no findings, problem noted', () => {
  const r = normalizeExploreReport('{"findings":[{"title":"x"');
  assert.equal(r.ok, false);
  assert.deepEqual(r.report.findings, []);
  assert.equal(r.report.change_check.verdict, null);
  assert.ok(r.problems.length > 0);
});

test('null, undefined, plain string, array, number: ok false with empty report', () => {
  for (const raw of [null, undefined, 'not json at all', '"just a string"', '[1,2]', 42, '']) {
    const r = normalizeExploreReport(raw);
    assert.equal(r.ok, false, String(raw));
    assert.deepEqual(r.report, { change_check: { verdict: null, evidence: '' }, findings: [] });
    assert.ok(r.problems.length > 0, String(raw));
  }
});

test('valid report as string or object is normalized (gegenprobe)', () => {
  const raw = {
    change_check: { verdict: 'broken', evidence: 'Coupon did nothing.' },
    findings: [{ title: 'A', where: '/cart', viewport: 'tablet', steps: '1', expected: 'e', actual: 'a', severity: 'high' }],
  };
  for (const input of [raw, JSON.stringify(raw)]) {
    const r = normalizeExploreReport(input);
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.report, raw);
  }
});

test('viewport numbers map via width class, unknown to all; missing fields to empty string', () => {
  const r = normalizeExploreReport({
    findings: [{ title: 'x', viewport: 375 }, { viewport: 768 }, { viewport: 1440 }, { viewport: 'watch' }, { viewport: '390px' }, {}],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.findings.map((f) => f.viewport), ['phone', 'tablet', 'desktop', 'all', 'phone', 'all']);
  assert.deepEqual(r.report.findings[1], { title: '', where: '', viewport: 'tablet', steps: '', expected: '', actual: '', severity: '' });
  assert.deepEqual(r.report.change_check, { verdict: null, evidence: '' });
});

test('unknown verdict becomes null; non-object findings are skipped with a problem', () => {
  const r = normalizeExploreReport({ change_check: { verdict: 'maybe' }, findings: ['oops', { title: 'ok' }] });
  assert.equal(r.report.change_check.verdict, null);
  assert.equal(r.report.findings.length, 1);
  assert.ok(r.problems.length >= 2);
});

test('readCaptureCommand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-run-'));
  try {
    assert.deepEqual(readCaptureCommand(dir), { ok: false, problems: ['RUN missing'], command: null });
    writeFileSync(join(dir, 'RUN'), '\n   \n');
    assert.deepEqual(readCaptureCommand(dir), { ok: false, problems: ['RUN empty'], command: null });
    writeFileSync(join(dir, 'RUN'), '\n  node test/coupon.mjs  \nsecond line\n');
    assert.deepEqual(readCaptureCommand(dir), { ok: true, problems: [], command: 'node test/coupon.mjs' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeTester', () => {
  assert.equal(normalizeTester('Anna Müller!'), 'anna-m-ller');
  assert.equal(normalizeTester(''), 'anonymous');
  assert.equal(normalizeTester(undefined), 'anonymous');
  assert.equal(normalizeTester('!!!'), 'anonymous');
  assert.equal(normalizeTester('../x'), 'x');
  const long = normalizeTester('a'.repeat(50));
  assert.equal(long.length, 32);
  for (const s of ['Anna Müller!', 'a'.repeat(50), `${'b'.repeat(31)} c`, 'X_Y z']) assert.match(normalizeTester(s), /^[a-z0-9-]{1,32}$/);
});
