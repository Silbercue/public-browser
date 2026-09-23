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
const CHROME_BIN = process.env.BLIND_RUN_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const PARTICIPANTS = {
  'public-browser': {
    name: 'public-browser', display: 'Public Browser', package: 'public-browser', version: '2.10.6',
    command: 'npx', args: ['-y', 'public-browser@2.10.6'],
    env: (rundir) => {
      const cortex = join(rundir, 'cortex');
      mkdirSync(cortex, { recursive: true });
      return {
        PUBLIC_BROWSER_CORTEX_DIR: cortex,
        PUBLIC_BROWSER_TELEMETRY: '0',
        PUBLIC_BROWSER_CHROME_PORT: '9333',
      };
    },
    // Wird nur bei --headless gemerged; Teilnehmer ohne dieses Feld haben keinen headless-Schalter.
    headlessEnv: { SILBERCUE_CHROME_HEADLESS: '1' },
    snapshotTool: 'view_page',
    profile_isolation: 'auto-launched Chrome, fresh temp user-data-dir, CDP port 9333',
  },
  'playwright-mcp': {
    name: 'playwright', display: 'Playwright MCP', package: '@playwright/mcp', version: '0.0.82',
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.82', '--browser', 'chrome', '--isolated'],
    // Der Server meldet im initialize-Handshake seine Playwright-Version, nicht die Paketversion.
    serverVersion: '1.64.0-alpha-1789764292000',
    env: (_rundir) => ({}),
    snapshotTool: 'browser_snapshot',
    profile_isolation: '--isolated (in-memory profile)',
  },
  'chrome-devtools-mcp': {
    name: 'chrome-devtools', display: 'Chrome DevTools MCP', package: 'chrome-devtools-mcp', version: '1.9.0',
    command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.9.0', '--isolated'],
    env: (_rundir) => ({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }),
    snapshotTool: 'take_snapshot',
    profile_isolation: '--isolated (temp user-data-dir)',
  },
  'browser-use': {
    name: 'browser-use', display: 'browser-use', package: 'browser-use', version: '0.13.10',
    // Eigene venv je gepinnter Version: ~/.browser-use-env (0.12.5, Lauf 2026-09-03) bleibt unangetastet.
    command: process.env.BLIND_RUN_BROWSER_USE_BIN || '/Users/silbercue/.browser-use-0.13.10-env/bin/browser-use',
    args: ['--mcp'],
    // Seit 0.13 meldet der MCP-Server im Handshake die pip-Paketversion (0.12.5 meldete fest 0.1.0),
    // damit prueft der Handshake-Check jetzt die echte Paketversion — kein serverVersion-Alias mehr noetig.
    // --mcp wird vor dem Argparse abgefangen (0.12: skill_cli/main.py, 0.13: cli.py), CLI-Flags wie --profile
    // wirken dort nicht. Der Hebel ist die Config-Datei: BROWSER_USE_CONFIG_PATH zeigt auf eine Lauf-eigene
    // config.json, deren Default-Profil die Server-Defaults ueberschreibt. Seit 0.13 bevorzugt browser-use ohne
    // executable_path das Playwright-Chromium (0.12.5 nahm zuerst /Applications/Google Chrome) — deshalb Chrome
    // fest vorgeben wie bei den anderen Teilnehmern, dazu ein frisches user_data_dir im Rundir.
    env: (rundir) => {
      const configPath = join(rundir, 'browser-use-config.json');
      writeFileSync(configPath, `${JSON.stringify({
        browser_profile: {
          'blind-run': {
            id: 'blind-run', default: true, created_at: '1970-01-01T00:00:00',
            headless: false, executable_path: CHROME_BIN, user_data_dir: join(rundir, 'browser-use-profile'),
          },
        },
        llm: {}, agent: {},
      }, null, 2)}\n`);
      return { BROWSER_USE_CONFIG_PATH: configPath };
    },
    snapshotTool: 'browser_get_state',
    profile_isolation: 'executable_path /Applications Google Chrome, fresh empty user_data_dir (browser-use copies it to a temp dir), via BROWSER_USE_CONFIG_PATH',
  },
  // CLI-Teilnehmer: kein MCP-Server, sondern ein Kommandozeilenwerkzeug plus offizielle Skill-Datei.
  // Das Modell bekommt Bash, aber ein PreToolUse-Hook (cli-guard.mjs) laesst nur diesen einen Befehl durch;
  // die Skill-Datei geht per --append-system-prompt-file in den Systemprompt (Gegenstueck zu den
  // MCP-Handshake-Instructions). Binaries kommen aus BLIND_RUN_CLI_BIN_DIR (node_modules/.bin einer
  // Wegwerf-Installation), die Skill-Datei liegt relativ dazu im Paket.
  'agent-browser': {
    kind: 'cli', name: 'agent-browser', cli: 'agent-browser', display: 'agent-browser', package: 'agent-browser', version: '0.38.1',
    skillPath: ['agent-browser', 'skills', 'agent-browser', 'SKILL.md'],
    env: (rundir, deps = defaultDeps()) => ({
      AGENT_BROWSER_EXECUTABLE_PATH: deps.chromeBin,
      AGENT_BROWSER_HEADED: '1',
      AGENT_BROWSER_SESSION: basename(rundir),
    }),
    cleanupArgs: ['close'],
    snapshotTool: 'snapshot',
    profile_isolation: 'agent-browser default: fresh temp user-data-dir per launch, own session, headed, /Applications Chrome via AGENT_BROWSER_EXECUTABLE_PATH',
  },
  'playwright-cli': {
    kind: 'cli', name: 'playwright-cli', cli: 'playwright-cli', display: 'Playwright CLI', package: '@playwright/cli', version: '0.1.21',
    skillPath: ['@playwright', 'cli', 'skills', 'playwright-cli', 'SKILL.md'],
    env: (rundir) => ({ PLAYWRIGHT_CLI_SESSION: basename(rundir) }),
    // Die CLI liest .playwright/cli.config.json aus dem cwd (= Rundir): Chrome-Channel, headed, In-Memory-Profil
    // wie beim MCP-Geschwister (--browser chrome --isolated).
    setup: (rundir) => {
      mkdirSync(join(rundir, '.playwright'), { recursive: true });
      writeFileSync(join(rundir, '.playwright', 'cli.config.json'), `${JSON.stringify({
        browser: { browserName: 'chromium', isolated: true, launchOptions: { channel: 'chrome', headless: false } },
      }, null, 2)}\n`);
    },
    cleanupArgs: ['close'],
    snapshotTool: 'snapshot',
    profile_isolation: 'isolated in-memory profile, channel chrome, headed (.playwright/cli.config.json in the run dir)',
  },
};

// LLM-Provider-Keys duerfen weder die Claude-Session (laeuft ueber das Abo) noch die Teilnehmer erreichen:
// sonst ruft ein Werkzeug still ein fremdes Modell auf (browser-use nutzte 2026-09-23 so GPT-4o), das kostet
// und verfaelscht den Vergleich.
const PROVIDER_KEY = /^(BROWSERBASE_.*|.*_API_KEY|ANTHROPIC_AUTH_TOKEN|AZURE_OPENAI_.*|OPENAI_.*KEY.*)$/;
export function scrubProviderKeys(env) {
  return Object.fromEntries(Object.entries(env || {}).filter(([k]) => !PROVIDER_KEY.test(k)));
}

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

// Claude Codes eigene Session-Summe (result.usage aus --output-format json): Gegenprobe zu tokens.delta.
// Stimmt, solange das Transkript jede Modellantwort enthaelt (browser-use-run7: beide 52.868.834).
export function usageTotal(u) {
  if (!u || typeof u !== 'object') return null;
  return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)
    + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
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

export function renderPrompt(template, { mcpName, exportPath, smoke, cliCommand }) {
  let p = template
    .replaceAll('{{MCP_NAME}}', mcpName)
    .replaceAll('{{CLI_COMMAND}}', cliCommand ?? '')
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
function parseToolCalls(jsonlText) {
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
        if (c?.type === 'tool_use' && typeof c.name === 'string') {
          calls.push({ tool_use_id: c.id, name: c.name, input: c.input ?? null, timestamp: obj.timestamp || '',
            output_tokens: Number(obj.message?.usage?.output_tokens) || 0 });
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
      ...c,
      chars: r ? resultChars(r.content) : 0,
      ms: Number.isFinite(t0) && Number.isFinite(t1) ? Math.trunc(t1 - t0) : null,
      result_text: r ? resultText(r.content) : '',
    };
  });
}

export function mcpCallsFromJsonl(jsonlText, prefix) {
  return parseToolCalls(jsonlText).filter((c) => c.name.startsWith(prefix)).map((c) => ({
    tool_use_id: c.tool_use_id, name: c.name, chars: c.chars, ms: c.ms, result_text: c.result_text,
  }));
}

// CLI-Teilnehmer: eine Bash-Zeile ist nur erlaubt, wenn JEDES Segment (getrennt durch &&, ||, |, &, ;
// oder Zeilenumbruch) mit dem CLI-Befehl beginnt. Kommando-Substitution und Datei-Umleitungen sind
// gesperrt (ausser 2>&1), Env-Praefixe auch — sonst liesse sich z. B. das Browser-Binary umbiegen.
export function cliCommandAllowed(command, cli) {
  const text = String(command ?? '');
  const segments = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (q === "'") { cur += ch; if (ch === "'") q = null; continue; }
    if (ch === '\\') { cur += ch + (next ?? ''); i++; continue; }
    if (ch === '`' || (ch === '$' && next === '(')) return false;
    if (q === '"') { cur += ch; if (ch === '"') q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '>' && next === '&' && /\d/.test(text[i + 2] ?? '')) { cur += text.slice(i, i + 3); i += 2; continue; }
    if (ch === '>' || ch === '<') return false;
    if ((ch === '&' || ch === '|') && next === ch) { segments.push(cur); cur = ''; i++; continue; }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') { segments.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (q) return false;
  segments.push(cur);
  const head = new RegExp(`^${cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return segments.every((s) => head.test(s.trim()));
}

const CLI_VALUE_FLAGS = new Set(['--session', '-s', '--profile', '--config', '--executable-path', '--cdp', '--state', '--engine', '-p']);

function cliSubcommand(command) {
  if (/&&|\|\||[|;&\n]/.test(String(command).replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '').replace(/\d>&\d/g, ''))) return 'batch';
  const tokens = String(command).trim().split(/\s+/).slice(1);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) { if (!t.includes('=') && CLI_VALUE_FLAGS.has(t)) i++; continue; }
    return /^[a-z][a-z0-9_-]*$/i.test(t) ? t.toLowerCase() : 'other';
  }
  return 'none';
}

export function cliCallsFromJsonl(jsonlText, cli) {
  return parseToolCalls(jsonlText)
    .filter((c) => c.name === 'Bash' && cliCommandAllowed(c.input?.command, cli))
    .map((c) => ({
      tool_use_id: c.tool_use_id, name: `cli__${cli}__${cliSubcommand(c.input.command)}`,
      chars: c.chars, ms: c.ms, output_tokens: c.output_tokens, result_text: c.result_text,
    }));
}

// by_tool-Zeilen aus Einzel-Calls, Felder und Perzentil-Definition wie measure-tool-calls.sh
// (floor((n-1) * p) auf der sortierten Liste). Fuer CLI-Teilnehmer, deren Calls alle "Bash" heissen.
export function byToolFromCalls(calls) {
  const groups = new Map();
  for (const c of calls || []) {
    if (!groups.has(c.name)) groups.set(c.name, []);
    groups.get(c.name).push(c);
  }
  const pct = (vals, p) => { const v = [...vals].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) * p)] : 0; };
  const rows = [...groups.entries()].map(([name, g]) => {
    const n = g.length;
    const chars = g.map((c) => Number(c.chars) || 0);
    const ms = g.map((c) => (Number.isFinite(c.ms) ? c.ms : 0));
    const out = g.map((c) => Number(c.output_tokens) || 0);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const est = g.map((c, i) => out[i] + Math.floor(chars[i] / 4));
    return {
      name, count: n,
      total_chars: sum(chars), avg_chars: Math.floor(sum(chars) / n), p95_chars: pct(chars, 0.95), max_chars: Math.max(...chars),
      avg_ms: Math.floor(sum(ms) / n), p50_ms: pct(ms, 0.5), p95_ms: pct(ms, 0.95), max_ms: Math.max(...ms), total_ms: sum(ms),
      avg_output_tokens: Math.floor(sum(out) / n), total_output_tokens: sum(out),
      avg_total_tokens_est: Math.floor(sum(est) / n), total_total_tokens_est: sum(est),
    };
  });
  return rows.sort((a, b) => b.count - a.count);
}

// Neue Browser-Hauptprozesse aus `ps -axo pid=,command=`. Belegt je Lauf, welches Binary lief;
// alles ausser dem /Applications-Chrome landet in non_chrome.
export function browserBinaries(psText, beforePids, chromeBin) {
  const before = new Set(beforePids || []);
  const pids = [];
  const bins = new Set();
  const browserName = /^(Google Chrome( Beta| Dev| Canary| for Testing)?|Chromium|chrome|chromium|chrome-headless-shell|headless_shell)$/;
  for (const line of String(psText || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m || m[2].includes('--type=')) continue;
    const cmd = m[2];
    const app = cmd.match(/^(.*?\.app\/Contents\/MacOS\/[^/]+?)(?=\s+-|\s*$)/);
    const exe = app ? app[1] : cmd.split(/\s+/)[0];
    if (!browserName.test(basename(exe))) continue;
    const pid = Number(m[1]);
    if (before.has(pid)) continue;
    pids.push(pid);
    bins.add(exe);
  }
  const binaries = [...bins];
  return { pids, binaries, non_chrome: binaries.filter((b) => b !== chromeBin) };
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
    '| MCP | Version | Model | Date | Run | Status | Passed | Duration | Rounds | Tokens | MCP calls | Response total | Ø response | P95 | Snapshot tool Ø |',
    '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const lines = rows.map((r) => {
    const te = r.tool_efficiency || {};
    const snap = (te.by_tool || []).find((t) => t.name.endsWith('__' + r.snapshot_tool));
    const snapCell = snap ? `${snap.avg_chars} (${snap.count}×)` : '—';
    // Nur entdoppelte Werte zeigen (tokens.dedup): die alte Zaehlung pro JSONL-Zeile lag 24–73 % zu hoch.
    const tk = r.tokens?.dedup === 'message.id' ? r.tokens : null;
    const rounds = Number.isFinite(tk?.rounds) ? tk.rounds : '—';
    const tokens = Number.isFinite(tk?.delta) ? `${(tk.delta / 1e6).toFixed(2)}M` : '—';
    return `| ${r.name} | ${r.mcp_version} | ${r.model} | ${String(r.timestamp).slice(0, 10)} | ${runName(r)} | ${r.harness.status} | ${r.summary.passed}/${r.summary.counted} | ${r.summary.duration_s}s | ${rounds} | ${tokens} | ${te.calls_total} | ${Math.round((te.response_chars_total || 0) / 1000)}k | ${te.avg_response_chars} | ${te.p95_response_chars} | ${snapCell} |`;
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
  const nonMcp = byTool.filter((t) => !/^(mcp|cli)__/.test(String(t.name))).map((t) => t.name);
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
    chromeBin: CHROME_BIN,
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

// Lokaler Build statt npm-Pin: fuer die Abnahme einer ungekuerzten/gekuerzten Arbeitskopie.
// Gleicher Slug, gleicher MCP-Name — alle public-browser-Pruefungen (Port 9333, Cortex-Zaehler) greifen.
export function localParticipant(repoRoot) {
  const entry = join(repoRoot, 'build', 'index.js');
  if (!existsSync(entry)) throw new Error(`local build missing: ${entry} — run npm run build first`);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  let gitHead = null, gitDirty = null;
  try {
    gitHead = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    gitDirty = execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== '';
  } catch { /* kein git */ }
  return {
    ...PARTICIPANTS['public-browser'],
    version: pkg.version,
    command: process.execPath,
    args: [entry],
    local: true,
    git_head: gitHead,
    git_dirty: gitDirty,
    profile_isolation: `${PARTICIPANTS['public-browser'].profile_isolation}; local build ${gitHead ?? '?'}`,
  };
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
      env: scrubProviderKeys({ ...process.env, ...(deps?.envOverrides || {}), ...env }),
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
// Mit `cli` (CLI-Teilnehmer) zaehlt als eigen nur ein Bash-Call, den cliCommandAllowed durchlaesst.
export function toolLockFromJsonl(jsonlText, mcpPrefix, cli) {
  const denied = (t) => /denied|not allowed|permission|blocked/i.test(t || '');
  const own = (c) => (cli ? c.name === 'Bash' && cliCommandAllowed(c.input?.command, cli) : c.name.startsWith(mcpPrefix));
  const outside = parseToolCalls(jsonlText).filter((c) => c.name !== 'Write' && !own(c));
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
  const isCli = p.kind === 'cli';
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

  const childEnv = scrubProviderKeys({ ...process.env, ...(d.envOverrides || {}) });
  const headlessRequested = !!opts.headless;
  // headless ist wahr, wenn die Env wirklich gesetzt wurde — nicht schon, wenn sie gewuenscht war.
  const headless = headlessRequested && !!p.headlessEnv;
  // genau einmal je Lauf gebaut, danach wiederverwendet (Probe, mcp.json, Cortex-Block)
  const env = { ...p.env(rundir, d), ...(headless ? p.headlessEnv : {}) };
  // CLI-Teilnehmer: das Werkzeug laeuft in der Bash der Claude-Session, also gehoeren Env und PATH dorthin.
  const cliBinDir = isCli ? (p.binDir || process.env.BLIND_RUN_CLI_BIN_DIR || null) : null;
  const cliBin = cliBinDir ? join(cliBinDir, p.cli) : null;
  const sessionEnv = isCli ? { ...childEnv, ...env, PATH: `${cliBinDir}:${childEnv.PATH ?? ''}` } : childEnv;
  const psList = d.psList || (() => sh('ps', ['-axo', 'pid=,command=']));
  const browsersSeen = { pids: new Set(), binaries: new Set() };
  let browserBefore = [];
  const sampleBrowsers = () => {
    try {
      const r = browserBinaries(psList(), browserBefore, d.chromeBin);
      r.pids.forEach((x) => browsersSeen.pids.add(x));
      r.binaries.forEach((x) => browsersSeen.binaries.add(x));
    } catch { /* ps nicht verfuegbar — Beleg fehlt dann, Lauf geht weiter */ }
  };
  const sessionId = randomUUID();
  const exportPath = join(rundir, 'run-export.json');
  const mcpPrefix = isCli ? `cli__${p.cli}__` : `mcp__${p.name}__`;
  const notes = [];
  if (headlessRequested && !headless) notes.push('--headless ignored: participant has no headless switch');
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
    try { browserBefore = browserBinaries(psList(), [], d.chromeBin).pids; } catch { browserBefore = []; }

    try {
      if (slug === 'public-browser' && chromeProcessesOnPort(9333).length) {
        throw new Error('Chrome on port 9333 already running — kill it first');
      }
      if (!existsSync(d.claude.file)) throw new Error(`claude binary not found: ${d.claude.file}`);
      if (!existsSync(d.chromeBin)) throw new Error(`chrome binary not found: ${d.chromeBin}`);
      claudeVer = sh(d.claude.file, [...d.claude.argsPrefix, '--version'], { env: childEnv }).trim().split(/\s+/)[0];
      if (!claudeVer) throw new Error('claude --version returned nothing');
      try { chromeVer = sh(d.chromeBin, ['--version']).trim().replace(/^Google Chrome /, ''); } catch { chromeVer = null; }

      if (isCli) {
        if (!cliBinDir) throw new Error(`${slug}: set BLIND_RUN_CLI_BIN_DIR to the node_modules/.bin holding ${p.cli}@${p.version}`);
        if (!existsSync(cliBin)) throw new Error(`cli binary not found: ${cliBin}`);
        const verOut = sh(cliBin, ['--version'], { env: sessionEnv, cwd: rundir }).trim();
        const skillFile = typeof p.skillPath === 'string' ? p.skillPath : join(dirname(cliBinDir), ...p.skillPath);
        const skillText = readFileSync(skillFile, 'utf8');
        writeFileSync(join(rundir, 'skill.md'), skillText);
        serverInfo = {
          name: p.cli, version: (verOut.match(/\d+\.\d+\.\d+[^\s]*/g) || []).pop() ?? null, instructions: null,
          skill_file: skillFile, skill_sha256: createHash('sha256').update(skillText).digest('hex'), skill_chars: skillText.length,
        };
        p.setup?.(rundir, d);
        writeFileSync(join(rundir, 'mcp.json'), `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
      } else {
        writeFileSync(join(rundir, 'mcp.json'),
          `${JSON.stringify({ mcpServers: { [p.name]: { command: p.command, args: p.args, env } } }, null, 2)}\n`);
        serverInfo = await probeServerInfo(p, env, d, { cwd: rundir });
      }
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

      const prompt = renderPrompt(readFileSync(join(HERE, isCli ? 'blind-prompt-cli.md' : 'blind-prompt.md'), 'utf8'),
        { mcpName: p.display, exportPath, smoke, cliCommand: p.cli });
      if (prompt.includes('{{')) throw new Error(`prompt still contains placeholders: ${prompt.match(/\{\{[A-Z_]+\}\}/g)}`);
      writeFileSync(join(rundir, 'prompt.md'), prompt);

      // Tool-Sperre: --allowedTools allein sperrt nichts (auf dieser Maschine fuehrt die CLI
      // Bash auch unter --permission-mode dontAsk/manual aus). --tools Write nimmt das Werkzeug
      // aus dem Werkzeugkasten: das Modell bekommt neben den MCP-Tools nur noch Write.
      // CLI: --allowedTools allein reicht nicht (Claude Code gibt "read-only"-Befehle wie echo/cat/ls auch
      // unter dontAsk frei, gemessen 2026-09-23). Der PreToolUse-Hook verweigert jede Bash-Zeile, die nicht
      // ausschliesslich aus dem CLI-Befehl besteht.
      const guard = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command',
        command: `"${process.execPath}" "${join(HERE, 'cli-guard.mjs')}" ${p.cli}` }] }] } };
      flags = isCli
        ? ['--model', model_requested, '--output-format', 'json', '--session-id', sessionId,
          '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(rundir, 'mcp.json'),
          '--permission-mode', 'dontAsk', '--allowedTools', `Bash(${p.cli}:*)`, 'Write', '--tools', 'Bash,Write',
          '--settings', JSON.stringify(guard), '--append-system-prompt-file', join(rundir, 'skill.md'),
          '--max-turns', '600']
        : ['--model', model_requested, '--output-format', 'json', '--session-id', sessionId,
          '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', join(rundir, 'mcp.json'),
          '--permission-mode', 'dontAsk', '--allowedTools', ...allowed, '--tools', 'Write',
          '--max-turns', '600'];

      spawnedAt = Date.now();
      statusWrite('running', { started_at: startedAt.toISOString(), flags: flags.join(' ') });
      const sampler = setInterval(sampleBrowsers, 3000);
      try {
        res = await spawnWithTimeout(d.claude.file, [...d.claude.argsPrefix, '-p', prompt, ...flags],
          { cwd: rundir, env: sessionEnv, timeoutMs, stderrFile: join(rundir, 'claude.log') });
      } finally {
        clearInterval(sampler);
        sampleBrowsers();
      }
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
      mcpCalls = isCli ? cliCallsFromJsonl(jsonlText, p.cli) : mcpCallsFromJsonl(jsonlText, mcpPrefix);
      toolLock = toolLockFromJsonl(jsonlText, mcpPrefix, isCli ? p.cli : undefined);

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
      if (isCli && cliBin && existsSync(cliBin) && p.cleanupArgs) {
        try { sh(cliBin, p.cleanupArgs, { cwd: rundir, env: sessionEnv, timeout: 30_000 }); } catch (e) {
          notes.push(`cli cleanup failed: ${String(e.message).slice(0, 120)}`);
        }
      }
    }

    const eff = mcpOnly(isCli ? byToolFromCalls(mcpCalls) : tools?.by_tool, mcpPrefix);
    // Harte Regel: gemessen wird nur mit echtem Google Chrome. browser-use bringt seinen Browser selbst mit
    // und wird hier nur protokolliert.
    const browserSeen = { binaries: [...browsersSeen.binaries], non_chrome: [...browsersSeen.binaries].filter((b) => b !== d.chromeBin) };
    const browserOk = browserSeen.non_chrome.length === 0 || slug === 'browser-use';
    if (!browserOk) notes.push(`aborted: non-Google-Chrome browser process seen: ${browserSeen.non_chrome.join(', ')}`);
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
      && modelOk && measureOk && lockOk && browserOk && (smoke || suiteOk);
    const runStatus = executionOk ? (smoke ? 'smoke' : 'ok') : 'aborted';
    const complete = summary.not_run === 0;
    if (runStatus === 'ok' && !complete) {          // im Smoke sind 28 nicht gelaufene Tests der Normalfall
      notes.push(`incomplete: ${SCORABLE.filter((id) => !['pass', 'fail'].includes(exp?.tests?.[id]?.status)).join(',')}`);
    }
    const charsOf = mcpCalls.map((c) => c.chars);
    const msOf = mcpCalls.map((c) => c.ms).filter((x) => Number.isFinite(x));
    // Kosten nur aus Claude Codes Ergebnis-JSON (total_cost_usd). Fehlt es (Timeout, Absturz), bleibt der Wert
    // leer: measure-session-cost.sh rechnet mit festen April-Preisen und wuerde raten.
    const costKnown = Number.isFinite(result?.total_cost_usd);
    if (!costKnown) notes.push('cost unknown: no result usage');

    const run = {
      name: p.display, slug, type: 'mcp-llm',
      mcp_package: p.package, mcp_version: p.version, snapshot_tool: p.snapshotTool,
      mcp_server_info: serverInfo,
      model: model || 'unknown',
      chrome_version: chromeVer,
      session_id: sessionId, timestamp: startedAt.toISOString(),
      suite: { url: SUITE_URL, tests: ALL_TESTS.length, scorable: SCORABLE.length, excluded: EXCLUDED, schema_fallback: true,
        html_sha256: suite?.html_sha256 ?? null, html_bytes: suite?.html_bytes ?? null, fingerprint_ok: suiteOk,
        test_ids: suite?.test_ids ?? null },
      harness: {
        mode: 'blind-print', kind: p.kind ?? 'mcp', status: runStatus, complete, headless, headless_requested: headlessRequested,
        browser_binaries: browserSeen.binaries, browser_non_chrome: browserSeen.non_chrome,
        local_build: !!p.local, git_head: p.git_head ?? null, git_dirty: p.git_dirty ?? null,
        claude_code_version: claudeVer, os: `${process.platform} ${release()}`, node: process.version,
        profile_isolation: p.profile_isolation, model_requested,
        flags: flags.join(' ').split(sessionId).join('<session_id>'), allowed_tools_form: allowedForm,
        chrome_version_source: slug === 'browser-use'
          ? 'applications-binary (browser-use executable_path pinned)' : 'applications-binary',
        wall_clock_s: wallClockS, exit_code: res?.code ?? null, timed_out: res?.timedOut ?? false,
        num_turns: result?.num_turns ?? null, run_dir: rundir,
        tool_lock: toolLock,
        session_jsonl_sha256: jsonlSha,
        calls_ledger: mcpCalls.map((c, i) => ({
          i: i + 1, tool: c.name, chars: c.chars, ...(Number.isFinite(c.ms) ? { ms: c.ms } : {}),
        })),
      },
      summary,
      // Aus measure-session-cost.sh (entdoppelt ueber message.id). cost_usd_list kommt aus Claude Codes
      // total_cost_usd, mqs.token_score aus Antwort-Zeichen — beide haengen nicht an dieser Zaehlung.
      tokens: {
        start: 0, end: cost?.total?.all ?? null, delta: cost?.total?.all ?? null,
        rounds: cost?.rounds ?? null, dedup: cost?.dedup ?? null, result_usage_total: usageTotal(result?.usage),
      },
      cost_usd_list: costKnown ? result.total_cost_usd : null,
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
          .map((t) => ({ name: t.name, count: isCli && t.name === 'Bash' ? t.count - mcpCalls.length : t.count }))
          .filter((t) => t.count > 0),
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

const USAGE = 'usage: node blind-run.mjs run <slug> [--local] [--headless] [--smoke] [--rundir <dir>] [--allowed-tools-form plain|glob] '
  + '[--model <id>] [--timeout-min <n>] | compare';

// CLI-Argumente von `run` (ohne das Kommando selbst) in Optionen uebersetzen.
export function parseRunArgs(rest) {
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const slug = rest[0];
  const local = rest.includes('--local');
  if (local && slug !== 'public-browser') throw new Error('--local gilt nur fuer public-browser');
  const timeoutMin = opt('--timeout-min');
  return {
    slug,
    smoke: rest.includes('--smoke'),
    headless: rest.includes('--headless'),
    rundir: opt('--rundir'),
    allowedToolsForm: opt('--allowed-tools-form'),
    model: opt('--model'),
    timeoutMs: timeoutMin ? Number(timeoutMin) * 60_000 : undefined,
    local,
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'run') {
    let args;
    try { args = parseRunArgs(rest); } catch (e) { console.error(String(e.message)); process.exit(1); }
    const { slug, local, ...runOpts } = args;
    if (local) PARTICIPANTS['public-browser'] = localParticipant(join(HERE, '..'));
    const { run, problems } = await runParticipant(slug, runOpts, {
      resultsDir: process.env.BLIND_RUN_RESULTS_DIR || join(HERE, local ? 'results-local' : 'results'),
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
