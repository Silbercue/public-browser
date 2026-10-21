// guard.mjs — Befehlssperre fuer Coder-Parcours-Sitzungen.
// Gleiche Zerlegungsregeln wie cliCommandAllowed in test-hardest/blind-run.mjs, aber mit mehreren erlaubten
// Befehlskoepfen (z. B. agent-browser plus mkdir/cp/sleep fuer den dogfood-Ablauf, run-my-test in capture).
// blind-run.mjs exportiert seine Zerleger- und Parser-Helfer nicht und wird nicht geaendert, daher hier eigen.
import { realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

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

/**
 * true, wenn jedes Segment der Zeile mit einem der Koepfe beginnt.
 * @param {unknown} command
 * @param {string[]} heads
 */
export function commandAllowedAny(command, heads) {
  const list = (heads || []).filter(Boolean);
  if (list.length === 0) return false;
  const segments = splitSegments(command);
  if (!segments) return false;
  const head = new RegExp(`^(?:${list.map(escapeRe).join('|')})(\\s|$)`);
  return segments.every((s) => head.test(s.trim()));
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
  } catch {
    return false;
  }
  if (!IMAGE_EXT.has(extname(file).toLowerCase())) return false;
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
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

// Wie toolLockFromJsonl: Claude Code weist ein per --tools gesperrtes Werkzeug mit diesem Wortlaut ab.
const unavailable = (c) => c.is_error === true
  && c.result_text.startsWith(`<tool_use_error>Error: No such tool available: ${c.name}. `);
const denied = (c) => /denied|not allowed|permission|blocked/i.test(c.result_text) || c.result_text.includes(READ_DENY_REASON) || unavailable(c);

/**
 * Sperr-Nachweis einer Sitzung. Eigen sind Write, MCP-Aufrufe mit mcpPrefix, Bash-Zeilen nach commandAllowedAny
 * und (mit readRoot) Read-Aufrufe nach readAllowed. Ohne readRoot zaehlt Read wie jedes fremde Werkzeug.
 * @param {string} jsonlText
 * @param {{ mcpPrefix?: string, heads?: string[], readRoot?: string }} opts
 */
export function toolLockMulti(jsonlText, { mcpPrefix, heads = [], readRoot } = {}) {
  const calls = parseCalls(jsonlText);
  const own = (c) => c.name === 'Write'
    || (Boolean(mcpPrefix) && c.name.startsWith(mcpPrefix))
    || (c.name === 'Bash' && commandAllowedAny(c.input?.command, heads));
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
