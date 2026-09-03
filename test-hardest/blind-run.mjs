#!/usr/bin/env node
// blind-run.mjs — blind benchmark harness for browser MCP servers.
// One fresh Claude Code print-mode session per run, exactly one MCP server, metrics measured
// post hoc from the session JSONL (measure-*.sh). See test-hardest/README.md.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    env: (rundir) => {
      const cortex = join(rundir, 'cortex');
      mkdirSync(cortex, { recursive: true });
      return {
        PUBLIC_BROWSER_CORTEX_DIR: cortex,
        PUBLIC_BROWSER_TELEMETRY: '0',
        PUBLIC_BROWSER_CHROME_PORT: '9333',
      };
    },
    snapshotTool: 'view_page',
    profile_isolation: 'auto-launched Chrome, fresh temp user-data-dir, CDP port 9333',
  },
  'playwright-mcp': {
    name: 'playwright', display: 'Playwright MCP', package: '@playwright/mcp', version: '0.0.80',
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--browser', 'chrome', '--isolated'],
    // Der Server meldet im initialize-Handshake seine Playwright-Version, nicht die Paketversion.
    serverVersion: '1.63.0-alpha-2026-08-31',
    env: (_rundir) => ({}),
    snapshotTool: 'browser_snapshot',
    profile_isolation: '--isolated (in-memory profile)',
  },
  'chrome-devtools-mcp': {
    name: 'chrome-devtools', display: 'Chrome DevTools MCP', package: 'chrome-devtools-mcp', version: '1.8.0',
    command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.8.0', '--isolated'],
    env: (_rundir) => ({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }),
    snapshotTool: 'take_snapshot',
    profile_isolation: '--isolated (temp user-data-dir)',
  },
  'browser-use': {
    name: 'browser-use', display: 'browser-use', package: 'browser-use', version: '0.12.5',
    command: process.env.BLIND_RUN_BROWSER_USE_BIN || '/Users/silbercue/.browser-use-env/bin/browser-use',
    args: ['--mcp'],
    // Der MCP-Server meldet im Handshake die Version seines MCP-Wrappers, nicht die des pip-Pakets (0.12.5).
    serverVersion: '0.1.0',
    env: (_rundir) => ({}),
    snapshotTool: 'browser_get_state',
    // --mcp wird in skill_cli/main.py vor dem Argparse abgefangen, alle anderen Flags (--profile, --session)
    // wirken dort nicht; mcp/server.py setzt user_data_dir fest auf ~/.config/browseruse/profiles/default.
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
  let p = template
    .replaceAll('{{MCP_NAME}}', mcpName)
    .replaceAll('{{EXPORT_PATH}}', exportPath)
    .replaceAll('{{SUITE_URL}}', SUITE_URL);
  if (smoke) {
    p += '\n\nSMOKE MODE (harness self-test): first, try exactly once to run the shell command `echo probe` with the Bash tool; ' +
      'if that is refused, just continue. Then do only T1.1 and T1.2, skip everything else, and export as described.';
  }
  return p;
}

// Nearest-rank percentile: sortieren, Index ceil(p/100 * n) - 1.
// Diese JS-Definition ist massgeblich fuer die Perzentile, die Task 2 fuers Run-JSON rechnet.
// measure-tool-calls.sh rechnet anders (jq: floor((n-1) * p)) — die beiden Werte koennen abweichen.
export function percentile(values, p) {
  const v = (values || []).map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[idx];
}

// chars wie in measure-tool-calls.sh (`.content | tostring | length`): Strings zaehlen roh,
// alles andere als kompaktes JSON. Damit teilen Skript-Summen und JS-Perzentile eine Basis.
const resultChars = (content) => {
  if (typeof content === 'string') return content.length;
  return JSON.stringify(content ?? null).length;
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
  if (exp.timestamp === undefined) problems.push('timestamp missing');
  else if (typeof exp.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(exp.timestamp) || Number.isNaN(Date.parse(exp.timestamp))) {
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
  if (!run || typeof run !== 'object' || Array.isArray(run)) return ['run is not an object'];
  const problems = [];
  for (const k of ['summary.counted', 'mqs.score', 'tool_efficiency.calls_total', 'mcp_version', 'model', 'harness.mode']) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), run);
    if (v === undefined || v === null) problems.push(`missing field ${k}`);
  }
  if (typeof run.model === 'string' && !/^claude-/.test(run.model)) problems.push(`model unknown: ${run.model}`);
  // browser-use startet seinen eigenen Browser: das /Applications-Binary ist dort nicht der gemessene Browser.
  if ((run.chrome_version === undefined || run.chrome_version === null) && run.slug !== 'browser-use') {
    problems.push('chrome_version missing');
  }
  const ids = run.suite?.test_ids;
  if (!Array.isArray(ids)) problems.push('suite.test_ids missing');
  else if (ids.length !== run.suite?.tests) problems.push(`suite.test_ids (${ids.length}) != suite.tests (${run.suite?.tests})`);
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

// ---------------------------------------------------------------------------
// Pipeline (Task 2): ein Lauf = frische Claude-Code-Print-Session mit genau
// einem MCP-Server, Messung post hoc aus der Session-JSONL.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_PIN = 'claude-opus-5';

export function defaultDeps() {
  return {
    claude: { file: process.env.BLIND_RUN_CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude'), argsPrefix: [] },
    chromeBin: process.env.BLIND_RUN_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    measureDir: HERE,
    resultsDir: process.env.BLIND_RUN_RESULTS_DIR || join(HERE, 'results'),
    projectsDir: null,          // null → aus envOverrides.HOME bzw. homedir() abgeleitet
    suiteFetch: (url) => fetch(url, { signal: AbortSignal.timeout(15000) }).then((r) => r.text()),
    now: () => new Date(),
    envOverrides: {},
  };
}

// Nur fuer Tests: einen zusaetzlichen Teilnehmer registrieren.
export function registerParticipant(slug, def) {
  PARTICIPANTS[slug] = def;
  return PARTICIPANTS[slug];
}

function sh(file, args, opts = {}) {
  return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function killGroup(pid, sig) {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* schon weg */ } }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// pgrep: Exit 1 = kein Treffer (leer), Exit >= 2 = echter Fehler (loggen, nicht verschlucken).
function pgrep(args) {
  try { return sh('pgrep', args); } catch (e) {
    if (e.status === 1) return '';
    console.error(`[blind-run] pgrep ${args.join(' ')} fehlgeschlagen (exit ${e.status}): ${String(e.stderr || e.message).trim()}`);
    return '';
  }
}

function chromeMainProcesses() {
  return pgrep(['-fl', '--', 'Google Chrome']).split('\n')
    .filter((l) => l.trim() && !l.includes('Helper') && !l.includes('--type='))
    .map((l) => { const m = l.match(/^(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), cmd: m[2].slice(0, 200) } : null; })
    .filter(Boolean);
}

function chromeProcessesOnPort(port) {
  return pgrep(['-f', '--', `--remote-debugging-port=${port}`]).split('\n').filter(Boolean);
}

function killChromeOnPort(port) {
  try { sh('pkill', ['-f', '--', `--remote-debugging-port=${port}`]); } catch (e) {
    if (e.status !== 1) console.error(`[blind-run] pkill Port ${port} fehlgeschlagen (exit ${e.status})`);
  }
}

function spawnWithTimeout(file, args, { cwd, env, timeoutMs, stderrFile }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const errStream = createWriteStream(stderrFile, { flags: 'a' });
    let stdout = '';
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.pipe(errStream);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 10_000).unref();
    }, timeoutMs);
    const done = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      errStream.end();
      resolve({ code, signal, stdout, timedOut, pid: child.pid, error: error || null });
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal));
  });
}

export function jsonlSlugFor(dir) {
  return realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-');
}

export function readModelFromJsonl(jsonlText) {
  const models = new Set();
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.includes('"assistant"')) continue;
    try { const m = JSON.parse(line)?.message?.model; if (m) models.add(m); } catch { /* kaputte Zeile */ }
  }
  const main = [...models].filter((m) => !m.includes('haiku'));
  return main[0] || [...models][0] || null;
}

export function cortexPatternCount(instructions) {
  const m = String(instructions || '').match(/Cortex:\s*(\d+)\s+patterns loaded/i);
  return m ? Number(m[1]) : null;
}

export function suiteFingerprint(html) {
  const text = String(html ?? '');
  const ids = [...new Set(text.match(/T\d\.\d+/g) || [])];
  const key = (id) => { const [l, n] = id.slice(1).split('.').map(Number); return l * 1000 + n; };
  ids.sort((a, b) => key(a) - key(b));
  return { html_sha256: createHash('sha256').update(text).digest('hex'), html_bytes: Buffer.byteLength(text), test_ids: ids };
}

// A2.6: MCP-Server mit initialize anpingen und serverInfo/instructions lesen.
export function probeServerInfo(participant, env = {}, deps = defaultDeps(), { timeoutMs = 90_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(participant.command, participant.args, {
      cwd: cwd || tmpdir(),          // nie im Repo-Root: npx wuerde sonst das lokale Paket ziehen
      env: { ...process.env, ...(deps?.envOverrides || {}), ...env },
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5_000).unref();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(
      () => finish(new Error(`MCP probe timeout after ${timeoutMs}ms (${participant.name}): ${stderr.slice(-300).trim()}`)),
      timeoutMs,
    );
    child.on('error', (e) => finish(new Error(`MCP probe spawn failed (${participant.command}): ${e.message}`)));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1) continue;
        if (msg.error) { finish(new Error(`MCP probe error: ${JSON.stringify(msg.error)}`)); return; }
        finish(null, {
          name: msg.result?.serverInfo?.name ?? null,
          version: msg.result?.serverInfo?.version ?? null,
          instructions: msg.result?.instructions ?? null,
        });
        return;
      }
    });
    child.on('close', () => finish(new Error(`MCP server exited before answering initialize (${participant.name}): ${stderr.slice(-300).trim()}`)));
    child.stdin.on('error', () => { /* Server schon weg — close/timeout greift */ });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'blind-run', version: '1' } },
    })}\n`);
  });
}

// A2.11: Sperr-Nachweis. Alles ausserhalb Write und mcp__<name>__* muss verweigert worden sein.
export function toolLockFromJsonl(jsonlText, mcpPrefix) {
  const denied = (t) => /denied|not allowed|permission|blocked/i.test(t || '');
  const outside = mcpCallsFromJsonl(jsonlText, '').filter((c) => c.name !== 'Write' && !c.name.startsWith(mcpPrefix));
  return {
    bash_attempted: outside.length,
    bash_denied: outside.length > 0 && outside.every((c) => denied(c.result_text)),
    non_mcp_executed: outside.filter((c) => !denied(c.result_text)).map((c) => c.name),
  };
}

// build(basename) liefert den Inhalt: so steht run_file schon im einzigen, atomaren wx-Schreibvorgang.
function writeResultFile(dir, slug, build) {
  let n = nextRunNumber(readdirSync(dir), slug);
  for (let i = 0; i < 20; i++, n++) {
    const out = join(dir, `${slug}-run${n}.json`);
    try { writeFileSync(out, build(basename(out)), { flag: 'wx' }); return out; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error(`no free result file name for ${slug} after 20 tries`);
}

export async function runParticipant(slug, opts = {}, deps = {}) {
  const p = PARTICIPANTS[slug];
  if (!p) throw new Error(`unknown slug ${slug}; known: ${Object.keys(PARTICIPANTS).join(', ')}`);
  const d = { ...defaultDeps(), ...deps };
  if (!deps.projectsDir) d.projectsDir = join(d.envOverrides?.HOME ?? homedir(), '.claude', 'projects');
  const smoke = !!opts.smoke;
  const now = d.now;
  const startedAt = now();
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);

  let rundir = opts.rundir;
  if (rundir) {
    if (existsSync(rundir) && readdirSync(rundir).length) throw new Error(`rundir not empty: ${rundir}`);
    mkdirSync(rundir, { recursive: true });
  } else {
    rundir = mkdtempSync(join('/tmp', `bench-${slug}-${stamp}-`));
  }

  const childEnv = { ...process.env, ...(d.envOverrides || {}) };
  const env = p.env(rundir);                       // genau einmal je Lauf, danach wiederverwendet
  const sessionId = randomUUID();
  const exportPath = join(rundir, 'run-export.json');
  const mcpPrefix = `mcp__${p.name}__`;
  const notes = [];
  // status.json-Phasen: starting → running → measuring → terminal. Terminal ist genau eine von
  // 'ok' (offizieller Lauf bestanden), 'smoke' (Smoke bestanden), 'aborted' (alles andere).
  const statusWrite = (phase, extra = {}) => writeFileSync(join(rundir, 'status.json'),
    `${JSON.stringify({ slug, session_id: sessionId, rundir, phase, updated: now().toISOString(), ...extra }, null, 2)}\n`);

  let serverInfo = null, cortexCount = null, suite = null, suiteOk = false;
  let claudeVer = null, chromeVer = null, chromeBefore = [], res = null, result = null;
  let exp = null, expProblems = ['export is not an object'], staleExport = false;
  let tools = null, cost = null, measureOk = false, model = null, mcpCalls = [];
  let toolLock = { bash_attempted: 0, bash_denied: false, non_mcp_executed: [] };
  let wallClockS = 0, flags = [], spawnedAt = null, jsonlSha = null;

  const model_requested = opts.model || MODEL_PIN;
  const allowedForm = opts.allowedToolsForm === 'glob' ? 'glob' : 'plain';
  const allowed = allowedForm === 'glob' ? ['Write', `mcp__${p.name}__*`] : ['Write', `mcp__${p.name}`];
  const timeoutMs = opts.timeoutMs ?? (smoke ? 8 * 60_000 : 45 * 60_000);

  // A2.2 (Codex #3): aeusserer Schutz um den GESAMTEN Lebenszyklus. Auch ein Fehler beim
  // Run-Aufbau, beim Schreiben der Ergebnisdatei oder beim terminalen Status hinterlaesst
  // best-effort ein Abbruch-JSON im Rundir und genau einen terminalen status.json.
  let terminal = false;
  try {
    console.log(`[blind-run] ${slug} → ${rundir} (session ${sessionId}, smoke=${smoke})`);
    statusWrite('starting', { started_at: startedAt.toISOString() });
    chromeBefore = chromeMainProcesses();          // Bestandsaufnahme vor allem, was wir selbst starten

    try {
      if (slug === 'public-browser' && chromeProcessesOnPort(9333).length) {
        throw new Error('Chrome on port 9333 already running — kill it first');
      }
      if (!existsSync(d.claude.file)) throw new Error(`claude binary not found: ${d.claude.file}`);
      if (!existsSync(d.chromeBin)) throw new Error(`chrome binary not found: ${d.chromeBin}`);
      claudeVer = sh(d.claude.file, [...d.claude.argsPrefix, '--version'], { env: childEnv }).trim().split(/\s+/)[0];
      if (!claudeVer) throw new Error('claude --version returned nothing');
      try { chromeVer = sh(d.chromeBin, ['--version']).trim().replace(/^Google Chrome /, ''); } catch { chromeVer = null; }

      writeFileSync(join(rundir, 'mcp.json'),
        `${JSON.stringify({ mcpServers: { [p.name]: { command: p.command, args: p.args, env } } }, null, 2)}\n`);

      serverInfo = await probeServerInfo(p, env, d, { cwd: rundir });
      const expectVersion = p.serverVersion ?? p.version;
      if (serverInfo.version !== expectVersion) {
        throw new Error(`version mismatch: ${p.name} reports ${serverInfo.version}, pinned ${expectVersion}`);
      }
      if (slug === 'public-browser') {
        cortexCount = cortexPatternCount(serverInfo.instructions);
        if (typeof cortexCount !== 'number') throw new Error('cortex pattern count missing in server instructions');
      }

      try {
        suite = suiteFingerprint(await d.suiteFetch(SUITE_URL));
        suiteOk = JSON.stringify(suite.test_ids) === JSON.stringify(ALL_TESTS);
        if (!suiteOk) throw new Error(`suite fingerprint mismatch: ${suite.test_ids.length} ids on the page, expected ${ALL_TESTS.length}`);
      } catch (e) {
        if (!smoke) throw e;
        notes.push(`suite fingerprint not verified: ${e.message}`);
      }

      const prompt = renderPrompt(readFileSync(join(HERE, 'blind-prompt.md'), 'utf8'),
        { mcpName: p.display, exportPath, smoke });
      if (prompt.includes('{{')) throw new Error(`prompt still contains placeholders: ${prompt.match(/\{\{[A-Z_]+\}\}/g)}`);
      writeFileSync(join(rundir, 'prompt.md'), prompt);

      // Tool-Sperre: --allowedTools allein sperrt nichts (auf dieser Maschine fuehrt die CLI
      // Bash auch unter --permission-mode dontAsk/manual aus). --tools Write nimmt das Werkzeug
      // aus dem Werkzeugkasten: das Modell bekommt neben den MCP-Tools nur noch Write.
      flags = ['--model', model_requested, '--output-format', 'json', '--session-id', sessionId,
        '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(rundir, 'mcp.json'),
        '--permission-mode', 'dontAsk', '--allowedTools', ...allowed, '--tools', 'Write',
        '--max-turns', '600'];

      spawnedAt = Date.now();
      statusWrite('running', { started_at: startedAt.toISOString(), flags: flags.join(' ') });
      res = await spawnWithTimeout(d.claude.file, [...d.claude.argsPrefix, '-p', prompt, ...flags],
        { cwd: rundir, env: childEnv, timeoutMs, stderrFile: join(rundir, 'claude.log') });
      wallClockS = Math.round((Date.now() - spawnedAt) / 1000);
      writeFileSync(join(rundir, 'result.json'), res.stdout || '');
      try { result = JSON.parse(res.stdout); } catch { result = null; }
      if (res.error) notes.push(`aborted: claude spawn failed: ${res.error.message}`);
      if (res.timedOut) notes.push('aborted: wall-clock limit');
      statusWrite('measuring', { exit_code: res.code, timed_out: res.timedOut, wall_clock_s: wallClockS });

      const jsonlSlug = jsonlSlugFor(rundir);
      const jsonlPath = join(d.projectsDir, jsonlSlug, `${sessionId}.jsonl`);
      const jsonlText = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf8') : '';
      jsonlSha = jsonlText ? createHash('sha256').update(jsonlText).digest('hex') : null;
      if (!jsonlText) notes.push(`aborted: session JSONL missing (${jsonlPath})`);
      model = readModelFromJsonl(jsonlText);
      mcpCalls = mcpCallsFromJsonl(jsonlText, mcpPrefix);
      toolLock = toolLockFromJsonl(jsonlText, mcpPrefix);

      if (existsSync(exportPath)) {
        try { exp = JSON.parse(readFileSync(exportPath, 'utf8')); } catch (e) { exp = null; notes.push(`aborted: export is not valid JSON: ${e.message}`); }
        expProblems = validateExport(exp);
        if (expProblems.length) notes.push(`aborted: invalid export: ${expProblems.join('; ')}`);
        const ts = exp && typeof exp.timestamp === 'string' ? Date.parse(exp.timestamp) : NaN;
        if (Number.isFinite(ts) && ts < startedAt.getTime() - 60_000) {
          staleExport = true;
          notes.push(`aborted: stale export (${exp.timestamp} older than run start ${startedAt.toISOString()})`);
        }
      } else {
        notes.push('aborted: no export written');
      }

      if (jsonlText) {
        try {
          tools = JSON.parse(sh('bash', [join(d.measureDir, 'measure-tool-calls.sh'), jsonlSlug, sessionId], { env: childEnv }));
          cost = JSON.parse(sh('bash', [join(d.measureDir, 'measure-session-cost.sh'), jsonlSlug, sessionId], { env: childEnv }));
          measureOk = true;
        } catch (e) {
          notes.push(`aborted: measurement failed: ${String(e.message).slice(0, 300)}`);
        }
      }
    } catch (e) {
      notes.push(`aborted: ${e.message}`);
    } finally {
      if (res?.pid && isAlive(res.pid)) {
        killGroup(res.pid, 'SIGTERM');
        setTimeout(() => killGroup(res.pid, 'SIGKILL'), 10_000).unref();
      }
      if (slug === 'public-browser') killChromeOnPort(9333);
    }

    const eff = mcpOnly(tools?.by_tool, mcpPrefix);
    const summary = { ...score(exp?.tests), duration_s: exp?.elapsed_s > 0 ? exp.elapsed_s : wallClockS };
    // Der Pin gilt auch auf dem Fallback-Pfad (--model opus): die JSONL muss claude-opus-5 melden.
    const modelOk = typeof model === 'string' && model.startsWith(MODEL_PIN);
    if (!model) notes.push('aborted: model not found in session JSONL');
    else if (!modelOk) notes.push(`aborted: model mismatch: ${model} (requested ${model_requested}, pinned ${MODEL_PIN})`);
    // Der Smoke-Prompt fordert genau einen Bash-Versuch an: taucht Bash trotzdem als
    // ausgefuehrter Call auf, ist die Sperre offen. Kein Call = das Werkzeug fehlte.
    const lockOk = toolLock.non_mcp_executed.length === 0;
    if (!lockOk) notes.push(`aborted: fairness violated, non-MCP tools executed: ${toolLock.non_mcp_executed.join(', ')}`);
    const executionOk = res?.code === 0 && !res?.timedOut && expProblems.length === 0 && !staleExport
      && modelOk && measureOk && lockOk && (smoke || suiteOk);
    const runStatus = executionOk ? (smoke ? 'smoke' : 'ok') : 'aborted';
    const complete = summary.not_run === 0;
    if (runStatus === 'ok' && !complete) {          // im Smoke sind 28 nicht gelaufene Tests der Normalfall
      notes.push(`incomplete: ${SCORABLE.filter((id) => !['pass', 'fail'].includes(exp?.tests?.[id]?.status)).join(',')}`);
    }
    const charsOf = mcpCalls.map((c) => c.chars);
    const msOf = mcpCalls.map((c) => c.ms).filter((x) => Number.isFinite(x));

    const run = {
      name: p.display, slug, type: 'mcp-llm',
      mcp_package: p.package, mcp_version: p.version, snapshot_tool: p.snapshotTool,
      mcp_server_info: serverInfo,
      model: model || 'unknown',
      chrome_version: slug === 'browser-use' ? null : chromeVer,
      session_id: sessionId, timestamp: startedAt.toISOString(),
      suite: { url: SUITE_URL, tests: ALL_TESTS.length, scorable: SCORABLE.length, excluded: EXCLUDED, schema_fallback: true,
        html_sha256: suite?.html_sha256 ?? null, html_bytes: suite?.html_bytes ?? null, fingerprint_ok: suiteOk,
        test_ids: suite?.test_ids ?? null },
      harness: {
        mode: 'blind-print', status: runStatus, complete,
        claude_code_version: claudeVer, os: `${process.platform} ${release()}`, node: process.version,
        profile_isolation: p.profile_isolation, model_requested,
        flags: flags.join(' ').split(sessionId).join('<session_id>'), allowed_tools_form: allowedForm,
        chrome_version_source: slug === 'browser-use'
          ? 'not-captured (browser-use launches its own browser)' : 'applications-binary',
        wall_clock_s: wallClockS, exit_code: res?.code ?? null, timed_out: res?.timedOut ?? false,
        num_turns: result?.num_turns ?? null, run_dir: rundir,
        tool_lock: toolLock,
        session_jsonl_sha256: jsonlSha,
        calls_ledger: mcpCalls.map((c, i) => ({
          i: i + 1, tool: c.name, chars: c.chars, ...(Number.isFinite(c.ms) ? { ms: c.ms } : {}),
        })),
      },
      summary,
      tokens: { start: 0, end: cost?.total?.all ?? null, delta: cost?.total?.all ?? null },
      cost_usd_list: result?.total_cost_usd ?? cost?.cost_usd ?? null,
      mqs: mqs({ chars: eff.response_chars_total, pass_rate: summary.pass_rate, calls: eff.calls_total, duration_s: summary.duration_s }),
      cortex: slug === 'public-browser'
        ? { mode: 'kalt', dir: env.PUBLIC_BROWSER_CORTEX_DIR, patternCount: cortexCount, note: 'community package only, fresh dir' }
        : null,
      tool_efficiency: {
        calls_total: eff.calls_total, response_chars_total: eff.response_chars_total,
        avg_response_chars: eff.avg_response_chars,
        p50_response_chars: percentile(charsOf, 50), p95_response_chars: percentile(charsOf, 95),
        p50_ms: percentile(msOf, 50), p95_ms: percentile(msOf, 95),
        avg_response_tokens_est: Math.floor(eff.avg_response_chars / 4),
        total_tokens_est: eff.total_tokens_est, avg_tokens_est: eff.avg_tokens_est,
        avg_ms: eff.avg_ms, total_ms: eff.total_ms,
        total_output_tokens: eff.total_output_tokens, avg_output_tokens: eff.avg_output_tokens,
        cache_read_tokens_total: tools?.summary?.cache_read_tokens_total ?? null,
        cache_creation_tokens_total: tools?.summary?.cache_creation_tokens_total ?? null,
        fresh_input_tokens_total: tools?.summary?.fresh_input_tokens_total ?? null,
        cache_hit_rate: tools?.summary?.cache_hit_rate ?? null,
        by_tool: eff.by_tool, per_test: null, segment: 'full',
        non_mcp_calls: (tools?.by_tool || []).filter((t) => !String(t.name).startsWith(mcpPrefix))
          .map((t) => ({ name: t.name, count: t.count })),
      },
      tests: exp?.tests ?? {},
      export_summary: exp?.summary ?? null,
      notes: notes.join(' | ') || (smoke ? 'smoke' : ''),
    };

    const problems = verifyRunJson(run);
    if (measureOk && mcpCalls.length !== eff.calls_total) {
      problems.push(`JSONL MCP calls (${mcpCalls.length}) != by_tool calls_total (${eff.calls_total})`);
    }

    const serialize = (name) => { run.run_file = name; return `${JSON.stringify(run, null, 2)}\n`; };
    let outPath;
    if (smoke) {
      outPath = join(rundir, 'run.json');
      writeFileSync(outPath, serialize(basename(outPath)));   // gleiches Schema wie beim offiziellen Lauf
    } else {
      mkdirSync(d.resultsDir, { recursive: true });
      outPath = writeResultFile(d.resultsDir, slug, serialize);
    }

    const leftovers = chromeMainProcesses().filter((c) => !chromeBefore.some((b) => b.pid === c.pid));
    statusWrite(runStatus === 'smoke' ? 'smoke' : runStatus,
      { out: outPath, problems, chrome_leftovers: leftovers, wall_clock_s: wallClockS });
    terminal = true;

    console.log([
      `Benchmark ${p.display} ${p.version} — ${runStatus}`,
      `Ergebnis: ${summary.passed}/${summary.counted} bestanden (${summary.pass_rate}%), ${summary.failed} fail, ${summary.not_run} nicht gelaufen`,
      `Dauer:    ${summary.duration_s}s (Seite) / ${wallClockS}s (Wall-Clock), Turns ${result?.num_turns ?? '?'}`,
      `Modell:   ${run.model} (angefordert ${model_requested})`,
      `Server:   ${serverInfo?.name ?? '?'} ${serverInfo?.version ?? '?'}${cortexCount === null ? '' : `, Cortex ${cortexCount} Patterns`}`,
      `MQS: ${run.mqs.score}  Token ${run.mqs.token_score} / Reliability ${run.mqs.reliability_score} / Calls ${run.mqs.call_score} / Speed ${run.mqs.speed_score}`,
      `MCP-Calls ${eff.calls_total}, Response ${Math.round(eff.response_chars_total / 1000)}k Chars, Ø ${eff.avg_response_chars}, P95 ${run.tool_efficiency.p95_response_chars}`,
      `Tool-Sperre: ${toolLock.bash_attempted} Versuche ausserhalb, denied=${toolLock.bash_denied}, ausgefuehrt: ${toolLock.non_mcp_executed.join(', ') || 'keine'}`,
      `Non-MCP-Calls: ${run.tool_efficiency.non_mcp_calls.map((t) => `${t.name}×${t.count}`).join(', ') || 'keine'}`,
      `Kosten (Listenpreis): $${run.cost_usd_list ?? '?'}`,
      `Rohdaten: ${outPath}`,
      run.notes ? `Notes: ${run.notes}` : 'Notes: —',
      problems.length ? `PROBLEME: ${problems.join(' | ')}` : 'Post-Write-Check: OK',
      leftovers.length ? `Chrome-Reste: ${leftovers.map((c) => `${c.pid} ${c.cmd.slice(0, 80)}`).join(' ; ')}` : 'Chrome-Reste: keine',
    ].join('\n'));
    return { run, outPath, problems, rundir, childPid: res?.pid ?? null };
  } catch (e) {
    try {
      writeFileSync(join(rundir, 'run-aborted.json'),
        `${JSON.stringify({ slug, session_id: sessionId, rundir, error: String(e?.message ?? e), notes }, null, 2)}\n`);
    } catch { /* best effort */ }
    throw e;
  } finally {
    if (!terminal) { try { statusWrite('aborted', { reason: 'lifecycle error' }); } catch { /* best effort */ } }
  }
}

export function compareFromResults(dir = defaultDeps().resultsDir) {
  const runs = readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => ({ ...JSON.parse(readFileSync(join(dir, f), 'utf8')), run_file: f }));
  return compareTable(runs);
}

const USAGE = 'usage: node blind-run.mjs run <slug> [--smoke] [--rundir <dir>] [--allowed-tools-form plain|glob] '
  + '[--model <id>] [--timeout-min <n>] | compare';

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'run') {
    const slug = rest[0];
    const timeoutMin = opt('--timeout-min');
    const { run, problems } = await runParticipant(slug, {
      smoke: rest.includes('--smoke'),
      rundir: opt('--rundir'),
      allowedToolsForm: opt('--allowed-tools-form'),
      model: opt('--model'),
      timeoutMs: timeoutMin ? Number(timeoutMin) * 60_000 : undefined,
    });
    // Exit 2 auch bei Post-Write-Problemen, damit eine Skript-Kette sie nicht uebersieht.
    process.exit(['ok', 'smoke'].includes(run.harness.status) && problems.length === 0 ? 0 : 2);
  } else if (cmd === 'compare') {
    console.log(compareFromResults(opt('--dir')));
  } else {
    console.log(USAGE);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(2); });
}
