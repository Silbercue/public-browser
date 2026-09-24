import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pressKeySchema, pressKeyHandler, resolveKey, parseKeyCombo } from "./press-key.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// S7: press_key verhaelt sich auf macOS anders (Control-Hinweis, Editing-
// Commands). Alle Tests laufen darum mit festgelegter Plattform — Linux,
// ausser ein Test setzt ausdruecklich "darwin".
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { ...REAL_PLATFORM, value: platform });
}
beforeEach(() => setPlatform("linux"));
afterEach(() => Object.defineProperty(process, "platform", REAL_PLATFORM));

function createMockCdp() {
  const sendFn = vi.fn().mockResolvedValue({});
  const cdpClient = {
    send: sendFn,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
  return { cdpClient, sendFn };
}

describe("pressKeySchema", () => {
  it("should accept key only", () => {
    const result = pressKeySchema.parse({ key: "Enter" });
    expect(result.key).toBe("Enter");
    expect(result.modifiers).toBeUndefined();
  });

  it("should accept key with modifiers", () => {
    const result = pressKeySchema.parse({ key: "k", modifiers: ["ctrl"] });
    expect(result.key).toBe("k");
    expect(result.modifiers).toEqual(["ctrl"]);
  });
});

describe("resolveKey", () => {
  it("should resolve special keys", () => {
    expect(resolveKey("Enter").def.keyCode).toBe(13);
    expect(resolveKey("Escape").def.keyCode).toBe(27);
    expect(resolveKey("Tab").def.keyCode).toBe(9);
    expect(resolveKey("ArrowDown").def.keyCode).toBe(40);
  });

  it("should resolve letter keys", () => {
    const { key, def } = resolveKey("k");
    expect(key).toBe("k");
    expect(def.code).toBe("KeyK");
    expect(def.keyCode).toBe(75);
    expect(def.text).toBe("k");
  });

  it("should resolve digit keys", () => {
    const { def } = resolveKey("5");
    expect(def.code).toBe("Digit5");
    expect(def.keyCode).toBe(53);
    expect(def.text).toBe("5");
  });

  it("should resolve Space by name", () => {
    expect(resolveKey("Space").def.keyCode).toBe(32);
    expect(resolveKey("Space").def.text).toBe(" ");
  });
});

describe("parseKeyCombo", () => {
  it("zerlegt Ctrl+K in ctrl-Bit und die Taste k", () => {
    expect(parseKeyCombo("Ctrl+K")).toEqual({ key: "k", modifiers: 2 });
    // Gegenprobe: die Langform heisst dasselbe.
    expect(parseKeyCombo("Control+k")).toEqual({ key: "k", modifiers: 2 });
  });

  it("kombiniert mehrere Modifier und kennt die Mac-Namen", () => {
    // Cmd = meta (4) + Shift (8) = 12
    expect(parseKeyCombo("Cmd+Shift+P")).toEqual({ key: "p", modifiers: 12 });
    expect(parseKeyCombo("Command+Option+f")).toEqual({ key: "f", modifiers: 5 });
  });

  it("laesst einfache Tasten und unbekannte Praefixe unveraendert", () => {
    expect(parseKeyCombo("Enter")).toEqual({ key: "Enter", modifiers: 0 });
    expect(parseKeyCombo("a")).toEqual({ key: "a", modifiers: 0 });
    // Kein Modifier-Name vorn: die Zeichenkette bleibt, wie sie ist.
    expect(parseKeyCombo("Foo+K")).toEqual({ key: "Foo+K", modifiers: 0 });
    // Das Pluszeichen selbst ist keine Kombination.
    expect(parseKeyCombo("+")).toEqual({ key: "+", modifiers: 0 });
  });

  it("behaelt mehrstellige Tastennamen hinter einem Modifier", () => {
    expect(parseKeyCombo("Ctrl+Enter")).toEqual({ key: "Enter", modifiers: 2 });
  });
});

describe("pressKeyHandler mit Kombi-Schreibweise", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schickt fuer key: \"Ctrl+K\" ctrl-Bit und KeyK statt einer Phantomtaste", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    await pressKeyHandler({ key: "Ctrl+K" }, cdpClient, "s1");
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn.mock.calls[0][1].modifiers).toBe(2);
    expect(sendFn.mock.calls[0][1].key).toBe("k");
    expect(sendFn.mock.calls[0][1].code).toBe("KeyK");
    expect(sendFn.mock.calls[0][1].windowsVirtualKeyCode).toBe(75);
  });

  it("schickt fuer key: \"Cmd+Shift+P\" meta+shift", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    await pressKeyHandler({ key: "Cmd+Shift+P" }, cdpClient, "s1");
    expect(sendFn.mock.calls[0][1].modifiers).toBe(12);
    expect(sendFn.mock.calls[0][1].code).toBe("KeyP");
    // Codex-Abnahme Finding #5: bei gehaltenem Shift ist KeyboardEvent.key der
    // GROSSE Buchstabe — Handler, die auf e.key === "P" pruefen, brauchen das.
    expect(sendFn.mock.calls[0][1].key).toBe("P");
  });

  it("laesst eine einfache Taste unveraendert", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    await pressKeyHandler({ key: "Enter" }, cdpClient, "s1");
    expect(sendFn.mock.calls[0][1].key).toBe("Enter");
    expect(sendFn.mock.calls[0][1].modifiers).toBe(0);
    expect(sendFn.mock.calls[0][1].windowsVirtualKeyCode).toBe(13);
  });

  it("verodert die Kombi mit dem modifiers-Parameter", async () => {
    const { cdpClient, sendFn } = createMockCdp();
    await pressKeyHandler({ key: "Ctrl+K", modifiers: ["shift"] }, cdpClient, "s1");
    // ctrl (2) aus der Kombi + shift (8) aus dem Parameter = 10
    expect(sendFn.mock.calls[0][1].modifiers).toBe(10);
    // Shift kommt hier ueber den modifiers-Parameter statt aus der Kombi —
    // die Gross-/Kleinschreibung von `key` folgt dem verodert Ergebnis
    // (Codex-Abnahme Finding #5), darum "K" statt "k".
    expect(sendFn.mock.calls[0][1].key).toBe("K");
    expect(sendFn.mock.calls[0][1].code).toBe("KeyK");
  });
});

describe("pressKeyHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("S7: sends a printable character once — keyDown with text, then keyUp, no char event", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const result = await pressKeyHandler({ key: "a" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Pressed a" }),
    );

    // 2 events: keyDown (carries the text) + keyUp. A third "char" event
    // made Chrome insert every character twice ("HHeelllloo").
    expect(sendFn).toHaveBeenCalledTimes(2);
    const calls = sendFn.mock.calls;
    expect(calls[0][0]).toBe("Input.dispatchKeyEvent");
    expect(calls[0][1].type).toBe("keyDown");
    expect(calls[0][1].key).toBe("a");
    expect(calls[0][1].text).toBe("a");
    expect(calls[1][1].type).toBe("keyUp");
    expect(calls[1][1].key).toBe("a");
    expect(calls.some((c: unknown[]) => (c[1] as { type?: string }).type === "char")).toBe(false);
  });

  it("S7: Enter inserts one line break — its text goes out once, no char event", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    await pressKeyHandler({ key: "Enter" }, cdpClient, "s1");

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn.mock.calls[0][1]).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" });
    expect(sendFn.mock.calls[1][1]).toMatchObject({ type: "keyUp", key: "Enter" });
  });

  it("should dispatch rawKeyDown + keyUp for non-printable key (Escape)", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const result = await pressKeyHandler({ key: "Escape" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Pressed Escape" }),
    );

    // 2 events: rawKeyDown, keyUp (no char event for non-printable)
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn.mock.calls[0][1].type).toBe("rawKeyDown");
    expect(sendFn.mock.calls[0][1].windowsVirtualKeyCode).toBe(27);
    expect(sendFn.mock.calls[1][1].type).toBe("keyUp");
  });

  it("should dispatch with modifiers for Ctrl+K (no text)", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    const result = await pressKeyHandler({ key: "k", modifiers: ["ctrl"] }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Pressed ctrl+k" }),
    );

    // 2 events: rawKeyDown + keyUp (no char because modifier suppresses text)
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(sendFn.mock.calls[0][1].modifiers).toBe(2); // Ctrl = 2
    expect(sendFn.mock.calls[0][1].type).toBe("rawKeyDown");
    // No text field when modifier is held
    expect(sendFn.mock.calls[0][1].text).toBeUndefined();
  });

  it("should combine multiple modifiers (Ctrl+Shift)", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    await pressKeyHandler({ key: "a", modifiers: ["ctrl", "shift"] }, cdpClient, "s1");

    // Ctrl=2, Shift=8 → modifiers=10
    expect(sendFn.mock.calls[0][1].modifiers).toBe(10);
  });

  it("should use correct session ID", async () => {
    const { cdpClient, sendFn } = createMockCdp();

    await pressKeyHandler({ key: "Enter" }, cdpClient, "session-42");

    for (const call of sendFn.mock.calls) {
      expect(call[2]).toBe("session-42");
    }
  });
});

describe("S7: Control shortcuts on macOS", () => {
  function mockWithEditorStates(states: Array<string | null>) {
    const sendFn = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { value: states.shift() ?? null } };
      return {};
    });
    const cdpClient = { send: sendFn, on: vi.fn(), once: vi.fn(), off: vi.fn() } as unknown as CdpClient;
    return { cdpClient, sendFn };
  }

  it("Control+B that changes nothing in the focused editor answers with the Meta hint", async () => {
    setPlatform("darwin");
    const { cdpClient, sendFn } = mockWithEditorStates(["h:Hello World|6-11:5", "h:Hello World|6-11:5"]);

    const result = await pressKeyHandler({ key: "b", modifiers: ["ctrl"] }, cdpClient, "s1");

    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain("Pressed ctrl+b");
    expect(text).toContain("Control+B changed nothing in the focused editor");
    expect(text).toContain("On macOS use Meta instead of Control");
    // No silent remapping: the key event still carries Control (bit 2), not Meta.
    const keyDown = sendFn.mock.calls.find((c) => c[0] === "Input.dispatchKeyEvent")!;
    expect((keyDown[1] as { modifiers: number }).modifiers).toBe(2);
  });

  it("Control+B that changed the editor gets no hint", async () => {
    setPlatform("darwin");
    const { cdpClient } = mockWithEditorStates(["h:Hello World|6-11:5", "h:Hello <b>World</b>|0-5:5"]);

    const result = await pressKeyHandler({ key: "Ctrl+B" }, cdpClient, "s1");

    expect((result.content[0] as { text: string }).text).not.toContain("Hint:");
  });

  it("Control+K with the focus outside any editor gets no hint and no second probe", async () => {
    setPlatform("darwin");
    const { cdpClient, sendFn } = mockWithEditorStates([null]);

    const result = await pressKeyHandler({ key: "k", modifiers: ["ctrl"] }, cdpClient, "s1");

    expect((result.content[0] as { text: string }).text).toBe("Pressed ctrl+k");
    expect(sendFn.mock.calls.filter((c) => c[0] === "Runtime.evaluate")).toHaveLength(1);
  });

  it("on Linux Control+B probes nothing and adds no hint", async () => {
    const { cdpClient, sendFn } = mockWithEditorStates([]);

    const result = await pressKeyHandler({ key: "b", modifiers: ["ctrl"] }, cdpClient, "s1");

    expect((result.content[0] as { text: string }).text).toBe("Pressed ctrl+b");
    expect(sendFn.mock.calls.filter((c) => c[0] === "Runtime.evaluate")).toHaveLength(0);
  });

  it("reads the editor again only after a frame pause, so editors that render asynchronously get no false hint", async () => {
    setPlatform("darwin");
    const { cdpClient, sendFn } = mockWithEditorStates(["h:Hello World|6-11:5", "h:Hello <b>World</b>|0-5:5"]);

    await pressKeyHandler({ key: "b", modifiers: ["ctrl"] }, cdpClient, "s1");

    const evals = sendFn.mock.calls.filter((c) => c[0] === "Runtime.evaluate");
    expect(evals).toHaveLength(2);
    const before = evals[0][1] as { expression: string; awaitPromise?: boolean };
    const after = evals[1][1] as { expression: string; awaitPromise?: boolean };
    expect(before.awaitPromise).toBeUndefined();
    expect(after.awaitPromise).toBe(true);
    expect(after.expression).toContain("requestAnimationFrame");
    expect(after.expression).toContain("setTimeout");
    // the pause starts after the key was released
    const keyUp = sendFn.mock.calls.findIndex((c) => (c[1] as { type?: string } | undefined)?.type === "keyUp");
    expect(sendFn.mock.calls.indexOf(evals[1])).toBeGreaterThan(keyUp);
  });

  it("Meta+A / Meta+Z / Meta+Shift+Z carry the macOS editing commands", async () => {
    setPlatform("darwin");
    const cases: Array<[string, string[]]> = [["Meta+A", ["selectAll"]], ["Meta+Z", ["undo"]], ["Meta+Shift+Z", ["redo"]]];
    for (const [key, commands] of cases) {
      const { cdpClient, sendFn } = mockWithEditorStates([]);
      await pressKeyHandler({ key }, cdpClient, "s1");
      expect(sendFn.mock.calls[0][1]).toMatchObject({ type: "rawKeyDown", commands });
    }
  });

  it("Meta+A on Linux carries no editing command", async () => {
    const { cdpClient, sendFn } = mockWithEditorStates([]);
    await pressKeyHandler({ key: "Meta+A" }, cdpClient, "s1");
    expect((sendFn.mock.calls[0][1] as { commands?: string[] }).commands).toBeUndefined();
  });
});
