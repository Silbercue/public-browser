#!/usr/bin/env node
// run-my-test.mjs — der Befehl, mit dem ein Agent in einer Festhalten-Sitzung seinen Test (test/RUN) gegen
// eine frische, heile App laufen laesst.
// CLI: node harness/run-my-test.mjs --ctl <dir> [--secret-dir-stdin]
// <dir>/session.json: { seed, testDir, baselinePids } (ohne secretDir). Ausgabe geht auch nach <dir>/run-my-test.log.
// secretDir steht nie in der argv: mit --secret-dir-stdin liest der Befehl eine Zeile von stdin.
// session.json ohne gueltige baselinePids (fehlt, leer, nicht ganzzahlig) -> Exit 1 (fail closed).
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCaptureCommand } from './report-schema.mjs';
import { OWN_PROCESSES_FILE, runOnFreshApp } from './capture-check.mjs';
import { spawnAppServer } from '../server/spawn.mjs';

/**
 * @param {{ ctl: string, secretDir?: string|null, timeoutMs?: number }} opts
 * @param {{ portBusy?: (port: number) => Promise<boolean>, ports?: number[], cleanup?: object, spawnApp?: typeof spawnAppServer }} [deps]
 * @returns {Promise<{ code: number, text: string }>}
 */
export async function runMyTest({ ctl, secretDir = null, timeoutMs }, deps = {}) {
  const session = JSON.parse(readFileSync(join(ctl, 'session.json'), 'utf8'));
  const { seed, testDir, baselinePids } = session;
  const log = (text) => { appendFileSync(join(ctl, 'run-my-test.log'), `${text}\n`); return text; };

  const okBaseline = Array.isArray(baselinePids) && baselinePids.length > 0
    && baselinePids.every((p) => Number.isInteger(p) && p > 0);
  if (!okBaseline) return { code: 1, text: log('invalid session: baselinePids missing, empty or not a list of integers. Start a new session.') };

  const cmd = readCaptureCommand(testDir);
  if (!cmd.ok) {
    const text = cmd.problems[0] === 'RUN empty' ? `The RUN file in ${testDir} is empty.` : `No RUN file in ${testDir}.`;
    return { code: 1, text: log(text) };
  }
  // Was dieser Befehl startet (App, Lauf), steht im Steuerordner: die Sitzung beendet es bei einem Abbruch gezielt.
  // Nach einem regulaeren Ende werden die Eintraege wieder entfernt (sonst koennte eine spaeter wiederverwendete PID getroffen werden).
  const ownFile = join(ctl, OWN_PROCESSES_FILE);
  const written = [];
  const track = (rec) => { try { const line = JSON.stringify(rec); appendFileSync(ownFile, `${line}\n`); written.push(line); } catch { /* Steuerordner weg */ } };
  let r;
  try {
    r = await runOnFreshApp({ testDir, command: cmd.command, seed, variant: 'healthy', secretDir, baselinePids, timeoutMs }, { track, ...deps });
  } finally {
    try {
      if (existsSync(ownFile)) {
        const rest = readFileSync(ownFile, 'utf8').split('\n').filter((l) => l && !written.includes(l));
        if (rest.length) writeFileSync(ownFile, `${rest.join('\n')}\n`); else rmSync(ownFile);
      }
    } catch { /* Steuerordner weg */ }
  }
  const head = r.refused ? 'exit code: refused' : `exit code: ${r.timedOut ? 'timeout' : r.exit}`;
  const note = !r.refused && !r.timedOut && r.appRequests === 0 ? '\ntest did not exercise the app (no request reached it).' : '';
  const text = log(`${head}\n${r.output}${note}`);
  return { code: r.exit === null ? 1 : r.exit, text };
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const { values } = parseArgs({ options: { ctl: { type: 'string' }, 'secret-dir-stdin': { type: 'boolean', default: false } } });
  if (!values.ctl) {
    process.stderr.write('Usage: run-my-test --ctl <dir> [--secret-dir-stdin]\n');
    process.exit(2);
  }
  let secretDir = null;
  if (values['secret-dir-stdin']) {
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const d of process.stdin) { text += d; if (text.includes('\n')) break; }
    secretDir = text.split('\n')[0].trim() || null;
  }
  const { code, text } = await runMyTest({ ctl: values.ctl, secretDir });
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(code);
}
