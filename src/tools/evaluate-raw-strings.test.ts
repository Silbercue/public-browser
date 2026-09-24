import { describe, it, expect, beforeEach } from "vitest";
import { evaluateHandler } from "./evaluate.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { registerProHooks } from "../hooks/pro-hooks.js";
import { toolSequence } from "../telemetry/tool-sequence.js";

function mockCdpClient(
  sendFn: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): CdpClient {
  return { send: sendFn } as unknown as CdpClient;
}

/** Text of the MCP-facing evaluate call (rawStrings) for a CDP result of `type`/`value`. */
async function mcpText(value: unknown, type: string): Promise<string> {
  const cdp = mockCdpClient(async () => ({ result: { type, value } }));
  const response = await evaluateHandler({ expression: "window.x", await_promise: true }, cdp, undefined, { rawStrings: true });
  return response.content[0].text as string;
}

// Stufe 2 H5: String-Ergebnisse roh statt JSON-escaped — nur für den MCP-Aufruf
// (rawStrings). run_plan, Script API (Python) und Node Library parsen den Text
// und behalten das JSON-Format. Die Ausdrücke lösen bewusst keinen Tipp aus,
// damit dieser Block unabhängig von H3 grün bleibt.
describe("evaluateHandler rawStrings (Stufe 2 H5)", () => {
  beforeEach(() => {
    registerProHooks({});
    toolSequence.reset();
  });

  it("returns a string result without quotes and escapes", async () => {
    expect(await mcpText("T2.1\nWait for Async Content\n\nPENDING", "string")).toBe("T2.1\nWait for Async Content\n\nPENDING");
  });

  it("returns plain text raw (run3: page title with a price)", async () => {
    expect(await mcpText("Device Max | $419.99", "string")).toBe("Device Max | $419.99");
  });

  // Plancheck P16: a string that could pass for another type, or that would be
  // invisible raw, keeps its JSON quotes — the model must still see the type.
  it.each([
    ["a number string", "42"],
    ["a negative decimal string", "-1.5"],
    ["an exponent string", "1e3"],
    ["a hex number string", "0x1F"],
    ["a number string with spaces around it", " 42 "],
    ["\"Infinity\"", "Infinity"],
    ["\"NaN\"", "NaN"],
    ["\"true\"", "true"],
    ["\"false\"", "false"],
    ["\"null\"", "null"],
    ["\"undefined\"", "undefined"],
    ["the empty string", ""],
    ["spaces only", "   "],
    ["line breaks and tabs only", "\n\t\n"],
    ["JSON text built by the page (run3 #89, export)", '{\n  "timestamp": "2026-09-23T10:48:36.429Z",\n  "summary": { "passed": 30 }\n}'],
    ["a JSON array", "[1,2]"],
    ["a JSON string literal", '"quoted"'],
  ])("P16: keeps the JSON form for %s", async (_case, value) => {
    expect(await mcpText(value, "string")).toBe(JSON.stringify(value));
  });

  it("keeps JSON for non-strings", async () => {
    const values: Array<[unknown, string, string]> = [
      [{ a: 1 }, "object", '{"a":1}'],
      [42, "number", "42"],
      [false, "boolean", "false"],
    ];
    for (const [value, type, expected] of values) {
      expect(await mcpText(value, type)).toBe(expected);
    }
  });

  it("without the option a string stays JSON (run_plan, Script API, Node library)", async () => {
    const cdp = mockCdpClient(async () => ({ result: { type: "string", value: "Device Max | $419.99" } }));
    const response = await evaluateHandler({ expression: "document.title", await_promise: true }, cdp);
    expect(response.content[0].text).toBe('"Device Max | $419.99"');
  });
});
