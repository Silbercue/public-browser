#!/usr/bin/env node
// PreToolUse-Hook (matcher 'Bash|Read') fuer Coder-Parcours-Sitzungen, Vorbild test-hardest/cli-guard.mjs.
// argv[2]: erlaubte Befehlskoepfe, kommagetrennt. argv[3]: Sitzungsordner (Read nur fuer Bilder darin).
import { commandAllowedAny, readAllowed, READ_DENY_REASON } from './guard.mjs';

const heads = String(process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const readRoot = process.argv[3] || '';

const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  } }));
};

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(raw); } catch { /* kaputte Eingabe: verweigern */ }
  const bashReason = `blocked by benchmark harness: only ${heads.join(', ')} commands are allowed (no other programs, pipes into other programs or file redirects)`;
  if (!input || typeof input !== 'object') deny(bashReason);
  else if (input.tool_name === 'Read') { if (!readAllowed(input.tool_input?.file_path, readRoot)) deny(READ_DENY_REASON); }
  else if (input.tool_name === 'Bash') { if (!commandAllowedAny(input.tool_input?.command ?? '', heads, readRoot)) deny(bashReason); }
  process.exit(0);
});
