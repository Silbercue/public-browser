// guard.mjs — Befehlssperre fuer Coder-Parcours-Sitzungen.
// Gleiche Zerlegungsregeln wie cliCommandAllowed in test-hardest/blind-run.mjs, aber mit mehreren erlaubten
// Befehlskoepfen (z. B. agent-browser plus mkdir/cp/sleep fuer den dogfood-Ablauf, run-my-test in capture).
// blind-run.mjs exportiert seine Zerleger- und Parser-Helfer nicht und wird nicht geaendert, daher hier eigen.
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const READ_DENY_REASON = 'Read is limited to screenshots inside the session folder.';
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/**
 * Zerlegt eine Bash-Zeile an &&, ||, |, &, ; und Zeilenumbruch. null = gesperrte Form
 * (Kommando-Substitution, Datei-Umleitung ausser N>&M, offenes Anfuehrungszeichen).
 * @param {unknown} command
 * @returns {string[] | null}
 */
function splitSegments(command) {
  const text = String(command ?? '');
  const segments = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (q === "'") { cur += ch; if (ch === "'") q = null; continue; }
    if (ch === '\\') { cur += ch + (next ?? ''); i++; continue; }
    if (ch === '`' || (ch === '$' && next === '(')) return null;
    if (q === '"') { cur += ch; if (ch === '"') q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === '>' && next === '&' && /\d/.test(text[i + 2] ?? '')) { cur += text.slice(i, i + 3); i += 2; continue; }
    if (ch === '>' || ch === '<') return null;
    if ((ch === '&' || ch === '|') && next === ch) { segments.push(cur); cur = ''; i++; continue; }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\n') { segments.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (q) return null;
  segments.push(cur);
  return segments;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Befehle, die Dateien anlegen oder kopieren: erlaubt nur mit Pfaden im Sitzungsordner (pathRoot).
const PATH_HEADS = new Set(['mkdir', 'cp']);

const unquote = (t) => (/^(["']).*\1$/.test(t) && t.length >= 2 ? t.slice(1, -1) : t);

/** rel (von path.relative) fuehrt aus dem Ordner hinaus? Eine Datei "..x" im Ordner tut das nicht. */
const isEscape = (rel) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/** Liegt der Pfad (relativ zu root) nach Aufloesung von Symlinks im realen root? */
function pathInside(tok, root) {
  let realRoot;
  try { realRoot = realpathSync(root); } catch { return false; }
  const abs = resolve(root, tok);
  let existing = abs;
  while (!existsSync(existing)) {
    const up = dirname(existing);
    if (up === existing) return false;
    existing = up;
  }
  let real;
  try { real = join(realpathSync(existing), relative(existing, abs)); } catch { return false; }
  const rel = relative(realRoot, real);
  return !isEscape(rel);
}

/** mkdir/cp-Segment: nur kurze Schalter (-p, -R ...) und Pfade, die im Sitzungsordner liegen. */
function pathSegmentAllowed(segment, pathRoot) {
  if (typeof pathRoot !== 'string' || !pathRoot) return false;
  const tokens = segment.trim().split(/\s+/).slice(1).map(unquote);
  if (tokens.length === 0) return false;
  for (const tok of tokens) {
    if (/^-[A-Za-z]+$/.test(tok)) continue;
    if (!tok || tok.startsWith('-') || /[$~*?[\]{}\\!]/.test(tok)) return false;
    if (!pathInside(tok, pathRoot)) return false;
  }
  return true;
}

/**
 * true, wenn jedes Segment der Zeile mit einem der Koepfe beginnt. mkdir und cp zusaetzlich nur, wenn alle
 * Pfadargumente im Sitzungsordner pathRoot liegen (ohne pathRoot sind beide gesperrt).
 * @param {unknown} command
 * @param {string[]} heads
 * @param {string} [pathRoot]
 */
export function commandAllowedAny(command, heads, pathRoot) {
  const list = (heads || []).filter(Boolean);
  if (list.length === 0) return false;
  const segments = splitSegments(command);
  if (!segments) return false;
  const head = new RegExp(`^(?:${list.map(escapeRe).join('|')})(\\s|$)`);
  return segments.every((s) => {
    const t = s.trim();
    if (!head.test(t)) return false;
    const first = t.split(/\s+/)[0];
    return PATH_HEADS.has(first) ? pathSegmentAllowed(t, pathRoot) : true;
  });
}

/**
 * Read nur fuer Bilddateien, deren realer Pfad im realen readRoot liegt.
 * @param {unknown} filePath
 * @param {string | undefined} readRoot
 */
export function readAllowed(filePath, readRoot) {
  if (typeof filePath !== 'string' || !filePath || typeof readRoot !== 'string' || !readRoot) return false;
  if (!IMAGE_EXT.has(extname(filePath).toLowerCase())) return false;
  let root;
  let file;
  try {
    root = realpathSync(readRoot);
    file = realpathSync(resolve(readRoot, filePath));
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (!IMAGE_EXT.has(extname(file).toLowerCase())) return false;
  const rel = relative(root, file);
  return rel !== '' && !isEscape(rel);
}

/**
 * Write nur mit Ziel im Sitzungsordner (writeRoot): relative Pfade gelten ab writeRoot, `..` und Symlinks nach aussen
 * (auch ein hängender Symlink als Ziel) zaehlen als ausserhalb.
 * @param {unknown} filePath
 * @param {string | undefined} writeRoot
 */
export function writeAllowed(filePath, writeRoot, depth = 0) {
  if (typeof filePath !== 'string' || !filePath || typeof writeRoot !== 'string' || !writeRoot) return false;
  try {
    const abs = resolve(writeRoot, filePath);
    // Haengender Symlink: nur wenn sein Ziel ausserhalb liegt (nach innen zeigend ist er harmlos).
    if (lstatSync(abs).isSymbolicLink() && !existsSync(abs)) {
      const target = resolve(dirname(abs), readlinkSync(abs));
      return depth < 8 && writeAllowed(target, writeRoot, depth + 1);
    }
  } catch { /* Ziel existiert noch nicht: pathInside prueft die Elternkette */ }
  return pathInside(filePath, writeRoot);
}

const resultText = (content) => {
  if (typeof content === 'string') return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('').slice(0, 300);
  }
  return '';
};

// Feldform wie parseToolCalls in blind-run.mjs: tool_use in assistant-Zeilen, tool_result in user-Zeilen.
function parseCalls(jsonlText) {
  const calls = [];
  const results = new Map();
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue;
    if (obj.type === 'assistant') {
      for (const c of content) if (c?.type === 'tool_use' && typeof c.name === 'string') calls.push({ id: c.id, name: c.name, input: c.input ?? null });
    } else if (obj.type === 'user') {
      for (const c of content) if (c?.type === 'tool_result' && c.tool_use_id) results.set(c.tool_use_id, c);
    }
  }
  return calls.map((c) => {
    const r = results.get(c.id);
    return { ...c, is_error: r ? r.is_error === true : false, result_text: r ? resultText(r.content) : '' };
  });
}

// Als abgelehnt gilt nur ein strukturiertes Signal: is_error === true UND ein Ablehnungstext am Anfang der Antwort
// (Hook des Parcours, Claude-Code-Ablehnung, gesperrtes Werkzeug). Freitext irgendwo im Ergebnis zaehlt nicht,
// denn der Agent steuert Teile davon (z. B. den Dateinamen im Erfolgstext von Write).
const HOOK_PREFIX = '(?:PreToolUse:\\w+ hook error: )?';
const DENIAL_START = [
  new RegExp(`^${HOOK_PREFIX}blocked by benchmark harness: `),
  new RegExp(`^${HOOK_PREFIX}${escapeRe(READ_DENY_REASON)}`),
  /^Claude requested permissions to /,
  /^Permission to use \S+ has been denied/,
];
const unavailable = (c) => c.result_text.startsWith(`<tool_use_error>Error: No such tool available: ${c.name}. `);
const denied = (c) => c.is_error === true && (DENIAL_START.some((re) => re.test(c.result_text)) || unavailable(c));

/**
 * Sperr-Nachweis einer Sitzung. Eigen sind Write, MCP-Aufrufe mit mcpPrefix, Bash-Zeilen nach commandAllowedAny
 * und (mit readRoot) Read-Aufrufe nach readAllowed. Ohne readRoot zaehlt Read wie jedes fremde Werkzeug.
 * Mit writeRoot zaehlt Write nur mit Ziel im Sitzungsordner (writeAllowed) als eigen, sonst wie ein fremdes Werkzeug.
 * @param {string} jsonlText
 * @param {{ mcpPrefix?: string, heads?: string[], readRoot?: string, writeRoot?: string }} opts
 */
export function toolLockMulti(jsonlText, { mcpPrefix, heads = [], readRoot, writeRoot } = {}) {
  const calls = parseCalls(jsonlText);
  const own = (c) => (c.name === 'Write' && (!writeRoot || writeAllowed(c.input?.file_path, writeRoot)))
    || (Boolean(mcpPrefix) && c.name.startsWith(mcpPrefix))
    || (c.name === 'Bash' && commandAllowedAny(c.input?.command, heads, readRoot));
  const isRead = (c) => Boolean(readRoot) && c.name === 'Read';
  const reads = calls.filter((c) => isRead(c) && !readAllowed(c.input?.file_path, readRoot));
  const outside = calls.filter((c) => !isRead(c) && !own(c));
  const executed = calls.filter((c) => (outside.includes(c) || reads.includes(c)) && !denied(c)).map((c) => c.name);
  return {
    bash_attempted: outside.length,
    bash_denied: outside.length > 0 && outside.every(denied),
    read_attempted: reads.length,
    read_denied: reads.length > 0 && reads.every(denied),
    non_mcp_executed: executed,
  };
}
