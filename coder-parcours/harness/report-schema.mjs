// Agent reports (report.json, test/RUN) and human report helpers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { widthClassForPx } from '../catalog/schema.mjs';

/**
 * @typedef {{ title: string, where: string, viewport: 'phone'|'tablet'|'desktop'|'all',
 *   steps: string, expected: string, actual: string, severity: string }} Finding
 */
/** @typedef {{ change_check: { verdict: 'works'|'broken'|null, evidence: string }, findings: Finding[] }} ExploreReport */

export const REPORT_LIMITS = { textMax: 4000, pathMax: 300, perSandbox: 30, windowMin: 10 };

const TEXT_FIELDS = /** @type {const} */ (['title', 'where', 'steps', 'expected', 'actual', 'severity']);
const VIEWPORTS = ['phone', 'tablet', 'desktop', 'all'];

/** @returns {ExploreReport} */
const emptyReport = () => ({ change_check: { verdict: null, evidence: '' }, findings: [] });

/** @param {any} v */
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/**
 * @param {any} v
 * @returns {Finding['viewport']}
 */
function viewportOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return widthClassForPx(v);
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (VIEWPORTS.includes(s)) return /** @type {Finding['viewport']} */ (s);
    const m = /^(\d+)\s*(px)?$/.exec(s);
    if (m && Number(m[1]) > 0) return widthClassForPx(Number(m[1]));
  }
  return 'all';
}

/**
 * Lenient: never throws. A missing, half-written or non-object report gives ok: false and no findings.
 * @param {any} raw report.json content (string) or parsed value
 * @returns {{ ok: boolean, problems: string[], report: ExploreReport }}
 */
export function normalizeExploreReport(raw) {
  const problems = [];
  let data = raw;
  if (raw === null || raw === undefined) return { ok: false, problems: ['report missing'], report: emptyReport() };
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return { ok: false, problems: [`report is not valid JSON: ${err.message}`], report: emptyReport() };
    }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, problems: ['report must be a JSON object'], report: emptyReport() };
  }

  const report = emptyReport();
  const cc = data.change_check;
  if (cc === undefined || cc === null) problems.push('change_check missing');
  else if (typeof cc !== 'object') problems.push('change_check must be an object');
  else {
    if (cc.verdict === 'works' || cc.verdict === 'broken') report.change_check.verdict = cc.verdict;
    else if (cc.verdict !== null && cc.verdict !== undefined) problems.push(`change_check.verdict ${JSON.stringify(cc.verdict)} is not works or broken`);
    report.change_check.evidence = text(cc.evidence);
  }

  if (data.findings === undefined) problems.push('findings missing');
  else if (!Array.isArray(data.findings)) problems.push('findings must be a list');
  else {
    data.findings.forEach((f, i) => {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) {
        problems.push(`findings[${i}] is not an object, skipped`);
        return;
      }
      /** @type {any} */
      const out = {};
      for (const k of TEXT_FIELDS) out[k] = text(f[k]);
      out.viewport = viewportOf(f.viewport);
      report.findings.push({
        title: out.title, where: out.where, viewport: out.viewport, steps: out.steps,
        expected: out.expected, actual: out.actual, severity: out.severity,
      });
    });
  }
  return { ok: true, problems, report };
}

/**
 * Reads the first non-empty line of `${testDir}/RUN`.
 * @param {string} testDir
 * @returns {{ ok: boolean, problems: string[], command: string|null }}
 */
export function readCaptureCommand(testDir) {
  let content;
  try {
    content = readFileSync(join(testDir, 'RUN'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, problems: ['RUN missing'], command: null };
    return { ok: false, problems: [`RUN unreadable: ${err.message}`], command: null };
  }
  const line = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (!line) return { ok: false, problems: ['RUN empty'], command: null };
  return { ok: true, problems: [], command: line };
}

/**
 * Normalizes a tester name to ^[a-z0-9-]{1,32}$ instead of rejecting it; empty -> 'anonymous'.
 * @param {any} raw
 * @returns {string}
 */
export function normalizeTester(raw) {
  if (typeof raw !== 'string') return 'anonymous';
  const trimDashes = (s) => s.replace(/^-+|-+$/g, '');
  const name = trimDashes(trimDashes(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 32));
  return name || 'anonymous';
}
