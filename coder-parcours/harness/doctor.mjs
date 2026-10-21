#!/usr/bin/env node
// doctor.mjs — Selbstcheck vor einem Lauf: Werkzeuge, Chrome, Werkzeugkette, Pin-Versionen, Fenster, Ports.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CP_PARTICIPANTS, resolveChrome, resolveClaude, toolchainBinDir, toolchainDir } from './participants.mjs';
import { portBusy } from './proc.mjs';

const isExecutable = (p) => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};
const which = (name, env) => String(env.PATH || '').split(delimiter).filter(Boolean)
  .map((d) => join(d, name)).find(isExecutable) ?? null;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function toolchainCheck() {
  const dir = toolchainDir();
  const pkg = readJson(join(dir, 'package.json'));
  const missing = [];
  for (const [name, want] of Object.entries(pkg?.dependencies || {})) {
    const got = readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'))?.version;
    if (got !== want) missing.push(`${name}@${want}${got ? ` (found ${got})` : ''}`);
  }
  const want = /^publicbrowser==(.+)$/m.exec(readFileSync(join(dir, 'requirements.txt'), 'utf8'))?.[1];
  const lib = join(dir, '.venv', 'lib');
  const site = existsSync(lib) ? readdirSync(lib).map((d) => join(lib, d, 'site-packages')).find(existsSync) : null;
  if (!site || !existsSync(join(site, `publicbrowser-${want}.dist-info`))) missing.push(`publicbrowser==${want} (venv)`);
  return missing.length
    ? { ok: false, detail: `missing: ${missing.join(', ')}; run node harness/setup.mjs` }
    : { ok: true, detail: dir };
}

function cliVersionCheck(p) {
  const bin = join(toolchainBinDir(), p.cli);
  if (!existsSync(bin)) return { ok: false, detail: `${bin} not found; run node harness/setup.mjs` };
  try {
    const out = execFileSync(process.execPath, [realpathSync(bin), '--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out.includes(p.version)
      ? { ok: true, detail: `${p.cli} ${p.version}` }
      : { ok: false, detail: `expected ${p.version}, got "${out.slice(0, 80)}"` };
  } catch (e) {
    return { ok: false, detail: `${p.cli} --version failed: ${String(e.message).split('\n')[0]}` };
  }
}

/**
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<{ ok: boolean, checks: { name: string, ok: boolean, detail: string, warn?: boolean }[] }>}
 */
export async function doctor({ platform = process.platform, env = process.env } = {}) {
  const checks = [];
  const add = (name, ok, detail, extra = {}) => checks.push({ name, ok, detail, ...extra });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22, `v${process.versions.node}${major >= 22 ? '' : ' (need >= 22)'}`);

  const claude = resolveClaude(env);
  add('claude', isExecutable(claude), isExecutable(claude) ? claude : `${claude} not found (set CODER_PARCOURS_CLAUDE_BIN)`);

  const chrome = resolveChrome(env, platform);
  const chromeOk = Boolean(chrome) && existsSync(chrome);
  add('chrome', chromeOk, chromeOk ? chrome : `Google Chrome not found${chrome ? ` at ${chrome}` : ''} (set CODER_PARCOURS_CHROME)`);

  const why = { jq: 'token measurement scripts', python3: 'venv with publicbrowser', lsof: 'cleanup after capture tests' };
  for (const tool of ['jq', 'python3', 'lsof']) {
    const p = which(tool, env);
    add(tool, Boolean(p), p ?? `not found in PATH (needed for ${why[tool]})`);
  }

  const tc = toolchainCheck();
  add('toolchain', tc.ok, tc.detail);

  for (const p of Object.values(CP_PARTICIPANTS).filter((x) => x.kind === 'cli')) {
    const r = cliVersionCheck(p);
    add(p.cli, r.ok, r.detail);
  }

  if (platform === 'linux') {
    const disp = env.DISPLAY || env.WAYLAND_DISPLAY;
    add('display', Boolean(disp), disp ? `display ${disp}` : 'neither DISPLAY nor WAYLAND_DISPLAY is set; browsers need a visible window');
  }

  for (const port of [9222, 9223]) {
    const busy = await portBusy(port);
    add(`port ${port}`, true, busy
      ? 'in use: a capture session started now would be aborted, because Python tests with publicbrowser would connect to that program'
      : 'free', busy ? { warn: true } : {});
  }

  return { ok: checks.every((c) => c.ok), checks };
}

function table({ checks }) {
  const w = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${c.name.padEnd(w)}  ${c.ok ? (c.warn ? 'WARN' : 'OK  ') : 'FAIL'}  ${c.detail}`).join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await doctor();
  console.log(table(r));
  process.exit(r.ok ? 0 : 1);
}
