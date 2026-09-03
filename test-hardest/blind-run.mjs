#!/usr/bin/env node
// blind-run.mjs — blind benchmark harness for browser MCP servers.
// One fresh Claude Code print-mode session per run, exactly one MCP server, metrics measured
// post hoc from the session JSONL (measure-*.sh). See test-hardest/README.md.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const ALL_TESTS = [
  'T1.1', 'T1.2', 'T1.3', 'T1.4', 'T1.5', 'T1.6',
  'T2.1', 'T2.2', 'T2.3', 'T2.4', 'T2.5', 'T2.6',
  'T3.1', 'T3.2', 'T3.3', 'T3.4', 'T3.5', 'T3.6',
  'T4.1', 'T4.2', 'T4.3', 'T4.4', 'T4.5', 'T4.6', 'T4.7',
  'T5.1', 'T5.2', 'T5.3', 'T5.4', 'T5.5', 'T5.6', 'T5.7', 'T5.8', 'T5.9', 'T5.10',
];
// T5.3–T5.6: runner-only (cannot be started by hand). T4.7: grades self-reported token counts, not a browser capability.
export const EXCLUDED = ['T4.7', 'T5.3', 'T5.4', 'T5.5', 'T5.6'];
export const SCORABLE = ALL_TESTS.filter((id) => !EXCLUDED.includes(id));
export const SUITE_URL = 'https://mcp-test.second-truth.com';

export const PARTICIPANTS = {
  'public-browser': {
    name: 'public-browser', display: 'Public Browser', package: 'public-browser', version: '2.10.1',
    command: 'npx', args: ['-y', 'public-browser@2.10.1'],
    env: () => ({
      PUBLIC_BROWSER_CORTEX_DIR: mkdtempSync(join(tmpdir(), 'pb-cortex-kalt-')),
      PUBLIC_BROWSER_TELEMETRY: '0',
      PUBLIC_BROWSER_CHROME_PORT: '9333',
    }),
    snapshotTool: 'view_page',
    profile_isolation: 'auto-launched Chrome, fresh temp user-data-dir, CDP port 9333',
  },
  'playwright-mcp': {
    name: 'playwright', display: 'Playwright MCP', package: '@playwright/mcp', version: '0.0.80',
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome', '--isolated'],
    env: () => ({}),
    snapshotTool: 'browser_snapshot',
    profile_isolation: '--isolated (in-memory profile)',
  },
  'chrome-devtools-mcp': {
    name: 'chrome-devtools', display: 'Chrome DevTools MCP', package: 'chrome-devtools-mcp', version: '1.8.0',
    command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', '--isolated'],
    env: () => ({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }),
    snapshotTool: 'take_snapshot',
    profile_isolation: '--isolated (temp user-data-dir)',
  },
  'browser-use': {
    name: 'browser-use', display: 'browser-use', package: 'browser-use', version: '0.12.5',
    command: process.env.BLIND_RUN_BROWSER_USE_BIN || '/Users/silbercue/.browser-use-env/bin/browser-use',
    args: ['--mcp'],
    env: () => ({}),
    snapshotTool: 'browser_get_state',
    profile_isolation: 'default browser-use profile (not isolated)',
  },
};

export const MQS_BASELINE = { chars: 175319, pass_rate: 93.5, calls: 121, duration_s: 563, id: 'playwright-mcp-run2-2026-04-09' };

const STATUSES = ['pass', 'fail', 'skip', 'pending'];

export function score(tests) {
  let passed = 0, failed = 0, not_run = 0;
  for (const id of SCORABLE) {
    const s = tests?.[id]?.status;
    if (s === 'pass') passed++; else if (s === 'fail') failed++; else not_run++;
  }
  const counted = SCORABLE.length;
  return { total: ALL_TESTS.length, counted, passed, failed, not_run, skipped: EXCLUDED.length,
    pass_rate: Math.round((passed / counted) * 1000) / 10 };
}

export function mcpOnly(byTool, prefix) {
  const mcp = (byTool || []).filter((t) => typeof t.name === 'string' && t.name.startsWith(prefix));
  const sum = (k) => mcp.reduce((a, t) => a + (Number(t[k]) || 0), 0);
  const n = sum('count');
  const per = (x) => (n === 0 ? 0 : Math.floor(x / n));
  return {
    by_tool: mcp,
    calls_total: n,
    response_chars_total: sum('total_chars'),
    avg_response_chars: per(sum('total_chars')),
    p95_response_chars: mcp.length ? Math.max(...mcp.map((t) => Number(t.p95_chars) || 0)) : 0,
    total_ms: sum('total_ms'),
    avg_ms: per(sum('total_ms')),
    total_output_tokens: sum('total_output_tokens'),
    avg_output_tokens: per(sum('total_output_tokens')),
    total_tokens_est: sum('total_total_tokens_est'),
    avg_tokens_est: per(sum('total_total_tokens_est')),
  };
}

export function mqs({ chars, pass_rate, calls, duration_s }) {
  const cap = (v) => Math.min(100, v);
  const r1 = (v) => Math.round(v * 10) / 10;
  const token = chars > 0 ? cap((50 * MQS_BASELINE.chars) / chars) : 0;
  const reliability = cap((50 * (pass_rate || 0)) / MQS_BASELINE.pass_rate);
  const call = calls > 0 ? cap((50 * MQS_BASELINE.calls) / calls) : 0;
  const speed = duration_s > 0 ? cap((50 * MQS_BASELINE.duration_s) / duration_s) : 0;
  return {
    score: r1(0.35 * token + 0.3 * reliability + 0.2 * call + 0.15 * speed),
    token_score: r1(token), reliability_score: r1(reliability), call_score: r1(call), speed_score: r1(speed),
    baseline: MQS_BASELINE.id,
  };
}

export function nextRunNumber(files, slug) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}-run(\\d+)\\.json$`);
  let max = 0;
  for (const f of files) { const m = f.match(re); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

export function renderPrompt(template, { mcpName, exportPath, smoke }) {
  let p = template.replaceAll('{{MCP_NAME}}', mcpName).replaceAll('{{EXPORT_PATH}}', exportPath);
  if (smoke) {
    p += '\n\nSMOKE MODE (harness self-test): first, try exactly once to run the shell command `echo probe` with the Bash tool; ' +
      'if that is refused, just continue. Then do only T1.1 and T1.2, skip everything else, and export as described.';
  }
  return p;
}

// Nearest-rank percentile: sortieren, Index ceil(p/100 * n) - 1.
export function percentile(values, p) {
  const v = (values || []).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

const resultChars = (content) => {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((a, part) => a + (part?.type === 'text' && typeof part.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
};

const resultText = (content) => {
  if (typeof content === 'string') return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('').slice(0, 300);
  }
  return '';
};

// Parst eine Claude-Code-Session-JSONL. Feldform siehe measure-tool-calls.sh (dort massgeblich):
// tool_use in assistant-Zeilen, tool_result in user-Zeilen, Zuordnung ueber tool_use_id.
export function mcpCallsFromJsonl(jsonlText, prefix) {
  const calls = [];
  const results = new Map();
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    if (obj.type === 'assistant') {
      for (const c of content) {
        if (c?.type === 'tool_use' && typeof c.name === 'string' && c.name.startsWith(prefix)) {
          calls.push({ tool_use_id: c.id, name: c.name, timestamp: obj.timestamp || '' });
        }
      }
    } else if (obj.type === 'user') {
      for (const c of content) {
        if (c?.type === 'tool_result' && c.tool_use_id) {
          results.set(c.tool_use_id, { content: c.content, timestamp: obj.timestamp || '' });
        }
      }
    }
  }
  return calls.map((c) => {
    const r = results.get(c.tool_use_id);
    const t0 = Date.parse(c.timestamp);
    const t1 = r ? Date.parse(r.timestamp) : NaN;
    return {
      tool_use_id: c.tool_use_id,
      name: c.name,
      chars: r ? resultChars(r.content) : 0,
      ms: Number.isFinite(t0) && Number.isFinite(t1) ? Math.trunc(t1 - t0) : null,
      result_text: r ? resultText(r.content) : '',
    };
  });
}

// Prueft das Run-Export-JSON der Benchmark-Seite. Leeres Array = gueltig.
export function validateExport(exp) {
  const problems = [];
  if (exp === null || typeof exp !== 'object' || Array.isArray(exp)) return ['export is not an object'];
  const tests = exp.tests;
  if (tests === null || typeof tests !== 'object' || Array.isArray(tests)) {
    problems.push('tests is not an object');
  } else {
    for (const [id, t] of Object.entries(tests)) {
      if (!ALL_TESTS.includes(id)) { problems.push(`unknown test id ${id}`); continue; }
      if (t === null || typeof t !== 'object') { problems.push(`${id}: entry is not an object`); continue; }
      if (!STATUSES.includes(t.status)) problems.push(`${id}: invalid status ${JSON.stringify(t.status)}`);
      if (t.duration_ms !== undefined && t.duration_ms !== null
        && (!Number.isFinite(t.duration_ms) || t.duration_ms < 0)) problems.push(`${id}: invalid duration_ms`);
    }
  }
  if (exp.elapsed_s !== undefined && (!Number.isFinite(exp.elapsed_s) || exp.elapsed_s < 0)) problems.push('invalid elapsed_s');
  if (exp.timestamp !== undefined
    && (typeof exp.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(exp.timestamp) || Number.isNaN(Date.parse(exp.timestamp)))) {
    problems.push('invalid timestamp');
  }
  return problems;
}

export function compareTable(runs) {
  const blind = (runs || []).filter((r) => r?.harness?.mode === 'blind-print');
  const byName = (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.timestamp).localeCompare(String(b.timestamp));
  const rows = blind.filter((r) => r.harness.status === 'ok').sort(byName);
  const broken = blind.filter((r) => r.harness.status !== 'ok' && r.harness.status !== 'smoke').sort(byName);
  const runName = (r) => String(r.run_file || '').replace(/\.json$/, '');
  const head = [
    '| MCP | Version | Model | Date | Run | Status | Passed | Duration | MCP calls | Response total | Ø response | P95 | Snapshot tool Ø |',
    '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const lines = rows.map((r) => {
    const te = r.tool_efficiency || {};
    const snap = (te.by_tool || []).find((t) => t.name.endsWith('__' + r.snapshot_tool));
    const snapCell = snap ? `${snap.avg_chars} (${snap.count}×)` : '—';
    return `| ${r.name} | ${r.mcp_version} | ${r.model} | ${String(r.timestamp).slice(0, 10)} | ${runName(r)} | ${r.harness.status} | ${r.summary.passed}/${r.summary.counted} | ${r.summary.duration_s}s | ${te.calls_total} | ${Math.round((te.response_chars_total || 0) / 1000)}k | ${te.avg_response_chars} | ${te.p95_response_chars} | ${snapCell} |`;
  });
  const aborted = broken.length
    ? ['\n**Aborted or incomplete runs**', '| Run | MCP | Status | Note |', '|---|---|---|---|',
      ...broken.map((r) => `| ${runName(r)} | ${r.name} | ${r.harness.status} | ${r.notes ?? ''} |`)]
    : [];
  const tops = rows.map((r) => {
    const top = [...(r.tool_efficiency?.by_tool || [])].sort((a, b) => b.count - a.count).slice(0, 5)
      .map((t) => `| ${t.name} | ${t.count} | ${t.avg_chars} | ${t.p95_chars} |`);
    return [`\n**${r.name} ${r.mcp_version} — top tools**`, '| Tool | Calls | Ø chars | P95 chars |', '|---|---:|---:|---:|', ...top].join('\n');
  });
  return [...head, ...lines, ...aborted, ...tops].join('\n');
}

export function verifyRunJson(run) {
  const problems = [];
  for (const k of ['summary.counted', 'mqs.score', 'tool_efficiency.calls_total', 'mcp_version', 'model', 'harness.mode']) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), run);
    if (v === undefined || v === null) problems.push(`missing field ${k}`);
  }
  if (typeof run.model === 'string' && !/^claude-/.test(run.model)) problems.push(`model unknown: ${run.model}`);
  if (run.chrome_version === undefined || run.chrome_version === null) problems.push('chrome_version missing');
  const byTool = run.tool_efficiency?.by_tool || [];
  const nonMcp = byTool.filter((t) => !String(t.name).startsWith('mcp__')).map((t) => t.name);
  if (nonMcp.length) problems.push(`Non-MCP tools in by_tool: ${nonMcp.join(', ')}`);
  const expected = byTool.reduce((a, t) => a + (Number(t.count) || 0), 0);
  if (run.tool_efficiency && expected !== run.tool_efficiency.calls_total) {
    problems.push(`calls_total (${run.tool_efficiency.calls_total}) != sum(by_tool.count) (${expected})`);
  }
  if (run.harness?.status === 'ok') {
    if (!(run.tool_efficiency?.calls_total > 0)) problems.push('no MCP calls recorded for an ok run');
    const s = run.summary || {};
    const sum = (Number(s.passed) || 0) + (Number(s.failed) || 0) + (Number(s.not_run) || 0);
    if (sum !== s.counted) problems.push(`summary passed+failed+not_run (${sum}) != counted (${s.counted})`);
  }
  if (run.slug === 'public-browser') {
    if (!['kalt', 'warm'].includes(run.cortex?.mode)) problems.push('cortex.mode missing for public-browser');
    else if (typeof run.cortex?.patternCount !== 'number') problems.push('cortex.patternCount missing for public-browser');
  }
  return problems;
}

// CLI entry point is added in Task 2.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('usage: node blind-run.mjs run <slug> [--smoke] [--rundir <dir>] | compare');
}
