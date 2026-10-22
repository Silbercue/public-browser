// participants.mjs — Teilnehmer des Coder-Parcours, jeder nach seiner offiziellen Anleitung eingestellt.
// Felder wie PARTICIPANTS in test-hardest/blind-run.mjs, dazu skillFiles (relativ zum npm-Paket in der
// Werkzeugkette) und extraCommands (zusaetzlich erlaubte Befehlskoepfe neben dem CLI).
// Versionen gepinnt am 21.10.2026 per `npm view` (aktuelle Version je Paket).
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDeps, scrubProviderKeys } from './blind-run-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Ordner der Werkzeugkette (npm-Pakete der CLI-Teilnehmer, Playwright Test, Python-venv mit publicbrowser). */
export function toolchainDir() {
  return join(HERE, 'toolchain');
}

/** node_modules/.bin der Werkzeugkette (dort liegen agent-browser und playwright-cli). */
export function toolchainBinDir() {
  return join(toolchainDir(), 'node_modules', '.bin');
}

/**
 * Public Browser im Entwicklungsmodus: `npm run dev` ersetzt build/ im npx-Cache von public-browser durch einen
 * Symlink auf den lokalen Build. Dann wuerde `npx public-browser@3.0.0` unveroeffentlichten Code starten.
 * @param {string} [npxDir] Standard ~/.npm/_npx
 * @returns {string[]} Pfade der build-Symlinks
 */
export function devModeLinks(npxDir = join(homedir(), '.npm', '_npx')) {
  if (!existsSync(npxDir)) return [];
  const out = [];
  for (const d of readdirSync(npxDir)) {
    const p = join(npxDir, d, 'node_modules', 'public-browser', 'build');
    try { if (lstatSync(p).isSymbolicLink()) out.push(p); } catch { /* kein build-Ordner */ }
  }
  return out;
}

/**
 * Gemeinsamer Start fuer alle vier Teilnehmer: Google Chrome im neuen Headless-Modus (`--headless=new`, nicht
 * chrome-headless-shell), Fenster/Anzeigebereich 1280 x 800 (die feste Groesse von Public Browser). Die Teilnehmer mit eigenem
 * Werkzeug fuer die Groesse duerfen sie in der Sitzung aendern; nur der Start ist gleich.
 */
export const START_VIEWPORT = { width: 1280, height: 800 };

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LINUX_CHROME = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];

/**
 * @param {NodeJS.ProcessEnv | Record<string, string>} [env]
 * @param {string} [platform]
 * @param {{ exists?: (p: string) => boolean }} [opts]
 * @returns {string | null}
 */
export function resolveChrome(env = process.env, platform = process.platform, { exists = existsSync } = {}) {
  if (env.CODER_PARCOURS_CHROME) return env.CODER_PARCOURS_CHROME;
  if (platform === 'darwin') return MAC_CHROME;
  if (platform === 'linux') return LINUX_CHROME.find((p) => exists(p)) ?? null;
  return null;
}

const isExecutable = (p) => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

/**
 * @param {NodeJS.ProcessEnv | Record<string, string>} [env]
 * @param {{ exists?: (p: string) => boolean }} [opts]
 * @returns {string}
 */
export function resolveClaude(env = process.env, { exists = isExecutable } = {}) {
  if (env.CODER_PARCOURS_CLAUDE_BIN) return env.CODER_PARCOURS_CLAUDE_BIN;
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const p = join(dir, 'claude');
    if (exists(p)) return p;
  }
  return join(homedir(), '.local', 'bin', 'claude');
}

/**
 * deps-Objekt fuer blind-run-Funktionen, mit Chrome und Claude aus resolveChrome/resolveClaude.
 * @param {NodeJS.ProcessEnv | Record<string, string>} [env]
 */
export function cpDeps(env = process.env) {
  return { ...defaultDeps(), claude: { file: resolveClaude(env), argsPrefix: [] }, chromeBin: resolveChrome(env) };
}

export const CP_PARTICIPANTS = {
  'public-browser': {
    kind: 'mcp', name: 'public-browser', display: 'Public Browser', package: 'public-browser', version: '3.0.0',
    command: 'npx', args: ['-y', 'public-browser@3.0.0'],
    // Eigener Chrome auf Port 9333, per Schalter headless (--headless=new), frischer
    // Cortex-Ordner im Rundir. PB 3.0.0 sendet keine Telemetrie ins Netz; die einzige Aufzeichnung ist das
    // lokale Friction-Log (opt-in), es bleibt ausdruecklich aus. CHROME_PATH ist PBs offizieller Override.
    env: (rundir, deps = cpDeps()) => {
      const cortex = join(rundir, 'cortex');
      mkdirSync(cortex, { recursive: true });
      return {
        PUBLIC_BROWSER_CORTEX_DIR: cortex,
        PUBLIC_BROWSER_CHROME_PORT: '9333',
        SILBERCUE_CHROME_FRICTION_LOG: '0',
        // Public Browser startet mit --headless=new und stellt den Anzeigebereich fest auf 1280 x 800 (DEVICE_METRICS_OVERRIDE).
        SILBERCUE_CHROME_HEADLESS: 'true',
        ...(deps.chromeBin ? { CHROME_PATH: deps.chromeBin } : {}),
      };
    },
    // configure_session kann ein echtes Chrome-Profil (mit Anmeldungen) wechseln und neu starten: in der Sitzung gesperrt.
    deniedTools: ['configure_session'],
    skillFiles: [], extraCommands: [],
    profile_isolation: 'auto-launched Chrome, fresh temp user-data-dir, CDP port 9333, headless (--headless=new), emulated 1280x800, fresh cortex dir per session',
  },
  'chrome-devtools-mcp': {
    kind: 'mcp', name: 'chrome-devtools', display: 'Chrome DevTools MCP', package: 'chrome-devtools-mcp', version: '1.11.0',
    command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.11.0', '--isolated', '--headless', '--viewport', `${START_VIEWPORT.width}x${START_VIEWPORT.height}`],
    // Gleicher Browser wie bei den anderen: --executable-path mit dem aufgeloesten Chrome (vertraeglich mit
    // --isolated; in 1.11.0 stehen nur channel/browserUrl/wsEndpoint/autoConnect im Konflikt, und der
    // Standard-Kanal wird bei gesetztem Pfad nicht mehr gesetzt). Aufrufer haengen extraArgs(deps) an args.
    extraArgs: (deps = cpDeps()) => (deps.chromeBin ? ['--executable-path', deps.chromeBin] : []),
    env: (_rundir) => ({ CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' }),
    skillFiles: [], extraCommands: [],
    profile_isolation: '--isolated (temp user-data-dir), headless, viewport 1280x800, Chrome via --executable-path (same binary as the others), usage statistics off',
  },
  'agent-browser': {
    kind: 'cli', name: 'agent-browser', cli: 'agent-browser', display: 'agent-browser (dogfood skill)', package: 'agent-browser', version: '0.39.1',
    // Kern-Skill plus dogfood-Skill mit Fehlerkatalog und Berichtsvorlage, alle aus dem npm-Paket derselben Version.
    skillFiles: [
      'skill-data/core/SKILL.md',
      'skill-data/core/references/authentication.md',
      'skill-data/core/references/commands.md',
      'skill-data/core/references/profiling.md',
      'skill-data/core/references/proxy-support.md',
      'skill-data/core/references/session-management.md',
      'skill-data/core/references/snapshot-refs.md',
      'skill-data/core/references/streaming.md',
      'skill-data/core/references/trust-boundaries.md',
      'skill-data/core/references/video-recording.md',
      'skill-data/core/references/webgpu.md',
      'skill-data/dogfood/SKILL.md',
      'skill-data/dogfood/references/issue-taxonomy.md',
      'skill-data/dogfood/templates/dogfood-report-template.md',
    ],
    // Der dogfood-Ablauf legt Ausgabeordner an, kopiert die Berichtsvorlage und wartet zwischen Schritten.
    extraCommands: ['mkdir', 'cp', 'sleep'],
    env: (rundir, deps = cpDeps()) => ({
      AGENT_BROWSER_EXECUTABLE_PATH: join(HERE, 'chrome-start-size.sh'),
      CODER_PARCOURS_REAL_CHROME: deps.chromeBin,
      AGENT_BROWSER_SESSION: `s-${basename(rundir).slice(-6)}`, // kurz: der Socket-Pfad darf hoechstens 103 Bytes lang sein
      AGENT_BROWSER_NAMESPACE: basename(rundir),
    }),
    cleanupArgs: ['close'],
    // agent-browser startet ohne --headed im neuen Headless-Modus (--headless=new), kennt aber keine Startgroesse ueber Umgebung
    // oder Konfiguration (AGENT_BROWSER_ARGS und "args" trennen an Kommas; `set viewport` gilt nur fuer eine Sitzung, und die
    // Anleitung waehlt eigene Sitzungsnamen). Darum startet es Chrome ueber chrome-start-size.sh, das das echte Chrome mit
    // --window-size=1280,887 (Anzeigebereich 1280x800) aufruft; das Skript liegt ausserhalb des Sitzungsordners.
    // Befehlszeile der Daemon-Wurzel (Pfad des agent-browser-Programms); PID-Dateien koennen veraltet sein.
    rootCommandPattern: /agent-browser/i,
    // Der Daemon laeuft abgekoppelt (Elternprozess 1) und traegt die Sitzung nicht in der Befehlszeile. Die Anleitung
    // (dogfood) waehlt eigene Sitzungsnamen; daher bekommt jeder Lauf einen eigenen Namensraum (AGENT_BROWSER_NAMESPACE),
    // und alle PIDs in ~/.agent-browser/namespaces/<Lauf>/run/*.pid gehoeren diesem Lauf.
    ownRootPids: (rundir, home = homedir()) => {
      const dir = join(home, '.agent-browser', 'namespaces', basename(rundir), 'run');
      const out = [];
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.pid')) continue;
          const pid = Number(readFileSync(join(dir, f), 'utf8').trim());
          if (Number.isInteger(pid) && pid > 1) out.push(pid);
        }
      } catch { /* kein Namensraum: nichts */ }
      return out;
    },
    profile_isolation: 'agent-browser default: fresh temp user-data-dir per launch, own session, headless (--headless=new), start window 1280x887 (viewport 1280x800) via chrome-start-size.sh, real Chrome via CODER_PARCOURS_REAL_CHROME',
  },
  'playwright-cli': {
    kind: 'cli', name: 'playwright-cli', cli: 'playwright-cli', display: 'Playwright CLI', package: '@playwright/cli', version: '0.1.22',
    // SKILL.md plus alle davon verlinkten references/*.md, so wie das Paket sie ausliefert.
    skillFiles: [
      'skills/playwright-cli/SKILL.md',
      'skills/playwright-cli/references/element-attributes.md',
      'skills/playwright-cli/references/playwright-tests.md',
      'skills/playwright-cli/references/pr-attachments.md',
      'skills/playwright-cli/references/request-mocking.md',
      'skills/playwright-cli/references/running-code.md',
      'skills/playwright-cli/references/session-management.md',
      'skills/playwright-cli/references/storage-state.md',
      'skills/playwright-cli/references/test-generation.md',
      'skills/playwright-cli/references/tracing.md',
      'skills/playwright-cli/references/video-recording.md',
    ],
    extraCommands: [],
    env: (rundir) => ({ PLAYWRIGHT_CLI_SESSION: basename(rundir) }),
    // Die CLI liest .playwright/cli.config.json aus dem cwd (= Rundir): aufgeloester Chrome-Pfad, headless, Anzeigebereich 1280 x 800,
    // In-Memory-Profil. Nur ohne aufloesbaren Pfad bleibt der Systemkanal als Notnagel.
    setup: (rundir, deps = cpDeps()) => {
      mkdirSync(join(rundir, '.playwright'), { recursive: true });
      writeFileSync(join(rundir, '.playwright', 'cli.config.json'), `${JSON.stringify({
        browser: { browserName: 'chromium', isolated: true, launchOptions: { ...(deps.chromeBin ? { executablePath: deps.chromeBin } : { channel: 'chrome' }), headless: true },
          contextOptions: { viewport: { ...START_VIEWPORT } } },
      }, null, 2)}\n`);
    },
    cleanupArgs: ['close'],
    profile_isolation: 'isolated in-memory profile, Chrome via executablePath (same binary as the others), headless, viewport 1280x800 (.playwright/cli.config.json in the run dir)',
  },
};

/** Nur fuer Tests: einen zusaetzlichen Teilnehmer registrieren. */
export function registerCpParticipant(slug, def) {
  CP_PARTICIPANTS[slug] = def;
  return CP_PARTICIPANTS[slug];
}

/**
 * Skill-Text eines Teilnehmers: alle skillFiles mit Kopfzeile `# <Datei>` aneinander, dazu sha256 je Datei.
 * @param {string} slug
 * @returns {{ text: string, files: { path: string, sha256: string }[] }}
 */
export function participantSkillText(slug) {
  const p = CP_PARTICIPANTS[slug];
  if (!p) throw new Error(`unknown participant: ${slug}`);
  const base = p.vendoredDir || join(toolchainDir(), 'node_modules', ...p.package.split('/'));
  const parts = [];
  const files = [];
  for (const rel of p.skillFiles || []) {
    const abs = join(base, rel);
    if (!existsSync(abs)) throw new Error(`skill file missing for ${slug}: ${rel} (run node harness/setup.mjs)`);
    const content = readFileSync(abs, 'utf8');
    files.push({ path: rel, sha256: createHash('sha256').update(content).digest('hex') });
    parts.push(`# ${rel}\n\n${content.trimEnd()}\n`);
  }
  return { text: parts.join('\n'), files };
}

const INHERITED = /^(PUBLIC_BROWSER_|SILBERCUE_)/;
/**
 * Provider-Keys (wie blind-run) und geerbte PUBLIC_BROWSER_* / SILBERCUE_* entfernen.
 * @param {Record<string, string | undefined>} env
 */
export function scrubSessionEnv(env) {
  return Object.fromEntries(Object.entries(scrubProviderKeys(env)).filter(([k]) => !INHERITED.test(k)));
}
