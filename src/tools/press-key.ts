import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { toolSequence } from "../telemetry/tool-sequence.js";
import { FRAME_PAUSE_EXPRESSION } from "./frame-pause.js";

// --- Schema ---

export const pressKeySchema = z.object({
  key: z
    .string()
    .describe("Key to press, e.g. 'Enter'; printable chars as-is"),
  ref: z
    .string()
    .optional()
    .describe("Element ref to focus first"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector to focus first"),
  modifiers: z
    .array(z.enum(["ctrl", "shift", "alt", "meta"]))
    .optional()
    .describe("Modifier keys held during the press"),
});

export type PressKeyParams = z.infer<typeof pressKeySchema>;

// --- Key definitions ---

interface KeyDef {
  code: string;
  keyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  " ": { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  F1: { code: "F1", keyCode: 112 },
  F2: { code: "F2", keyCode: 113 },
  F3: { code: "F3", keyCode: 114 },
  F4: { code: "F4", keyCode: 115 },
  F5: { code: "F5", keyCode: 116 },
  F6: { code: "F6", keyCode: 117 },
  F7: { code: "F7", keyCode: 118 },
  F8: { code: "F8", keyCode: 119 },
  F9: { code: "F9", keyCode: 120 },
  F10: { code: "F10", keyCode: 121 },
  F11: { code: "F11", keyCode: 122 },
  F12: { code: "F12", keyCode: 123 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

const MODIFIER_ALIASES: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  meta: "meta",
  cmd: "meta",
  command: "meta",
};

/**
 * Zerlegt die Kombi-Schreibweise ("Ctrl+K", "Cmd+Shift+P") in Modifier-Bits und
 * die eigentliche Taste. Ohne diese Zerlegung landete "Ctrl+K" als unbekannte
 * Taste in `resolveKey` und wurde als Phantomtaste an CDP geschickt.
 * Nicht-Kombinationen und unbekannte Praefixe kommen unveraendert zurueck.
 */
export function parseKeyCombo(raw: string): { key: string; modifiers: number } {
  const parts = raw.split("+");
  if (parts.length < 2 || parts.some((p) => p === "")) return { key: raw, modifiers: 0 };

  let bits = 0;
  for (const token of parts.slice(0, -1)) {
    const name = MODIFIER_ALIASES[token.toLowerCase()];
    if (name === undefined) return { key: raw, modifiers: 0 };
    bits |= MODIFIER_BITS[name];
  }

  const last = parts[parts.length - 1];
  return { key: last.length === 1 ? last.toLowerCase() : last, modifiers: bits };
}

/** Resolve a key string to its CDP key definition */
export function resolveKey(key: string): { key: string; def: KeyDef } {
  // Special key (Enter, Escape, etc.)
  if (SPECIAL_KEYS[key]) {
    return { key, def: SPECIAL_KEYS[key] };
  }

  // Single character
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = upper.charCodeAt(0);

    // a-z / A-Z
    if (code >= 65 && code <= 90) {
      return {
        key,
        def: { code: `Key${upper}`, keyCode: code, text: key },
      };
    }
    // 0-9
    if (code >= 48 && code <= 57) {
      return {
        key,
        def: { code: `Digit${key}`, keyCode: code, text: key },
      };
    }
    // Other printable characters
    return {
      key,
      def: { code: "", keyCode: key.charCodeAt(0), text: key },
    };
  }

  // Unknown key — pass through as-is
  return { key, def: { code: key, keyCode: 0 } };
}

/**
 * S7: Zustand des fokussierten Editors (Wert bzw. innerHTML des Editing-Hosts
 * plus Auswahl). `null`, wenn der Fokus in keinem Textfeld/contenteditable liegt.
 */
const EDITOR_STATE_EXPRESSION = `(() => {
  var a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a) return null;
  var field = a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|search|email|url|tel|password|number)$/i.test(a.type || "text"));
  if (field) return "v:" + a.value + "|" + a.selectionStart + "-" + a.selectionEnd;
  if (!a.isContentEditable) return null;
  var host = a;
  while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
  var s = window.getSelection();
  return "h:" + host.innerHTML + "|" + (s ? s.anchorOffset + "-" + s.focusOffset + ":" + String(s).length : "");
})()`;

/**
 * S7 (Plancheck P33): the second read waits for the shared frame pause (two
 * animation frames, at most 100 ms), so editors that render asynchronously
 * after the key event get no false hint.
 */
const EDITOR_STATE_AFTER_PAUSE_EXPRESSION = `${FRAME_PAUSE_EXPRESSION}.then(function () { return ${EDITOR_STATE_EXPRESSION}; })`;

async function readEditorState(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  afterPause = false,
): Promise<string | null> {
  try {
    const res = await cdpClient.send<{ result?: { value?: string | null } }>(
      "Runtime.evaluate",
      afterPause
        ? { expression: EDITOR_STATE_AFTER_PAUSE_EXPRESSION, returnByValue: true, awaitPromise: true }
        : { expression: EDITOR_STATE_EXPRESSION, returnByValue: true },
      sessionId,
    );
    const value = res?.result?.value;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * S7: Auf macOS kommen Alles-markieren/Rueckgaengig/Wiederholen nicht aus
 * Blink, sondern aus dem Mac-Menue — per CDP gesendete Cmd+A/Z tun darum
 * nichts. Chrome nimmt sie als `commands` am keyDown an (wie Playwright).
 */
function macEditingCommands(letter: string, modBits: number): string[] | undefined {
  if (process.platform !== "darwin") return undefined;
  const l = letter.toLowerCase();
  if (modBits === MODIFIER_BITS.meta && l === "a") return ["selectAll"];
  if (modBits === MODIFIER_BITS.meta && l === "z") return ["undo"];
  if (modBits === (MODIFIER_BITS.meta | MODIFIER_BITS.shift) && l === "z") return ["redo"];
  return undefined;
}

// --- Handler ---

export async function pressKeyHandler(
  params: PressKeyParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Focus target element if ref or selector provided
  let effectiveSessionId = sessionId;
  if (params.ref || params.selector) {
    try {
      const target = params.ref ? { ref: params.ref } : { selector: params.selector };
      const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);
      effectiveSessionId = element.resolvedSessionId;

      await cdpClient.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function() { this.focus(); }",
          objectId: element.objectId,
          returnByValue: false,
        },
        element.resolvedSessionId,
      );
    } catch (err) {
      if (err instanceof RefNotFoundError && params.ref) {
        return {
          content: [{ type: "text", text: buildRefNotFoundError(params.ref) }],
          isError: true,
          _meta: { elapsedMs: Math.round(performance.now() - start), method: "press_key" },
        };
      }
      throw err;
    }
  }

  const combo = parseKeyCombo(params.key);
  const { key: resolvedKey, def } = resolveKey(combo.key);
  const modBits =
    (params.modifiers ?? []).reduce((acc, m) => acc | MODIFIER_BITS[m], 0) | combo.modifiers;

  // Codex-Abnahme Finding #5: `parseKeyCombo` normalisiert den Buchstaben auf
  // Kleinschreibung, damit `resolveKey` ihn trifft. Bei gehaltenem Shift ist
  // `KeyboardEvent.key` aber der GROSSE Buchstabe — Shortcut-Handler, die auf
  // `e.key === "P"` pruefen (statt auf `e.code`), fielen sonst durch.
  const key =
    (modBits & MODIFIER_BITS.shift) !== 0 && /^[a-z]$/i.test(resolvedKey)
      ? resolvedKey.toUpperCase()
      : resolvedKey;

  // Suppress text output when modifier keys are held (Ctrl+K should not type "k")
  const hasModifier = modBits > 0;
  const text = hasModifier ? undefined : def.text;

  // S7: Control+<Buchstabe> auf macOS — Editor-Zustand vorher merken, um
  // hinterher zu sehen, ob die Kombination etwas bewirkt hat.
  const isLetter = /^[a-z]$/i.test(resolvedKey);
  const ctrlLetterOnMac =
    process.platform === "darwin" &&
    isLetter &&
    (modBits === MODIFIER_BITS.ctrl || modBits === (MODIFIER_BITS.ctrl | MODIFIER_BITS.shift));
  const editorBefore = ctrlLetterOnMac ? await readEditorState(cdpClient, effectiveSessionId) : null;
  const commands = isLetter ? macEditingCommands(resolvedKey, modBits) : undefined;

  // keyDown — ein keyDown mit `text` fuegt das Zeichen schon ein (inkl.
  // keypress). Ein zusaetzlicher `char`-Event lieferte jedes Zeichen doppelt
  // ("HHeelllloo", Enter als zwei Zeilenumbrueche) — S7.
  await cdpClient.send(
    "Input.dispatchKeyEvent",
    {
      type: text ? "keyDown" : "rawKeyDown",
      modifiers: modBits,
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      ...(text ? { text } : {}),
      ...(commands ? { commands } : {}),
    },
    effectiveSessionId,
  );

  // keyUp
  await cdpClient.send(
    "Input.dispatchKeyEvent",
    {
      type: "keyUp",
      modifiers: modBits,
      key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
    },
    effectiveSessionId,
  );

  const elapsedMs = Math.round(performance.now() - start);
  const modStr = params.modifiers?.length ? params.modifiers.join("+") + "+" : "";
  const targetStr = params.ref ? ` on ${params.ref}` : params.selector ? ` on ${params.selector}` : "";
  // BUG-018 follow-up (final review MEDIUM #5): press_key is declared
  // as a reset tool in tool-sequence.ts RESET_TOOLS but the handler
  // never actually recorded anything. A successful keyboard interaction
  // is just as valid a "happy path" signal as a click, so record it
  // here so the evaluate streak detector treats it the same way.
  toolSequence.record("press_key", undefined, sessionId);

  // S7: Hat Control+<Buchstabe> im Editor nichts veraendert, sagt die Antwort
  // das — auf macOS laufen die Editor-Kuerzel ueber Meta. Kein stilles Umbiegen.
  // Gelesen wird erst nach einer Frame-Pause (asynchron rendernde Editoren).
  let macHint = "";
  if (editorBefore !== null) {
    const editorAfter = await readEditorState(cdpClient, effectiveSessionId, true);
    if (editorAfter === editorBefore) {
      // Review I1: Shift bleibt im Rat — "Meta+Z" statt "Meta+Shift+Z" hiesse
      // Undo statt Redo. Alt kommt hier nicht an (ctrlLetterOnMac laesst nur
      // Control bzw. Control+Shift durch).
      const combo = ((modBits & MODIFIER_BITS.shift) !== 0 ? "Shift+" : "") + resolvedKey.toUpperCase();
      macHint = `\nHint: Control+${combo} changed nothing in the focused editor. On macOS use Meta instead of Control (key "Meta+${combo}").`;
    }
  }

  return {
    content: [{ type: "text", text: `Pressed ${modStr}${params.key}${targetStr}${macHint}` }],
    _meta: { elapsedMs, method: "press_key" },
  };
}
