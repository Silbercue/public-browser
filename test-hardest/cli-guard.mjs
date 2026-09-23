#!/usr/bin/env node
// PreToolUse-Hook fuer CLI-Teilnehmer von blind-run.mjs: laesst nur Bash-Zeilen durch, die ausschliesslich
// aus dem CLI-Befehl (argv[2]) bestehen. Alles andere wird mit permissionDecision "deny" verweigert.
import { cliCommandAllowed } from './blind-run.mjs';

const cli = process.argv[2];
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let command = '';
  try { command = JSON.parse(raw)?.tool_input?.command ?? ''; } catch { /* kaputte Eingabe: verweigern */ }
  if (!cli || !cliCommandAllowed(command, cli)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `blocked by benchmark harness: only ${cli} commands are allowed (no other programs, pipes into other programs or file redirects)`,
    } }));
  }
  process.exit(0);
});
