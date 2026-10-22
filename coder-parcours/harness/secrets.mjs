// secrets.mjs — Geheimnis-Scan vor der Veroeffentlichung von Sitzungsdateien und Rohprotokollen.
// Ersetzt bekannte Schluesselmuster und die Werte aus ~/.npmrc und .env-Dateien durch einen Platzhalter.
// Bestandteil der Gegenmittel zu Lesezugriffen ueber den Browser (file://) und ueber RUN (ohne Sperre).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const REDACTED = '[redacted-secret]';

/** Bekannte Schluesselformen. Alle ohne Anfuehrungszeichen/Backslash, damit JSON-Text gueltig bleibt. */
const PATTERNS = [
  /npm_[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
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
      if (v.length >= 8 && !/^(true|false|https?:\/\/\S*)$/i.test(v)) out.add(v);
    }
  }
  return [...out];
}

/** Wurzelordner des gemeinsamen Git-Repos (bei Worktrees das Haupt-Repo), sonst null. @param {string} cpRoot */
function gitCommonRoot(cpRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: cpRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    if (!out) return null;
    return dirname(isAbsolute(out) ? out : resolve(cpRoot, out));
  } catch { return null; }
}

/** Standardquellen: ~/.npmrc und .env im Haupt-Repo, im gemeinsamen Git-Repo (Worktree) und in coder-parcours/. @param {string} cpRoot */
export function defaultSecretFiles(cpRoot, home = homedir()) {
  const common = gitCommonRoot(cpRoot);
  return [...new Set([join(home, '.npmrc'), join(cpRoot, '.env'), join(cpRoot, '..', '.env'), ...(common ? [join(common, '.env')] : [])].map((f) => resolve(f)))];
}

export const REDACTED_ACCOUNT = '[redacted-account]';

/**
 * Kennungen des Kontos, unter dem `claude` laeuft, ohne sie fest zu kodieren: aus dem Sitzungsprotokoll (Anhaenge
 * `session_context` mit der E-Mail-Adresse und `credential_org` mit der Organisations-UUID) und aus `<home>/.claude.json`
 * (oauthAccount: E-Mail, Organisations- und Konto-UUID).
 * @param {string} jsonlText
 * @param {string} [home]
 * @returns {string[]} Werte mit mindestens 8 Zeichen, laengste zuerst
 */
export function accountIdentifiers(jsonlText, home = homedir()) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.length >= 8) out.add(v); };
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.includes('session_context') && !line.includes('credential_org')) continue;
    let att;
    try { att = JSON.parse(line)?.attachment; } catch { continue; }
    if (att?.type === 'credential_org') add(att.organizationUuid);
    if (att?.type === 'session_context') {
      for (const v of Object.values(att.context ?? {})) if (typeof v === 'string') { const m = /email address is (\S+?)\.(?:\s|$)/.exec(v) ?? EMAIL.exec(v); add(m ? m[1] ?? m[0] : null); }
    }
  }
  try {
    const acct = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))?.oauthAccount;
    add(acct?.emailAddress); add(acct?.organizationUuid); add(acct?.accountUuid);
  } catch { /* keine Kontodatei: nur die Kennungen aus dem Protokoll */ }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Ersetzt jede Kennung vollstaendig durch REDACTED_ACCOUNT; vor scrubSecrets aufrufen (sonst bleibt von einer E-Mail die Domain). */
export function scrubAccount(text, ids) {
  let out = String(text);
  for (const id of ids) if (id) out = out.split(id).join(REDACTED_ACCOUNT);
  return out;
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
  // Jeder Wert auch in der Form, in der er in serialisiertem JSON steht (Anfuehrungszeichen, Backslash, Umbrueche escapet).
  const all = new Set();
  for (const n of needles) {
    if (!n || n.length < 8) continue;
    all.add(n);
    all.add(JSON.stringify(n).slice(1, -1));
  }
  for (const n of [...all].sort((a, b) => b.length - a.length)) {
    if (!n || n.length < 8 || !out.includes(n)) continue;
    const parts = out.split(n);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, count };
}
