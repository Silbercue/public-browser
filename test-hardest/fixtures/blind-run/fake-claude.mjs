#!/usr/bin/env node
// Fake-Claude fuer die Pipeline-Tests von blind-run.mjs. Modus ueber FAKE_CLAUDE_MODE:
//   ok       — JSONL (2 MCP-Calls + 1 verweigerter Bash) + gueltiger Export + JSON auf stdout
//   noexport — wie ok, aber ohne run-export.json
//   badexport— wie ok, aber Export ist {"tests":[]}
//   hang     — schlaeft 60 s (fuer den Wall-Clock-Timeout)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('9.9.9 (Fake Claude)'); process.exit(0); }

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
if (mode === 'hang') { setTimeout(() => process.exit(0), 60_000); }
else {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const sessionId = arg('--session-id');
  const mcpConfig = arg('--mcp-config');
  if (!sessionId || !mcpConfig) { console.error('fake-claude: --session-id / --mcp-config fehlt'); process.exit(3); }

  const t = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
  const model = 'claude-opus-5-20260514';
  const A = (ts, id, name) => JSON.stringify({
    type: 'assistant', timestamp: ts, uuid: `u-${id}`,
    message: { model, usage: { output_tokens: 7, input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id, name, input: {} }] },
  });
  const U = (ts, id, content) => JSON.stringify({
    type: 'user', timestamp: ts, uuid: `r-${id}`,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const jsonl = [
    A(t(0), 'tu1', 'mcp__fake__view_page'),
    U(t(1500), 'tu1', '0123456789'),
    A(t(2000), 'tu2', 'mcp__fake__click'),
    U(t(2250), 'tu2', [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]),
    A(t(3000), 'tu3', 'Bash'),
    U(t(3100), 'tu3', 'Claude requested permissions to use Bash, but you have not granted it yet.'),
  ].join('\n') + '\n';

  const slug = realpathSync(process.cwd()).replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(process.env.HOME, '.claude', 'projects', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl);

  if (mode === 'ok') {
    writeFileSync(join(process.cwd(), 'run-export.json'), JSON.stringify({
      timestamp: new Date().toISOString(), elapsed_s: 42,
      tests: { 'T1.1': { status: 'pass', duration_ms: 10 }, 'T1.2': { status: 'pass', duration_ms: 11 }, 'T1.3': { status: 'pass', duration_ms: 12 } },
      summary: { passed: 3, failed: 0 },
    }, null, 2));
  } else if (mode === 'badexport') {
    writeFileSync(join(process.cwd(), 'run-export.json'), '{"tests":[]}');
  }
  console.log(JSON.stringify({ session_id: sessionId, num_turns: 5, total_cost_usd: 1.23 }));
  process.exit(0);
}
