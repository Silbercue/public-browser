import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CP_PARTICIPANTS, START_VIEWPORT, cpDeps, participantSkillText, registerCpParticipant, resolveChrome, resolveClaude, scrubSessionEnv, toolchainDir,
} from './participants.mjs';

/** @type {any} */
const FAKE_DEPS = { chromeBin: '/x/chrome' };
const NO_CHROME = /** @type {any} */ ({ chromeBin: null });
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

test('F5: public-browser steht gepinnt in der Werkzeugkette (kein @latest aus dem Netz bei publicbrowser-Tests)', () => {
  const pkg = JSON.parse(readFileSync(join(toolchainDir(), 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['public-browser'], CP_PARTICIPANTS['public-browser'].version);
  assert.match(pkg.dependencies['public-browser'], /^\d+\.\d+\.\d+$/, 'exakte Version, kein Bereich');
  const lock = JSON.parse(readFileSync(join(toolchainDir(), 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/public-browser'].version, pkg.dependencies['public-browser'], 'Lockfile haelt dieselbe Version');
});

test('public-browser: frischer Cortex im Rundir, Friction-Log aus, Port 9333, headless', () => {
  const rundir = mkdtempSync(join(tmpdir(), 'cp-part-'));
  const env = CP_PARTICIPANTS['public-browser'].env(rundir, FAKE_DEPS);
  assert.equal(env.PUBLIC_BROWSER_CORTEX_DIR, join(rundir, 'cortex'));
  assert.ok(existsSync(join(rundir, 'cortex')));
  assert.equal(env.PUBLIC_BROWSER_CHROME_PORT, '9333');
  assert.equal(env.SILBERCUE_CHROME_FRICTION_LOG, '0');
  assert.equal(env.CHROME_PATH, '/x/chrome');
  assert.equal(env.SILBERCUE_CHROME_HEADLESS, 'true');
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
  assert.deepEqual(env, { AGENT_BROWSER_EXECUTABLE_PATH: join(dirname(fileURLToPath(import.meta.url)), 'chrome-start-size.sh'), CODER_PARCOURS_REAL_CHROME: '/x/chrome', AGENT_BROWSER_SESSION: 's-p-ab-x', AGENT_BROWSER_NAMESPACE: 'cp-ab-x' });
  assert.deepEqual(p.cleanupArgs, ['close']);
});

test('playwright-cli: setup schreibt .playwright/cli.config.json (Chrome-Pfad, headless, 1280x800, isoliert)', () => {
  const rundir = mkdtempSync(join(tmpdir(), 'cp-part-'));
  CP_PARTICIPANTS['playwright-cli'].setup(rundir, FAKE_DEPS);
  const cfg = JSON.parse(readFileSync(join(rundir, '.playwright', 'cli.config.json'), 'utf8'));
  assert.deepEqual(cfg.browser, { browserName: 'chromium', isolated: true, launchOptions: { executablePath: '/x/chrome', headless: true }, contextOptions: { viewport: { width: 1280, height: 800 } } });
});

test('R4c S3: playwright-cli raeumt alle Sitzungen des Arbeitsordners auf (close-all), auch mit eigenem -s-Namen; agent-browser bleibt bei close im eigenen Namensraum', () => {
  assert.deepEqual(CP_PARTICIPANTS['playwright-cli'].cleanupArgs, ['close-all']);
  assert.deepEqual(CP_PARTICIPANTS['agent-browser'].cleanupArgs, ['close']);
});

test('playwright-cli: setup nimmt den aufgeloesten Chrome-Pfad statt Systemkanal', () => {
  const rundir = mkdtempSync(join(tmpdir(), 'cp-part-'));
  CP_PARTICIPANTS['playwright-cli'].setup(rundir, FAKE_DEPS);
  const lo = JSON.parse(readFileSync(join(rundir, '.playwright', 'cli.config.json'), 'utf8')).browser.launchOptions;
  assert.equal(lo.executablePath, '/x/chrome');
  assert.equal('channel' in lo, false);
  // Gegenprobe: ohne aufloesbaren Pfad bleibt nur der Systemkanal als Notnagel
  const rundir2 = mkdtempSync(join(tmpdir(), 'cp-part-'));
  CP_PARTICIPANTS['playwright-cli'].setup(rundir2, NO_CHROME);
  const lo2 = JSON.parse(readFileSync(join(rundir2, '.playwright', 'cli.config.json'), 'utf8')).browser.launchOptions;
  assert.equal(lo2.channel, 'chrome');
  assert.equal('executablePath' in lo2, false);
});

test('chrome-devtools-mcp: --executable-path mit dem aufgeloesten Chrome, --isolated bleibt, kein --channel', () => {
  const p = CP_PARTICIPANTS['chrome-devtools-mcp'];
  const extra = p.extraArgs(FAKE_DEPS);
  assert.deepEqual(extra, ['--executable-path', '/x/chrome']);
  assert.ok(p.args.includes('--isolated'));
  assert.equal([...p.args, ...extra].some((a) => a.startsWith('--channel')), false);
  assert.deepEqual(p.extraArgs(NO_CHROME), []);
});

/** Verlinkte lokale .md der SKILL.md-Dateien, die in files nicht enthalten sind. */
function unlinkedRefs(p, files) {
  const base = join(toolchainDir(), 'node_modules', ...p.package.split('/'));
  const missing = [];
  let checked = 0;
  for (const rel of p.skillFiles.filter((f) => f.endsWith('SKILL.md'))) {
    const text = readFileSync(join(base, rel), 'utf8');
    for (const m of text.matchAll(/(?:\]\(|`)((?:references|templates)\/[\w./-]+\.md)/g)) {
      checked++;
      const target = normalize(join(dirname(rel), m[1]));
      if (!files.includes(target)) missing.push(`${rel} -> ${target}`);
    }
  }
  return { missing, checked };
}

test('Skill-Dateien: jede verlinkte lokale .md eines mitgegebenen Skills ist ebenfalls mitgegeben', () => {
  for (const slug of ['playwright-cli', 'agent-browser']) {
    const p = CP_PARTICIPANTS[slug];
    const { missing, checked } = unlinkedRefs(p, p.skillFiles);
    assert.ok(checked >= 3, `${slug}: es wurden Verweise gefunden (${checked})`);
    assert.deepEqual(missing, [], `${slug}: nicht mitgegebene Verweisdateien`);
  }
});

test('Skill-Dateien: die Pruefung bisst, wenn eine Verweisdatei fehlt (Gegenprobe)', () => {
  const p = CP_PARTICIPANTS['playwright-cli'];
  const { missing } = unlinkedRefs(p, p.skillFiles.filter((f) => !f.endsWith('running-code.md')));
  assert.deepEqual(missing, ['skills/playwright-cli/SKILL.md -> skills/playwright-cli/references/running-code.md']);
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

test('R4a: agent-browser: eigener Namensraum je Lauf, Daemons (auch unter anderem Sitzungsnamen) ueber die PID-Dateien dort', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-ab-home-'));
  const rundir = join(tmpdir(), 'cp-agent-browser-explore-s1-XyZ123');
  const p = CP_PARTICIPANTS['agent-browser'];
  assert.equal(p.env(rundir, FAKE_DEPS).AGENT_BROWSER_NAMESPACE, 'cp-agent-browser-explore-s1-XyZ123');
  const run = join(home, '.agent-browser', 'namespaces', 'cp-agent-browser-explore-s1-XyZ123', 'run');
  assert.deepEqual(p.ownRootPids(rundir, home), [], 'ohne Namensraum nichts');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'dogfood-s1.pid'), '4242\n');
  writeFileSync(join(run, 'other.pid'), '4343');
  writeFileSync(join(run, 'junk.pid'), 'abc');
  writeFileSync(join(run, 'init.pid'), '1');
  writeFileSync(join(run, 'x.sock'), '999');
  assert.deepEqual(p.ownRootPids(rundir, home).sort(), [4242, 4343], 'nur gueltige PIDs aus *.pid, PID 1 und Muell nie');
});

test('R4a: Public Browser sperrt configure_session (Profilwechsel auf ein echtes Chrome-Profil), Port bleibt 9333', () => {
  assert.deepEqual(CP_PARTICIPANTS['public-browser'].deniedTools, ['configure_session']);
  const env = CP_PARTICIPANTS['public-browser'].env(mkdtempSync(join(tmpdir(), 'cp-pb-')), FAKE_DEPS);
  assert.equal(env.PUBLIC_BROWSER_CHROME_PORT, '9333');
  for (const slug of ['agent-browser', 'playwright-cli', 'chrome-devtools-mcp']) assert.equal(CP_PARTICIPANTS[slug].deniedTools, undefined, slug);
});

test('R4b: alle vier Teilnehmer starten Google Chrome headless (--headless=new) mit derselben Startgroesse 1280x800', () => {
  assert.deepEqual(START_VIEWPORT, { width: 1280, height: 800 });
  const rundir = mkdtempSync(join(tmpdir(), 'cp-part-'));
  // public-browser: Headless-Schalter an; seine Groesse ist fest 1280x800 (nicht einstellbar, siehe METHOD 2.1)
  const pb = CP_PARTICIPANTS['public-browser'].env(rundir, FAKE_DEPS);
  assert.equal(pb.SILBERCUE_CHROME_HEADLESS, 'true');
  assert.equal(pb.CHROME_PATH, '/x/chrome');
  // chrome-devtools-mcp: --headless und --viewport 1280x800, weiter --isolated
  const cdt = CP_PARTICIPANTS['chrome-devtools-mcp'].args;
  assert.ok(cdt.includes('--headless'));
  assert.equal(cdt[cdt.indexOf('--viewport') + 1], '1280x800');
  assert.ok(cdt.includes('--isolated'));
  // agent-browser: kein --headed (weder Env noch Konfiguration), Startgroesse per set viewport vor dem Sitzungsstart
  const ab = CP_PARTICIPANTS['agent-browser'];
  assert.equal(Object.keys(ab.env(rundir, FAKE_DEPS)).some((k) => /HEADED/.test(k)), false);
  // Das Startskript ruft das echte Chrome mit allen Argumenten von agent-browser auf und haengt --window-size=1280,887 ans Ende
  const fake = join(rundir, 'fake-chrome.sh');
  writeFileSync(fake, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  const env = ab.env(rundir, /** @type {any} */ ({ chromeBin: fake }));
  const r = spawnSync(env.AGENT_BROWSER_EXECUTABLE_PATH, ['--headless=new', '--window-size=1280,720'], { env: { ...process.env, CODER_PARCOURS_REAL_CHROME: env.CODER_PARCOURS_REAL_CHROME }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '--headless=new --window-size=1280,720 --window-size=1280,887');
  assert.ok(ab.rootCommandPattern.test('/x/node_modules/agent-browser/bin/agent-browser-darwin-arm64'));
  assert.equal(ab.rootCommandPattern.test('/usr/bin/vim notes.txt'), false, 'Gegenprobe: fremde Befehlszeile');
  // playwright-cli: headless und Anzeigebereich in der erzeugten Konfiguration
  CP_PARTICIPANTS['playwright-cli'].setup(rundir, FAKE_DEPS);
  const cfg = JSON.parse(readFileSync(join(rundir, '.playwright', 'cli.config.json'), 'utf8')).browser;
  assert.equal(cfg.launchOptions.headless, true);
  assert.deepEqual(cfg.contextOptions.viewport, { width: 1280, height: 800 });
  assert.equal(cfg.launchOptions.executablePath, '/x/chrome');
});

test('R4c S3: playwright-cli-Daemon mit anderem -s-Namen wird ueber seinen Arbeitsordner als Sitzungsprozess erkannt (Fake-Daemon)', async () => {
  const { spawn } = await import('node:child_process');
  const rundir = mkdtempSync(join(tmpdir(), 'cp-pw-own-'));
  const other = mkdtempSync(join(tmpdir(), 'cp-pw-other-'));
  // Selbstbeendend: der Fake endet, sobald der Testprozess weg ist (auch bei Abbruch des Testlaufs) und spaetestens nach 30 s;
  // dazu eigene Prozessgruppe, die finally als Ganzes beendet.
  const WATCH = 'const p = Number(process.argv[3]); setInterval(() => { try { process.kill(p, 0); } catch { process.exit(0); } }, 200); setTimeout(() => process.exit(0), 30000);';
  const fake = (cwd, script) => spawn(process.execPath, ['-e', WATCH, script, 'guest', String(process.pid)], { cwd, stdio: 'ignore', detached: true });
  const mine = fake(rundir, 'cliDaemon.js');
  const foreign = fake(other, 'cliDaemon.js');
  const notDaemon = fake(rundir, 'something-else.js');
  const killAll = () => { for (const c of [mine, foreign, notDaemon]) { try { process.kill(-(/** @type {number} */ (c.pid)), 'SIGKILL'); } catch { /* schon beendet */ } } };
  process.once('exit', killAll);
  try {
    await new Promise((r) => setTimeout(r, 300));
    const pids = CP_PARTICIPANTS['playwright-cli'].ownRootPids(rundir);
    assert.ok(pids.includes(mine.pid), 'Daemon im Rundir (Name guest, nicht der Laufname) gehoert der Sitzung');
    assert.equal(pids.includes(foreign.pid), false, 'Daemon eines anderen Arbeitsordners nicht');
    assert.equal(pids.includes(notDaemon.pid), false, 'anderer Prozess im Rundir nicht');
    assert.ok(CP_PARTICIPANTS['playwright-cli'].rootCommandPattern.test(`node /x/cliDaemon.js guest`));
  } finally {
    killAll();
    process.off('exit', killAll);
  }
});
