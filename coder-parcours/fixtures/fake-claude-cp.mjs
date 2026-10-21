#!/usr/bin/env node
// Fake-Claude fuer die Tests von harness/run-session.mjs (Vorbild test-hardest/fixtures/blind-run/fake-claude.mjs).
// Modus ueber FAKE_CP_MODE:
//   ok            — JSONL (1 Browser-Aufruf + Write), gueltiges report.json, Ergebnis-JSON auf stdout
//   noreport      — wie ok, ohne report.json
//   halfreport    — wie ok, report.json abgeschnitten (kein gueltiges JSON)
//   maxturns      — wie ok, Ergebnis-JSON mit subtype error_max_turns, Exit 1
//   crash         — Exit 1 sofort, keine JSONL, kein stdout
//   readruntime   — Werkzeug-Eingabe nennt /assets/runtime.js
//   resultruntime — Werkzeug-Ergebnis enthaelt RUNTIME_MARKER, die Eingabe nicht
//   capture       — schreibt test/RUN (eine Abfrage der App, dann `exit 0`) und ruft das Shim run-my-test aus dem PATH
//   capturepeek   — wie capture, aber RUN liest eine Datei unter coder-parcours/bugs/
//   hang          — schreibt die JSONL und wartet dann endlos
//   lockviolation — JSONL mit einem ausgefuehrten Bash-Befehl ausserhalb der erlaubten Koepfe
// Mit `--ctl <dir>` (ohne -p) spielt die Datei das Ziel des Shims: haengt eine Zeile an <dir>/run-my-test.log.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_MARKER } from '../server/bug-engine.mjs';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const CP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (argv.includes('--version')) { console.log('9.9.9 (Fake Claude)'); process.exit(0); }
if (arg('--ctl') && !argv.includes('-p')) {
  appendFileSync(join(arg('--ctl'), 'run-my-test.log'), `fake run-my-test --ctl ${arg('--ctl')}\n`);
  console.log('exit code: 0');
  process.exit(0);
}

const mode = process.env.FAKE_CP_MODE || 'ok';
if (mode === 'crash') { console.error('fake-claude-cp: crash'); process.exit(1); }

const sessionId = arg('--session-id');
const mcpConfig = arg('--mcp-config');
if (!sessionId || !mcpConfig) { console.error('fake-claude-cp: --session-id / --mcp-config fehlt'); process.exit(3); }
const prompt = arg('-p') || '';
const appUrl = (prompt.match(/https?:\/\/[^\s]+?\//) || ['http://127.0.0.1/'])[0];

// Teilnehmer: MCP-Name aus mcp.json, sonst CLI-Kopf aus --allowedTools Bash(<cli>:*).
const servers = Object.keys(JSON.parse(readFileSync(mcpConfig, 'utf8')).mcpServers || {});
const cli = servers.length ? null : (argv.map((a) => /^Bash\(([^:]+):\*\)$/.exec(a)).find((m) => m && m[1] !== 'run-my-test') || [])[1];

const model = 'claude-opus-5-20260514';
let n = 0;
const t = () => new Date(Date.now() + (n++) * 100).toISOString();
const lines = [];
const call = (name, input, content, isError = false) => {
  const id = `tu${lines.length}`;
  lines.push(JSON.stringify({ type: 'assistant', timestamp: t(), uuid: `u-${id}`, message: { id: `msg-${id}`, model,
    usage: { output_tokens: 7, input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    content: [{ type: 'tool_use', id, name, input }] } }));
  lines.push(JSON.stringify({ type: 'user', timestamp: t(), uuid: `r-${id}`,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } }));
};
const browse = (input, content) => {
  if (cli) call('Bash', { command: `${cli} open ${input.url}` }, content);
  else call(`mcp__${servers[0]}__navigate`, input, content);
};

const rundir = process.cwd();
const reportPath = join(rundir, 'report.json');
const report = { change_check: { verdict: 'works', evidence: 'applied the code' },
  findings: [{ title: 'Button overlaps text', where: 'cart', viewport: 'phone', steps: 's', expected: 'e', actual: 'a', severity: 'low' }] };

// Eine echte Anfrage an die App, damit die Sitzung Ereignisse hinterlaesst.
try { await fetch(`${appUrl}api/classes`); } catch { /* App nicht erreichbar: Test merkt es an den Ereignissen */ }

if (mode === 'readruntime') browse({ url: `${appUrl}assets/runtime.js` }, 'ok');
else if (mode === 'resultruntime') browse({ url: appUrl }, [{ type: 'text', text: `network: ${RUNTIME_MARKER}) {...}` }]);
else browse({ url: appUrl }, 'page loaded');

if (mode === 'lockviolation') call('Bash', { command: 'cat /etc/hosts' }, '127.0.0.1 localhost');

if (mode === 'capture' || mode === 'capturepeek') {
  const testDir = join(rundir, 'test');
  mkdirSync(testDir, { recursive: true });
  // Der Test fragt die App einmal ab (die Nachpruefung zaehlt Anfragen) und endet mit exit 0.
  const touch = 'curl -s -o /dev/null "${APP_URL}api/classes"';
  const run = mode === 'capture' ? `${touch}; exit 0` : `cat "${join(realpathSync(CP_ROOT), 'bugs', 'README.md')}" > /dev/null && ${touch}; exit 0`;
  writeFileSync(join(testDir, 'RUN'), `${run}\n`);
  call('Write', { file_path: join(testDir, 'RUN'), content: run }, 'written');
  const r = spawnSync('run-my-test', [], { encoding: 'utf8', env: process.env });
  call('Bash', { command: 'run-my-test' }, `${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`);
} else if (mode !== 'noreport') {
  const text = mode === 'halfreport' ? '{"change_check":{"verdict":"works","evidence":"x"},"findings":[{"title":"x"' : JSON.stringify(report);
  writeFileSync(reportPath, text);
  call('Write', { file_path: reportPath, content: text }, 'written');
}

const slug = realpathSync(rundir).replace(/[^A-Za-z0-9]/g, '-');
const dir = join(process.env.HOME, '.claude', 'projects', slug);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);

if (mode === 'hang') {
  setInterval(() => {}, 60_000);
} else {
  const usage = { input_tokens: 9, output_tokens: 21, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 };
  const maxTurns = mode === 'maxturns';
  console.log(JSON.stringify({ type: 'result', subtype: maxTurns ? 'error_max_turns' : 'success', is_error: maxTurns,
    session_id: sessionId, num_turns: 3, total_cost_usd: 0.5, usage, result: 'done' }));
  process.exit(maxTurns ? 1 : 0);
}
