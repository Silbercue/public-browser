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

export const CONFIG_DENY_REASON = 'blocked by benchmark harness: configuration files of the browser tools and files named like an option or a sub-command (-x, connect, attach ...) cannot be created in the session folder.';
/**
 * Konfigurationsdateien, die ein Browser-Werkzeug beim Start aus dem Sitzungsordner liest (agent-browser.json,
 * .playwright/*, *.config.json, .agent-browser*): ein Agent koennte damit Browser, Profil oder Andock-Adresse waehlen.
 * Geprueft werden alle Pfadteile, ohne Gross-/Kleinschreibung.
 * @param {unknown} filePath
 */
export function protectedConfigPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return filePath.split(/[\\/]+/).some((part) => {
    const p = part.toLowerCase();
    return p === 'agent-browser.json' || p.startsWith('.agent-browser') || p.startsWith('.playwright') || p.endsWith('.config.json') || p.startsWith('-') || FOREIGN_BROWSER_CMD.has(p);
  });
}

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
    if (!tok || tok.startsWith('-') || /[$~*?[\]{}\\!"']/.test(tok) || protectedConfigPath(tok)) return false;
    if (!pathInside(tok, pathRoot)) return false;
  }
  return true;
}

// Befehlsoptionen der Browser-Werkzeuge, mit denen sich ein Teilnehmer an einen fremden Browser haengen (z. B. Julians
// Chrome mit seinen Anmeldungen auf Port 9222/9223), ein anderes Profil, einen anderen Browser oder eine eigene
// Konfiguration waehlen koennte. Sie sind in den Anleitungen von agent-browser und playwright-cli beschrieben,
// gehoeren aber nicht zu einer Sitzung im gemeinsamen, frischen Google Chrome. Geprueft wird Wort fuer Wort nach dem
// Entfernen von Anfuehrungszeichen und Backslashes (so wie die Shell es zerlegt), nicht am Rohtext; `p` und `b` sind die
// Kurzformen von --provider und --browser.
// `headed`/`headless`: alle Teilnehmer laufen ohne sichtbares Fenster (`--headed`, `--no-headless`, `--headless=false`);
// `namespace`: ein eigener agent-browser-Namensraum laege ausserhalb dessen, den das Aufraeumen kennt.
const FOREIGN_LONG_OPTS = ['cdp', 'auto-connect', 'autoconnect', 'extension', 'profile', 'persistent', 'endpoint', 'config', 'browser', 'engine', 'executable-path', 'provider', 'device', 'mobile', 'ios', 'args', 'user-data-dir', 'remote-debugging-port', 'remote-debugging-pipe', 'channel', 'headed', 'headless', 'no-headless', 'namespace'];
// Echte Optionen der Werkzeuge, deren voller Name zugleich Anfang eines verbotenen Namens ist (`--name` bei find, nicht `--namespace`).
const EXACT_ALLOWED_OPTS = new Set(['name']);
/**
 * Verbotene Option? Langformen auch als Abkuerzung (Praefix eines verbotenen Namens, viele Parser nehmen `--prof`),
 * jedes Einzelstrich-Wort (ausser reinen Zahlen) mit dem Buchstaben p oder b (Kurzformen von --provider/--browser, auch gebuendelt wie `-xp`)
 * und Einzelstrich-Schreibweise eines verbotenen Namens (`-engine`).
 * @param {string} w
 */
function foreignOption(w) {
  if (w.startsWith('--')) {
    const name = w.slice(2).split('=')[0].toLowerCase();
    if (EXACT_ALLOWED_OPTS.has(name)) return false;
    return name !== '' && FOREIGN_LONG_OPTS.some((n) => n.startsWith(name));
  }
  if (w.startsWith('-') && !/^-\d+(?:\.\d+)?$/.test(w)) {
    const name = w.slice(1).split('=')[0].toLowerCase();
    return /[pb]/.test(name) || FOREIGN_LONG_OPTS.some((n) => name.startsWith(n));
  }
  return false;
}
// Unterbefehle, die einen anderen Browser anbinden oder Werkzeug, Plugins und Konfiguration veraendern. Gesperrt, wenn
// IRGENDEIN Wort der Zeile so lautet (nicht nur die ersten beiden: Optionen koennen davor stehen).
const FOREIGN_BROWSER_CMD = new Set(['attach', 'connect', 'install', 'install-browser', 'upgrade', 'plugin', 'dashboard', 'chat', 'profiles', 'config']);
// Kein Browser-Werkzeug: Hilfsbefehle des Ablaufs und das Shim run-my-test.
const NON_BROWSER_HEADS = new Set([...PATH_HEADS, 'sleep', 'run-my-test']);

/**
 * Zerlegt ein Segment wie die Shell in Woerter (Anfuehrungszeichen und Backslashes entfernt). null = nicht sicher
 * zerlegbar: ein ungequotetes `*`, `?`, `[` oder fuehrendes `~` (ausser in einer Adresse scheme://), `$` ausserhalb von Einfach-Anfuehrungszeichen, wo es eine Expansion einleiten kann (Variablen koennten Optionen
 * ergeben), und eine Klammer-Expansion `{a,b}` / `{1..3}` ausserhalb von Anfuehrungszeichen.
 * @param {string} segment
 * @returns {string[] | null}
 */
export function shellWords(segment) {
  const text = String(segment ?? '');
  const words = [];
  let cur = '';
  let inWord = false;
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q === "'") { if (ch === "'") q = null; else cur += ch; continue; }
    if (q === '"') {
      if (ch === '"') { q = null; continue; }
      if (ch === '$' && /[A-Za-z0-9_{(\[@*#?$!-]/.test(text[i + 1] ?? '')) return null;
      // Zeilenfortsetzung: Backslash und Zeilenumbruch verschwinden beide (wie in der Shell).
      if (ch === '\\' && text[i + 1] === '\n') { i++; continue; }
      if (ch === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) { cur += text[i + 1]; i++; continue; }
      cur += ch; continue;
    }
    // Zeilenfortsetzung ausserhalb von Anfuehrungszeichen: beide Zeichen entfallen, das Wort laeuft weiter (`--c\<Umbruch>dp` ist `--cdp`).
    if (ch === '\\' && text[i + 1] === '\n') { i++; continue; }
    if (ch === '\\') { cur += text[i + 1] ?? ''; inWord = true; i++; continue; }
    if (ch === "'" || ch === '"') { q = ch; inWord = true; continue; }
    if (ch === '$') return null;
    // Platzhalter und ~ liefert die Shell als Dateinamen (z. B. eine Datei `--cdp`, die der Agent angelegt hat): nur in einer
    // Adresse (scheme://...) bleiben sie Text, sonst nicht sicher zerlegbar.
    if ((ch === '*' || ch === '?' || ch === '[' || (ch === '~' && !inWord)) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(cur)) return null;
    if (ch === '{') {
      // Klammer-Expansion nur mit Komma oder `..` zwischen { und der naechsten }; ein Platzhalter wie {SESSION} bleibt Text.
      const close = text.indexOf('}', i);
      if (close >= 0 && /,|\.\./.test(text.slice(i + 1, close))) return null;
    }
    if (/\s/.test(ch)) { if (inWord) { words.push(cur); cur = ''; inWord = false; } continue; }
    cur += ch; inWord = true;
  }
  if (q) return null;
  if (inWord) words.push(cur);
  return words;
}

// Aufbau der Befehlszeile je Werkzeug (gepinnte Versionen, aus `--help` und den ausgelieferten Skill-Dateien):
// - flags: Optionen ohne Wert. Jede andere Option nimmt vorsichtshalber das naechste Wort als Wert (so liegt der
//   Unterbefehl, den das Werkzeug sieht, nie hinter dem hier bestimmten: alle Woerter bis dorthin werden streng geprueft).
// - flagValues: Werte, die ein Schalter trotzdem nehmen kann (agent-browser: `--json false`).
// - free: Bedien-Unterbefehle; ihre Nicht-Options-Woerter sind Eingabetext (`fill @e3 "Connect"`), keine Unterbefehle.
// - nested: Unterbefehle, deren Argumente selbst Befehle sind (agent-browser batch): jedes wird als eigener Befehl geprueft.
const TOOL_SYNTAX = {
  'agent-browser': {
    flags: new Set(['json', 'webgpu', 'no-webmcp', 'pin-tab', 'no-pin-tab', 'content-boundaries', 'confirm-interactive', 'no-auto-dialog', 'ignore-https-errors',
      'no-ca-cert', 'use-system-ca', 'allow-file-access', 'annotate', 'debug', 'verbose', 'v', 'quiet', 'q', 'version', 'V', 'help', 'h', 'bail']),
    flagValues: new Set(['true', 'false']),
    free: new Set(['open', 'goto', 'navigate', 'read', 'click', 'dblclick', 'type', 'fill', 'press', 'key', 'keyboard', 'keydown', 'keyup', 'hover', 'focus', 'check',
      'uncheck', 'select', 'drag', 'upload', 'download', 'scroll', 'scrollintoview', 'wait', 'screenshot', 'pdf', 'snapshot', 'eval', 'close', 'quit', 'exit', 'back',
      'forward', 'reload', 'get', 'is', 'find', 'mouse', 'set', 'network', 'cookies', 'storage', 'tab', 'frame', 'diff', 'trace', 'profiler', 'record', 'console',
      'errors', 'highlight', 'clipboard', 'webmcp', 'react', 'vitals', 'a11y', 'pushstate', 'removeinitscript', 'state', 'dialog', 'confirm', 'deny', 'session']),
    nested: new Set(['batch']),
  },
  'playwright-cli': {
    // minimist mit booleanOptions aus help.json und program.js von @playwright/cli 0.1.22
    flags: new Set(['headed', 'mobile', 'persistent', 'submit', 'boxes', 'clear', 'full-page', 'hires', 'httpOnly', 'secure', 'static', 'global', 'with-deps', 'dry-run',
      'list', 'force', 'only-shell', 'no-shell', 'cursor', 'annotate', 'kill', 'hide', 'all', 'g', 'help', 'json', 'raw', 'version']),
    flagValues: new Set(['true', 'false']), // minimist nimmt true/false auch nach einem Schalter
    free: new Set(['open', 'close', 'goto', 'type', 'click', 'dblclick', 'fill', 'drag', 'drop', 'hover', 'select', 'upload', 'check', 'uncheck', 'snapshot', 'find', 'eval',
      'console', 'dialog-accept', 'dialog-dismiss', 'resize', 'run-code', 'delete-data', 'go-back', 'go-forward', 'reload', 'press', 'keydown', 'keyup', 'mousemove',
      'mousedown', 'mouseup', 'mousewheel', 'screenshot', 'pdf', 'tab-list', 'tab-new', 'tab-close', 'tab-select', 'state-load', 'state-save', 'cookie-list', 'cookie-get',
      'cookie-set', 'cookie-delete', 'cookie-clear', 'localstorage-list', 'localstorage-get', 'localstorage-set', 'localstorage-delete', 'localstorage-clear',
      'sessionstorage-list', 'sessionstorage-get', 'sessionstorage-set', 'sessionstorage-delete', 'sessionstorage-clear', 'set-color-scheme', 'set-reduced-motion',
      'set-forced-colors', 'set-contrast', 'set-media', 'clear-color-scheme', 'clear-reduced-motion', 'clear-forced-colors', 'clear-contrast', 'clear-media', 'requests',
      'request', 'request-headers', 'request-body', 'response-headers', 'response-body', 'route', 'route-list', 'unroute', 'network-state-set', 'recording-start',
      'recording-stop', 'tracing-start', 'tracing-stop', 'video-start', 'video-stop', 'video-chapter', 'video-show-actions', 'video-hide-actions', 'generate-locator',
      'highlight', 'webmcp-list', 'webmcp-call']),
    nested: new Set(),
  },
};
// Browser- und Engine-Namen: `eval -b firefox` ist kein Base64-Skript.
const BROWSER_NAMES = new Set(['chrome', 'chromium', 'firefox', 'webkit', 'msedge', 'edge', 'safari']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const forbiddenWord = (w, syn) => FOREIGN_BROWSER_CMD.has(w.toLowerCase()) || Boolean(syn?.nested.has(w.toLowerCase()));

/**
 * Wortliste (ohne Kopf) eines Werkzeugs pruefen. true = gesperrt.
 * @param {string} head
 * @param {string[]} rest
 * @param {number} depth Verschachtelungstiefe (batch in batch)
 */
function foreignArgv(head, rest, depth = 0) {
  const syn = TOOL_SYNTAX[head];
  // Einzige Ausnahme fuer -b: `agent-browser eval -b <Base64>` (steht so in der agent-browser-Anleitung), eval direkt nach dem
  // Kopf, -b direkt danach, gueltiges Base64, kein Browsername. Danach Eingabetext wie bei eval.
  const evalB = head === 'agent-browser' && depth === 0 && rest[0] === 'eval' && rest[1] === '-b' && typeof rest[2] === 'string'
    && BASE64.test(rest[2]) && !BROWSER_NAMES.has(rest[2].toLowerCase());
  if (evalB) return rest.slice(3).some(foreignOption);
  // Unbekanntes Werkzeug: jedes Wort streng.
  const strict = (words) => words.some((w) => foreignOption(w) || forbiddenWord(w, syn));
  if (!syn) return strict(rest);
  // Optionen vor dem Unterbefehl ueberspringen; ihre Werte duerfen weder verbotene noch verschachtelnde Unterbefehle sein.
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-') && rest[i] !== '-') {
    const w = rest[i];
    if (foreignOption(w)) return true;
    const name = w.replace(/^--?/, '').split('=')[0];
    const takesValue = !w.includes('=') && !syn.flags.has(name);
    const next = rest[i + 1];
    const consumes = next !== undefined && !next.startsWith('-') && (takesValue || syn.flagValues.has(next));
    if (consumes && forbiddenWord(next, syn)) return true;
    i += consumes ? 2 : 1;
  }
  // Verschachtelt (in batch) muss ein Unterbefehl folgen, und vor ihm steht kein Wort mit Leerraum.
  if (depth > 0 && (i >= rest.length || rest.slice(0, i + 1).some((w) => /\s/.test(w)))) return true;
  if (i >= rest.length) return false;
  const cmd = rest[i];
  const args = rest.slice(i + 1);
  // Gross-/Kleinschreibung zaehlt hier nicht (`Batch`, `Connect`): im Zweifel gilt die gefaehrlichere Lesart.
  if (forbiddenWord(cmd, null)) return true;
  if (syn.nested.has(cmd.toLowerCase())) {
    if (depth >= 2) return true;
    return args.some((a) => {
      if (a.startsWith('-')) return foreignOption(a) || !syn.flags.has(a.replace(/^--?/, ''));
      // JSON-Liste von Woertern (Form der Anleitung) oder Befehl als Text; Text nur ohne Anfuehrungszeichen und Backslashes,
      // damit die Zerlegung eindeutig ist. Alles andere ist gesperrt.
      let argv = null;
      try {
        const v = JSON.parse(a);
        if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) argv = v;
      } catch { if (!/["'\\[{]/.test(a)) argv = shellWords(a); }
      return !argv || argv.length === 0 || foreignArgv(head, argv, depth + 1);
    });
  }
  // Verschachtelt (in batch) nur ein bekannter Bedien-Unterbefehl.
  if (depth > 0 && !syn.free.has(cmd)) return true;
  // Bedien-Unterbefehl: Optionen weiter pruefen, uebrige Woerter sind Eingabetext. Sonst wie bisher: jedes Wort streng.
  return syn.free.has(cmd) ? args.some(foreignOption) : strict(args);
}

/**
 * true, wenn das Segment (Befehlskopf + Argumente) einen fremden Browser, ein fremdes Profil, einen anderen Browser oder ein
 * sichtbares Fenster verlangt, oder sich nicht sicher zerlegen laesst. Anfuehrungszeichen, Backslashes und Zeilenfortsetzungen
 * zaehlen nicht als Tarnung: `"--cdp"`, `--c""dp`, `\-\-cdp` sind dieselbe Option wie `--cdp`. Ein Eingabewert, der wie eine
 * Option aussieht (`"--cdp"`), wird vorsichtshalber ebenfalls abgelehnt. Fuer agent-browser und playwright-cli wird der
 * Unterbefehl bestimmt: verbotene Unterbefehle sind ueberall gesperrt, wo sie Unterbefehl sein koennten; die Argumente eines
 * Bedien-Unterbefehls (fill, type, find, click ...) sind freier Text.
 * @param {string} segment
 */
export function foreignBrowserRequest(segment) {
  const words = shellWords(String(segment).trim());
  if (!words) return true;
  const [head, ...rest] = words;
  if (NON_BROWSER_HEADS.has(head)) return false;
  return foreignArgv(head, rest);
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
    if (foreignBrowserRequest(t)) return false;
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
  if (protectedConfigPath(filePath)) return false;
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
  const own = (c) => (c.name === 'Write' && !protectedConfigPath(c.input?.file_path) && (!writeRoot || writeAllowed(c.input?.file_path, writeRoot)))
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
