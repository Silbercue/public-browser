#!/usr/bin/env node
// PreToolUse-Hook (matcher 'Bash|Read|Write'; Write nur gegen Konfigurationsdateien der Werkzeuge) fuer Coder-Parcours-Sitzungen, Vorbild test-hardest/cli-guard.mjs.
// argv[2]: erlaubte Befehlskoepfe, kommagetrennt. argv[3]: Sitzungsordner (Read nur fuer Bilder darin).
import { bashDenyReason, commandAllowedAny, protectedConfigPath, readAllowed, CONFIG_DENY_REASON, READ_DENY_REASON } from './guard.mjs';

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
  if (!input || typeof input !== 'object') deny(bashDenyReason('', heads, readRoot));
  else if (input.tool_name === 'Read') { if (!readAllowed(input.tool_input?.file_path, readRoot)) deny(READ_DENY_REASON); }
  else if (input.tool_name === 'Write') { if (protectedConfigPath(input.tool_input?.file_path)) deny(CONFIG_DENY_REASON); }
  else if (input.tool_name === 'Bash') {
    const cmd = input.tool_input?.command ?? '';
    if (!commandAllowedAny(cmd, heads, readRoot)) deny(bashDenyReason(cmd, heads, readRoot));
  }
  process.exit(0);
});
