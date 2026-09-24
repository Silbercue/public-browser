import { describe, it, expect } from "vitest";
import { substituteVars, extractResultValue } from "./plan-variables.js";
import type { ToolResponse } from "../types.js";

describe("substituteVars", () => {
  it("replaces $var in string value with variable value", () => {
    const result = substituteVars(
      { url: "$myUrl" },
      { myUrl: "https://example.com" },
    );
    expect(result).toEqual({ url: "https://example.com" });
  });

  it("replaces $var inline in longer string", () => {
    const result = substituteVars(
      { greeting: "Hello $name!" },
      { name: "World" },
    );
    expect(result).toEqual({ greeting: "Hello World!" });
  });

  it("preserves type for whole-string $var replacement", () => {
    const result = substituteVars({ count: "$num" }, { num: 42 });
    expect(result).toEqual({ count: 42 });
    expect(typeof result.count).toBe("number");
  });

  it("preserves boolean type for whole-string $var", () => {
    const result = substituteVars({ flag: "$enabled" }, { enabled: true });
    expect(result).toEqual({ flag: true });
    expect(typeof result.flag).toBe("boolean");
  });

  it("handles nested objects recursively", () => {
    const result = substituteVars(
      { opts: { url: "$url" } },
      { url: "https://test.com" },
    );
    expect(result).toEqual({ opts: { url: "https://test.com" } });
  });

  it("handles arrays", () => {
    const result = substituteVars(
      { items: ["$a", "$b"] },
      { a: "x", b: "y" },
    );
    expect(result).toEqual({ items: ["x", "y"] });
  });

  it("leaves unresolved $var as-is", () => {
    const result = substituteVars({ url: "$unknown" }, {});
    expect(result).toEqual({ url: "$unknown" });
  });

  it("empty vars returns params unchanged", () => {
    const params = { url: "https://example.com", count: 5 };
    const result = substituteVars(params, {});
    expect(result).toEqual(params);
  });

  it("no $var references returns params unchanged", () => {
    const params = { url: "https://example.com", flag: true };
    const result = substituteVars(params, { unused: "value" });
    expect(result).toEqual(params);
  });

  it("multiple $var references in same string", () => {
    const result = substituteVars(
      { path: "$base/$page" },
      { base: "/api", page: "users" },
    );
    expect(result).toEqual({ path: "/api/users" });
  });

  it("preserves object type for whole-string $var replacement", () => {
    const obj = { nested: true };
    const result = substituteVars({ data: "$obj" }, { obj });
    expect(result).toEqual({ data: { nested: true } });
  });

  it("handles null and undefined in vars", () => {
    const result = substituteVars({ a: "$x", b: "$y" }, { x: null, y: undefined });
    expect(result.a).toBe(null);
    expect(result.b).toBe(undefined);
  });

  it("does not substitute non-string values", () => {
    const result = substituteVars({ count: 42, flag: true, empty: null }, { count: 99 });
    expect(result).toEqual({ count: 42, flag: true, empty: null });
  });
});

describe("extractResultValue", () => {
  it("extracts text from ToolResponse", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: "Hello World" }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("Hello World");
  });

  it("parses JSON result", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: '{"key":"value"}' }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toEqual({ key: "value" });
  });

  it("returns raw text for non-JSON", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: "not json" }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("not json");
  });

  it("returns empty string for empty response", () => {
    const response: ToolResponse = {
      content: [],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("");
  });

  it("concatenates multiple text blocks", () => {
    const response: ToolResponse = {
      content: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("line1\nline2");
  });

  it("ignores non-text content blocks", () => {
    const response: ToolResponse = {
      content: [
        { type: "text", text: "text" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe("text");
  });

  it("parses number JSON result", () => {
    const response: ToolResponse = {
      content: [{ type: "text", text: "42" }],
      _meta: { elapsedMs: 1, method: "test" },
    };
    expect(extractResultValue(response)).toBe(42);
  });
});

// Stufe 1 (E5): saveAs speichert nur den Rohwert. In run5 #60 wurde
// `"NEEDLE-841JYJEE"` samt angehaengtem Tip in das Feld getippt (FAIL,
// eine Extra-Runde). Hinweise und von der Registry ergaenzte Bloecke
// gehoeren nie zum Wert.
describe("extractResultValue — only the raw value (Stufe 1, E5)", () => {
  const response = (...texts: string[]): ToolResponse => ({
    content: texts.map((text) => ({ type: "text" as const, text })),
    _meta: { elapsedMs: 1, method: "evaluate" },
  });
  const TIP =
    "\n\nTip: Reading .innerText/.textContent? The a11y tree already contains visible text. Try view_page(ref: 'eN', filter: 'all') — table cells, static codes, paragraphs all show up with stable refs.";
  const WARNING =
    "\n\nWarning: 3 consecutive querySelector-based evaluate calls detected. This usually means a ref went stale or a tool failed silently and you fell back to evaluate. Call view_page once for fresh refs, then continue with click/type/fill_form. evaluate is a last resort — routing around tool errors wastes tokens and hides real bugs.";
  const NOTICE =
    "\n\nNotice: 5 consecutive evaluate calls. Consider: navigate(url) for cross-page moves, view_page(filter:\"all\") for exhaustive refs, scroll / click / type / fill_form for interaction. evaluate is for JS computation, not for routing around failed tool calls. Dedicated tools that may help: scroll, handle_dialog, network_monitor, wait_for.";
  const NOTE =
    "\n\nNote: 82 interactive elements are hidden (display: none). Click tabs/buttons to reveal hidden sections.";

  it("cuts an appended Tip (run5 #60)", () => {
    expect(extractResultValue(response(`"NEEDLE-841JYJEE"${TIP}`))).toBe("NEEDLE-841JYJEE");
  });

  it("cuts an appended Warning (evaluate streak, tier 1)", () => {
    expect(extractResultValue(response(`7${WARNING}`))).toBe(7);
  });

  it("cuts an appended Notice (evaluate streak, tier 2)", () => {
    expect(extractResultValue(response(`{"a":1}${NOTICE}`))).toEqual({ a: 1 });
  });

  it("cuts an appended Note", () => {
    expect(extractResultValue(response(`"PASS"${NOTE}`))).toBe("PASS");
  });

  it("cuts several hints in a row", () => {
    expect(extractResultValue(response(`"PASS | Needle found!"${TIP}${TIP}${WARNING}`))).toBe("PASS | Needle found!");
  });

  it("drops the DOM diff block of an earlier click", () => {
    const diff = '--- Action Result (3 changes) — /#step-gamma ---\n NEW    StaticText "PASS"\n REMOVED StaticText "PENDING"';
    expect(extractResultValue(response(diff, '"NEEDLE-841JYJEE"'))).toBe("NEEDLE-841JYJEE");
  });

  it("drops dialog, download and relaunch notices", () => {
    const dialog = '[dialog] alert: "Saved"';
    const download = "--- Download completed ---\nFile: report.csv\nPath: /tmp/report.csv\nSize: 1 KB";
    const relaunch =
      "Note: Chrome was not reachable — Public Browser silently launched a fresh browser.\nPrevious tabs and references are gone. Call virtual_desk or tab_status to re-orient.";
    expect(extractResultValue(response('"ok"', dialog, download, relaunch))).toBe("ok");
  });

  // Preflight V5: the pipe-fallback warning from Task 6 (chrome-launcher,
  // consumeRelaunchNotice) arrives as its own block after the result.
  it("drops the pipe-fallback warning of a real profile", () => {
    const pipeWarning =
      'Public Browser: Chrome refused --remote-debugging-pipe for profile "Default" '
      + "and was restarted with a random debugging port. While this Chrome runs, any local program "
      + "can control the logged-in profile via 127.0.0.1:53211.";
    expect(extractResultValue(response('"ok"', pipeWarning))).toBe("ok");
  });

  it("keeps hint words that belong to the value", () => {
    expect(extractResultValue(response('"Tip: none"'))).toBe("Tip: none");
    expect(extractResultValue(response('{"note":"Note: 5 left"}'))).toEqual({ note: "Note: 5 left" });
  });

  // Plancheck P35: the Python parser (_value_text) must join the tool's own
  // blocks exactly like this — pinned here so both sides stay in step.
  it("joins all of the tool's own blocks with a newline", () => {
    expect(extractResultValue(response('"first"', '"second"'))).toBe('"first"\n"second"');
  });
});
