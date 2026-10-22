// Auftragstexte fuer die Sitzungstypen explore und capture (Task 10).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_ACCOUNTS } from '../shared/accounts.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

export const BUDGETS = {
  explore: { calls: 75, maxTurns: 100, wallMin: 45 },
  capture: { calls: 60, maxTurns: 80, wallMin: 25 },
};

const SMOKE = {
  explore: 'SMOKE MODE (harness self-test): do only Part 1, write the report, stop.',
  capture: 'SMOKE MODE (harness self-test): write a RUN file containing `exit 0`, call run-my-test once, stop.',
};

/**
 * @param {{ type: 'explore'|'capture', toolName: string, appUrl: string, runConfig: any, catalog: any,
 *   reportPath: string, testDir: string, smoke?: boolean }} o
 * @returns {string}
 */
export function renderSessionPrompt({ type, toolName, appUrl, runConfig, catalog, reportPath, testDir, smoke = false }) {
  if (type !== 'explore' && type !== 'capture') throw new Error(`unknown session type: ${type}`);
  const targetId = type === 'explore' ? runConfig?.change?.bugId : runConfig?.capture?.bugId;
  if (!targetId) throw new Error(`no ${type === 'explore' ? 'change' : 'capture'} target in run config`);
  const bug = catalog?.bugs?.find((b) => b.id === targetId);
  const role = type === 'explore' ? bug?.roles?.change?.feature : bug?.roles?.capture?.flow;
  if (!role) throw new Error(`target ${targetId} has no ${type === 'explore' ? 'change' : 'capture'} role text`);

  const vars = {
    APP_URL: appUrl,
    TOOL_NAME: toolName,
    ACCOUNTS: TEST_ACCOUNTS.map((a) => `${a.email} / ${a.password}`).join(', '),
    CHANGE: role,
    FLOW: role,
    BUDGET: String(BUDGETS[type].calls),
    REPORT_PATH: reportPath,
    TEST_DIR: testDir,
    SESSION_DIR: path.dirname(reportPath),
  };
  let text = readFileSync(path.join(dir, `${type}.md`), 'utf8').trimEnd();
  text = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (smoke) text += `\n\n${SMOKE[type]}`;
  if (text.includes('{{')) throw new Error('unresolved placeholder "{{" left in prompt');
  return text + '\n';
}
