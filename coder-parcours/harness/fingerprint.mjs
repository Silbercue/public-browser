// Fingerabdruck der Messanordnung: Pruefer-Prompt, Auftragstexte, Katalog, Teilnehmer, Budgets.
// Nur Pruefsummen, keine Dateinamen (die Namen im Katalog tragen Kurznamen).
// CLI: node harness/fingerprint.mjs [--compare <a.json> <b.json>]
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUDGETS } from './prompt.mjs';
import { CP_PARTICIPANTS } from './participants.mjs';
import { GRADER_FLAGS, GRADER_MODEL } from './grade.mjs';
import { MODEL_PIN } from './blind-run-lib.mjs';

// Dateien, die die Messbedingungen einer Sitzung festlegen: Sperrregeln, Claude-Flags und Settings, Skill-Vorspann und
// Ergebnis-Ablage (run-session), Teilnehmer-Umgebung und Startparameter (participants), Startgroesse (chrome-start-size.sh),
// Umgebung der Testlaeufe (capture-check).
export const CONDITION_FILES = ['harness/guard.mjs', 'harness/guard-hook.mjs', 'harness/run-session.mjs', 'harness/participants.mjs', 'harness/chrome-start-size.sh', 'harness/capture-check.mjs'];

const CP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * @param {string} root
 * @param {string} rel
 * @returns {Buffer | null}
 */
function readOrNull(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p) : null;
}

/**
 * sha256 ueber die sortierten Zeilen `<relPfad>\0<sha256 der Datei>\n`; eine fehlende Datei zaehlt als Marker "missing"
 * (die uebrigen Dateien bleiben erkennbar); null nur bei leerer Liste.
 * @param {string} root
 * @param {string[]} rels
 */
function treeSha(root, rels) {
  if (!rels.length) return null;
  const lines = [];
  for (const rel of rels) {
    const buf = readOrNull(root, rel);
    lines.push(`${rel}\0${buf ? sha(buf) : 'missing'}\n`);
  }
  return sha(lines.sort().join(''));
}

/**
 * @param {string} root
 * @param {string} dir relativ zu root
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function listFiles(root, dir, pattern) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((n) => pattern.test(n) && !n.endsWith('.test.mjs')).sort().map((n) => `${dir}/${n}`);
}

/**
 * Alle Dateien unter dir (rekursiv, sortiert, relativ zu root), die auf pattern passen, ohne Tests.
 * @param {string} root
 * @param {string} dir
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function listTree(root, dir, pattern) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) out.push(...listTree(root, `${dir}/${e.name}`, pattern));
    else if (e.isFile() && pattern.test(e.name) && !/\.(test|spec)\.[mc]?[jt]sx?$/.test(e.name)) out.push(`${dir}/${e.name}`);
  }
  return out;
}

/** Pruefsumme je Teilnehmer ueber alles, was seinen Start bestimmt (Paket, Version, Aufruf, Zusatzargumente, Skill-Dateien). */
function participantShas() {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [slug, p] of Object.entries(CP_PARTICIPANTS)) {
    const extra = typeof p.extraArgs === 'function' ? p.extraArgs({ chromeBin: '<chrome>' }) : [];
    const picked = { kind: p.kind, package: p.package, version: p.version, command: p.command, cli: p.cli, args: p.args, extraArgs: extra, skillFiles: p.skillFiles, extraCommands: p.extraCommands };
    out[slug] = sha(JSON.stringify(picked));
  }
  return out;
}

/**
 * @param {{ root?: string, env?: Record<string, string|undefined> }} [opts]
 */
export function fingerprint({ root = CP_ROOT, env = process.env } = {}) {
  const grader = readOrNull(root, 'harness/grader-prompt.md');
  const catalogFiles = [...listFiles(root, 'bugs/public', /\.mjs$/), 'catalog/decoys.json', 'harness/seeds.json'];
  return {
    grader_prompt_sha256: grader ? sha(grader) : null,
    prompts_sha256: treeSha(root, listFiles(root, 'harness/prompts', /\.md$/)),
    catalog_sha256: treeSha(root, catalogFiles),
    // Die Testseite selbst: Quelltext der App, Server, Laufzeitskript, gemeinsame Konten, Seed-Auswahl, Katalog-Lader.
    app_sha256: treeSha(root, [
      ...listTree(root, 'app/src', /\.(tsx?|css)$/), 'app/index.html',
      ...listTree(root, 'server', /\.(mjs|js)$/), ...listTree(root, 'shared', /\.mjs$/),
      'harness/seed.mjs', 'catalog/load.mjs',
    ]),
    // Ist CODER_PARCOURS_PUBLIC_DIR gesetzt, misst eine Runde einen anderen Katalog als bugs/public.
    public_dir_override: env.CODER_PARCOURS_PUBLIC_DIR || null,
    grader_model_alias: GRADER_MODEL,
    grader_flags: [...GRADER_FLAGS],
    secret_sha256: (() => { const b = readOrNull(root, 'secret/sealed.bin'); return b ? sha(b) : 'missing'; })(),
    conditions_sha256: treeSha(root, CONDITION_FILES),
    model_pin: MODEL_PIN,
    participants: participantShas(),
    budgets: JSON.parse(JSON.stringify(BUDGETS)),
  };
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {{ fields: Record<string, 'same'|'changed'>, ok: boolean }} ok = nur budgets duerfen sich unterscheiden
 */
export function compareFingerprints(a, b) {
  /** @type {Record<string, 'same'|'changed'>} */
  const fields = {};
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if (k === 'commit' || k === 'time') continue;
    fields[k] = JSON.stringify(a?.[k] ?? null) === JSON.stringify(b?.[k] ?? null) ? 'same' : 'changed';
  }
  const ok = Object.entries(fields).every(([k, v]) => v === 'same' || k === 'budgets');
  return { fields, ok };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--compare');
  if (i >= 0) {
    const [fa, fb] = argv.slice(i + 1);
    if (!fa || !fb) { process.stderr.write('usage: node harness/fingerprint.mjs --compare <a.json> <b.json>\n'); process.exit(2); }
    const { fields, ok } = compareFingerprints(JSON.parse(readFileSync(fa, 'utf8')), JSON.parse(readFileSync(fb, 'utf8')));
    process.stdout.write(`${JSON.stringify(fields, null, 2)}\n`);
    process.exit(ok ? 0 : 1);
  }
  process.stdout.write(`${JSON.stringify(fingerprint(), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
