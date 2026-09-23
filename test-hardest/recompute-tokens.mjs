#!/usr/bin/env node
// recompute-tokens.mjs — rechnet den tokens-Block blinder Run-JSONs aus ihren Session-Transkripten neu,
// mit dem entdoppelten Zaehler (measure-session-cost.sh: eine Modellantwort = eine message.id).
// Nur tokens aendert sich. cost_usd_list (Claude Codes total_cost_usd), mqs (Antwort-Zeichen),
// tool_efficiency und harness.num_turns bleiben stehen.
//
//   node recompute-tokens.mjs [--dir <results-dir>]... [--dry-run]
//   ohne --dir: results/ und results-local/ neben diesem Skript
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node recompute-tokens.mjs [--dir <results-dir>]... [--dry-run]';

// <projectsDir>/<slug>/<sessionId>.jsonl ueber alle Projekt-Ordner: genau ein Treffer, null bei keinem.
export function findTranscript(projectsDir, sessionId) {
  const hits = readdirSync(projectsDir)
    .map((slug) => join(projectsDir, slug, `${sessionId}.jsonl`))
    .filter((p) => existsSync(p));
  if (hits.length > 1) throw new Error(`${hits.length} transcripts for session ${sessionId}: ${hits.join(', ')}`);
  return hits[0] ?? null;
}

// Neuer tokens-Block aus der Ausgabe von measure-session-cost.sh. Schon korrigierte Laeufe bleiben
// unveraendert, solange die Nachzaehlung dasselbe ergibt; weicht sie ab, ist das ein Fehler.
export function recomputeRun(run, cost, now = new Date()) {
  if (cost?.dedup !== 'message.id' || !Number.isFinite(cost?.total?.all) || !Number.isFinite(cost?.rounds)) {
    throw new Error('measure-session-cost.sh output lacks dedup/total/rounds (old script?)');
  }
  const old = run.tokens ?? {};
  const next = { start: 0, end: cost.total.all, delta: cost.total.all, rounds: cost.rounds, dedup: cost.dedup };
  if (old.dedup === 'message.id') {
    if (old.delta !== next.delta || old.rounds !== next.rounds) {
      throw new Error(`already corrected, but recount differs: ${old.delta}/${old.rounds} vs ${next.delta}/${next.rounds}`);
    }
    return { run, changed: false };
  }
  const tokens = { ...old, ...next, recomputed: { at: now.toISOString(), previous_delta: old.delta ?? null } };
  return { run: { ...run, tokens }, changed: true };
}

function main(argv) {
  const dirs = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) dirs.push(argv[++i]);
    else if (argv[i] === '--dry-run') dryRun = true;
    else { console.error(USAGE); process.exit(2); }
  }
  if (!dirs.length) dirs.push(join(HERE, 'results'), join(HERE, 'results-local'));
  const projectsDir = join(process.env.HOME || homedir(), '.claude', 'projects');
  let failed = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const path = join(dir, name);
      const f = join(basename(dir), name);
      let run;
      try { run = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { failed++; console.error(`FAIL  ${f}: not JSON (${e.message})`); continue; }
      if (run?.harness?.mode !== 'blind-print' || !run.session_id) { console.log(`skip  ${f} (no blind-print run)`); continue; }
      try {
        const jsonl = findTranscript(projectsDir, run.session_id);
        if (!jsonl) throw new Error(`transcript missing for session ${run.session_id}`);
        const sha = createHash('sha256').update(readFileSync(jsonl)).digest('hex');
        if (run.harness.session_jsonl_sha256 && sha !== run.harness.session_jsonl_sha256) {
          throw new Error(`transcript sha256 ${sha.slice(0, 12)}… differs from harness.session_jsonl_sha256`);
        }
        const cost = JSON.parse(execFileSync('bash', [join(HERE, 'measure-session-cost.sh'), basename(dirname(jsonl)), run.session_id],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
        const { run: next, changed } = recomputeRun(run, cost);
        const before = changed ? next.tokens.recomputed.previous_delta : next.tokens.delta;
        const factor = Number.isFinite(before) && next.tokens.delta > 0 ? (before / next.tokens.delta).toFixed(2) : '?';
        const verb = changed ? (dryRun ? 'would fix' : 'fixed') : 'ok';
        console.log(`${verb.padEnd(9)} ${f}  ${before} -> ${next.tokens.delta} (x${factor}), rounds ${next.tokens.rounds}`);
        if (changed && !dryRun) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
      } catch (e) {
        failed++;
        console.error(`FAIL  ${f}: ${e.message}`);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === `file://${realpathSync(process.argv[1])}`) main(process.argv.slice(2));
