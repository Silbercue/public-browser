import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CP_PARTICIPANTS, cpDeps, participantSkillText, registerCpParticipant, resolveChrome, resolveClaude, scrubSessionEnv, toolchainDir,
} from './participants.mjs';

/** @type {any} */
const FAKE_DEPS = { chromeBin: '/x/chrome' };
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('CP_PARTICIPANTS: vier Teilnehmer mit Pflichtfeldern', () => {
  assert.deepEqual(Object.keys(CP_PARTICIPANTS).sort(), ['agent-browser', 'chrome-devtools-mcp', 'playwright-cli', 'public-browser']);
  for (const [slug, p] of Object.entries(CP_PARTICIPANTS)) {
    for (const f of ['kind', 'name', 'display', 'package', 'version', 'profile_isolation']) assert.ok(p[f], `${slug}.${f}`);
    assert.match(p.version, /^\d+\.\d+\.\d+$/, `${slug}: Version fest gepinnt`);
    assert.ok(Array.isArray(p.skillFiles) && Array.isArray(p.extraCommands), slug);
    assert.equal(typeof p.env, 'function', slug);
    if (p.kind === 'mcp') {
      assert.equal(p.command, 'npx');
      assert.ok(p.args.includes(`${p.package}@${p.version}`), `${slug}: Pin in args`);
    } else {
      assert.equal(p.kind, 'cli');
      assert.equal(p.cli, p.name);
      assert.ok(p.skillFiles.length > 0, `${slug}: Skill-Dateien`);
    }
  }
});

test('Teilnehmer-Pins stimmen mit toolchain/package.json ueberein', () => {
  const pkg = JSON.parse(readFileSync(join(toolchainDir(), 'package.json'), 'utf8'));
  for (const p of Object.values(CP_PARTICIPANTS).filter((x) => x.kind === 'cli')) {
    assert.equal(pkg.dependencies[p.package], p.version, p.package);
  }
});

test('public-browser: frischer Cortex im Rundir, Friction-Log aus, Port 9333, kein headless', () => {
  const rundir = mkdtempSync(join(tmpdir(), 'cp-part-'));
  const env = CP_PARTICIPANTS['public-browser'].env(rundir, FAKE_DEPS);
  assert.equal(env.PUBLIC_BROWSER_CORTEX_DIR, join(rundir, 'cortex'));
  assert.ok(existsSync(join(rundir, 'cortex')));
  assert.equal(env.PUBLIC_BROWSER_CHROME_PORT, '9333');
  assert.equal(env.SILBERCUE_CHROME_FRICTION_LOG, '0');
  assert.equal(env.CHROME_PATH, '/x/chrome');
  assert.equal('SILBERCUE_CHROME_HEADLESS' in env, false);
});

test('chrome-devtools-mcp: --isolated und Nutzungsstatistik aus', () => {
  const p = CP_PARTICIPANTS['chrome-devtools-mcp'];
  assert.ok(p.args.includes('--isolated'));
  assert.equal(p.env('/tmp/x').CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, '1');
});

test('agent-browser: dogfood-Skill, Zusatzbefehle, Env mit Chrome aus deps', () => {
  const p = CP_PARTICIPANTS['agent-browser'];
  assert.deepEqual(p.extraCommands, ['mkdir', 'cp', 'sleep']);
  assert.ok(p.skillFiles.some((f) => f.endsWith('dogfood/SKILL.md')));
  assert.ok(p.skillFiles.some((f) => f.endsWith('issue-taxonomy.md')));
  assert.ok(p.skillFiles.some((f) => f.endsWith('dogfood-report-template.md')));
  const env = p.env('/tmp/cp-ab-x', FAKE_DEPS);
  assert.deepEqual(env, { AGENT_BROWSER_EXECUTABLE_PATH: '/x/chrome', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_SESSION: 'cp-ab-x' });
  assert.deepEqual(p.cleanupArgs, ['close']);
});

test('playwright-cli: setup schreibt .playwright/cli.config.json (chrome, headed, isoliert)', () => {
  const rundir = mkdtempSync(join(tmpdir(), 'cp-part-'));
  CP_PARTICIPANTS['playwright-cli'].setup(rundir);
  const cfg = JSON.parse(readFileSync(join(rundir, '.playwright', 'cli.config.json'), 'utf8'));
  assert.deepEqual(cfg.browser, { browserName: 'chromium', isolated: true, launchOptions: { channel: 'chrome', headless: false } });
});

test('registerCpParticipant fuegt einen Test-Teilnehmer hinzu', () => {
  const def = { kind: 'mcp', name: 'fake', command: 'node', args: [], env: () => ({}), skillFiles: [], extraCommands: [] };
  assert.equal(registerCpParticipant('fake-x', def), def);
  assert.equal(CP_PARTICIPANTS['fake-x'], def);
  delete CP_PARTICIPANTS['fake-x'];
});

test('scrubSessionEnv entfernt Provider-Keys, PUBLIC_BROWSER_* und SILBERCUE_*, laesst Rest stehen', () => {
  const out = scrubSessionEnv({
    PUBLIC_BROWSER_CLICKER: 'claude-code', OPENAI_API_KEY: 'k', SILBERCUE_CHROME_HEADLESS: '1', ANTHROPIC_API_KEY: 'a',
    PATH: '/bin', HOME: '/h', LANG: 'C',
  });
  assert.deepEqual(out, { PATH: '/bin', HOME: '/h', LANG: 'C' });
});

test('resolveChrome: Override, macOS-Standard, Linux erster vorhandener', () => {
  assert.equal(resolveChrome({ CODER_PARCOURS_CHROME: '/my/chrome' }, 'linux'), '/my/chrome');
  assert.equal(resolveChrome({}, 'darwin'), MAC);
  const seen = [];
  const exists = (p) => { seen.push(p); return p === '/usr/bin/google-chrome' || p === '/opt/google/chrome/chrome'; };
  assert.equal(resolveChrome({}, 'linux', { exists }), '/usr/bin/google-chrome');
  assert.deepEqual(seen, ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']);
  assert.equal(resolveChrome({}, 'linux', { exists: (p) => p === '/opt/google/chrome/chrome' }), '/opt/google/chrome/chrome');
  assert.equal(resolveChrome({}, 'linux', { exists: () => false }), null);
});

test('resolveClaude: Override, dann PATH, dann ~/.local/bin/claude', () => {
  assert.equal(resolveClaude({ CODER_PARCOURS_CLAUDE_BIN: '/x/claude' }), '/x/claude');
  const exists = (p) => p === '/b/claude';
  assert.equal(resolveClaude({ PATH: '/a:/b' }, { exists }), '/b/claude');
  assert.equal(resolveClaude({ PATH: '/a' }, { exists }), join(homedir(), '.local', 'bin', 'claude'));
});

test('cpDeps nimmt Chrome und Claude aus resolveChrome/resolveClaude', () => {
  const d = cpDeps({ CODER_PARCOURS_CHROME: '/c/chrome', CODER_PARCOURS_CLAUDE_BIN: '/c/claude' });
  assert.equal(d.chromeBin, '/c/chrome');
  assert.deepEqual(d.claude, { file: '/c/claude', argsPrefix: [] });
  assert.ok(d.measureDir && d.envOverrides);
});

const installed = existsSync(join(toolchainDir(), 'node_modules', 'agent-browser', 'package.json'));

test('participantSkillText(agent-browser) enthaelt dogfood, Kopfzeilen und Pruefsummen', { skip: !installed && 'Werkzeugkette nicht installiert (node harness/setup.mjs)' }, () => {
  const { text, files } = participantSkillText('agent-browser');
  assert.match(text, /dogfood/);
  assert.equal(files.length, CP_PARTICIPANTS['agent-browser'].skillFiles.length);
  for (const f of files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(text.includes(`# ${f.path}\n`), `Kopfzeile fuer ${f.path}`);
  }
});

test('participantSkillText fuer MCP-Teilnehmer ist leer, fuer unbekannten Slug ein Fehler', () => {
  assert.deepEqual(participantSkillText('chrome-devtools-mcp'), { text: '', files: [] });
  assert.throws(() => participantSkillText('nope'), /unknown participant/);
});
