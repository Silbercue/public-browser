// secrets.mjs — Geheimnis-Scan vor der Veroeffentlichung von Sitzungsdateien und Rohprotokollen.
// Ersetzt bekannte Schluesselmuster und die Werte aus ~/.npmrc und .env-Dateien durch einen Platzhalter.
// Bestandteil der Gegenmittel zu Lesezugriffen ueber den Browser (file://) und ueber RUN (ohne Sperre).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REDACTED = '[redacted-secret]';

/** Bekannte Schluesselformen. Alle ohne Anfuehrungszeichen/Backslash, damit JSON-Text gueltig bleibt. */
const PATTERNS = [
  /npm_[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?=["]))/g,
];

/**
 * Werte aus Dateien, die Schluessel enthalten koennen: `KEY=VALUE`-Zeilen (.env) und `...:_authToken=VALUE` (.npmrc).
 * @param {string[]} files
 * @returns {string[]} Werte mit mindestens 8 Zeichen
 */
export function needlesFromFiles(files) {
  const out = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?[^#=\s][^=]*=(.*)$/.exec(line);
      if (!m) continue;
      const v = m[1].trim().replace(/^["']|["']$/g, '');
      if (v.length >= 8 && !/^(true|false|https?:\/\/\S*)$/i.test(v) && !/[\\"]/.test(v)) out.add(v);
    }
  }
  return [...out];
}

/** Standardquellen: ~/.npmrc und .env im Haupt-Repo und in coder-parcours/. @param {string} cpRoot */
export function defaultSecretFiles(cpRoot, home = homedir()) {
  return [join(home, '.npmrc'), join(cpRoot, '.env'), join(cpRoot, '..', '.env')];
}

/**
 * @param {string} text
 * @param {{ needles?: string[] }} [opts]
 * @returns {{ text: string, count: number }}
 */
export function scrubSecrets(text, { needles = [] } = {}) {
  let count = 0;
  let out = String(text);
  for (const re of PATTERNS) out = out.replace(re, () => { count++; return REDACTED; });
  for (const n of [...needles].sort((a, b) => b.length - a.length)) {
    if (!n || n.length < 8 || !out.includes(n)) continue;
    const parts = out.split(n);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, count };
}
