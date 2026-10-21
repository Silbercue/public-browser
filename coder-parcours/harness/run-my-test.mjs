#!/usr/bin/env node
// run-my-test.mjs — der Befehl, mit dem ein Agent in einer Festhalten-Sitzung seinen Test (test/RUN) gegen
// eine frische, heile App laufen laesst.
// CLI: node harness/run-my-test.mjs --ctl <dir> [--secret-dir <dir>]
// <dir>/session.json: { seed, testDir, baselinePids } (ohne secretDir). Ausgabe geht auch nach <dir>/run-my-test.log.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCaptureCommand } from './report-schema.mjs';
import { runTestCommand } from './capture-check.mjs';
import { spawnAppServer } from '../server/spawn.mjs';

/**
 * @param {{ ctl: string, secretDir?: string|null }} opts
 * @param {{ portBusy?: (port: number) => Promise<boolean>, ports?: number[], cleanup?: object, spawnApp?: typeof spawnAppServer }} [deps]
 * @returns {Promise<{ code: number, text: string }>}
 */
export async function runMyTest({ ctl, secretDir = null }, deps = {}) {
  const session = JSON.parse(readFileSync(join(ctl, 'session.json'), 'utf8'));
  const { seed, testDir, baselinePids } = session;
  const log = (text) => { appendFileSync(join(ctl, 'run-my-test.log'), `${text}\n`); return text; };

  const cmd = readCaptureCommand(testDir);
  if (!cmd.ok) {
    const text = cmd.problems[0] === 'RUN empty' ? `The RUN file in ${testDir} is empty.` : `No RUN file in ${testDir}.`;
    return { code: 1, text: log(text) };
  }
  const app = await (deps.spawnApp ?? spawnAppServer)({ seed, session: 'capture', variant: 'healthy', secretDir });
  let r;
  try {
    r = await runTestCommand({ testDir, command: cmd.command, appUrl: app.url, baselinePids: baselinePids ?? [] }, deps);
  } finally { await app.stop(); }
  const head = r.refused ? 'exit code: refused' : `exit code: ${r.timedOut ? 'timeout' : r.exit}`;
  const text = log(`${head}\n${r.output}`);
  return { code: r.exit === null ? 1 : r.exit, text };
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const { values } = parseArgs({ options: { ctl: { type: 'string' }, 'secret-dir': { type: 'string' } } });
  if (!values.ctl) {
    process.stderr.write('Usage: run-my-test --ctl <dir> [--secret-dir <dir>]\n');
    process.exit(2);
  }
  const { code, text } = await runMyTest({ ctl: values.ctl, secretDir: values['secret-dir'] ?? null });
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.exit(code);
}
