import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "./registry.js";
import { registerProHooks } from "./hooks/pro-hooks.js";
import { bindScriptTab, forgetScriptTab } from "./cache/a11y-tree.js";
import { hintLedger } from "./telemetry/hint-ledger.js";
import { toolSequence } from "./telemetry/tool-sequence.js";

type McpResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type McpCallback = (params: Record<string, unknown>) => Promise<McpResult>;

/** Registry whose CDP mock answers with `send`; `mcp(name)` returns the registered MCP callback. */
function registryWith(send: (method: string) => Promise<unknown>) {
  const toolFn = vi.fn();
  const cdpClient = { send: vi.fn().mockImplementation(send) } as never;
  const registry = new ToolRegistry({ tool: toolFn } as never, cdpClient, "session-1", {} as never);
  registry.registerAll();
  const mcp = (name: string): McpCallback => {
    const call = toolFn.mock.calls.find((c: unknown[]) => c[0] === name)!;
    return call[call.length - 1] as McpCallback;
  };
  return { registry, mcp };
}

const allText = (result: McpResult) =>
  result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

const JS_CLICK_TIP = "Tip: Dispatching click via JS?";

beforeEach(() => {
  registerProHooks({});
  toolSequence.reset();
  hintLedger.reset();
});

// Stufe 2 H3: Der Hinweis "STOP: You just used capture_image …" gehoert zu den
// Ratschlaegen, die hoechstens einmal pro MCP-Session erscheinen.
describe("capture_image STOP hint once per session (Stufe 2 H3)", () => {
  const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  async function screenshotAnswer(method: string): Promise<unknown> {
    if (method === "Page.captureScreenshot") return { data: PNG_1X1 };
    if (method === "Runtime.evaluate") return { result: { type: "object", value: { width: 800, height: 600 } } };
    if (method === "Page.getLayoutMetrics") {
      return {
        cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 },
        cssContentSize: { width: 800, height: 600, x: 0, y: 0 },
        cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, zoom: 1, scale: 1 },
      };
    }
    return {};
  }

  const stopHints = (result: McpResult) =>
    result.content.filter((b) => b.type === "text" && b.text?.startsWith("STOP: You just used capture_image"));

  it("shows the hint with the first screenshot only", async () => {
    const captureImage = registryWith(screenshotAnswer).mcp("capture_image");

    const first = await captureImage({});
    const second = await captureImage({});

    expect(stopHints(first)).toHaveLength(1);
    expect(stopHints(second)).toHaveLength(0);
    expect(second.content.some((b) => b.type === "image")).toBe(true);
  });
});

// Plancheck P15: Ein Hinweis gilt erst als gezeigt, wenn er in einer MCP-Antwort
// auf oberster Ebene an das Modell ging. run_plan zeigt von OK-Schritten nur die
// erste Zeile, Python schneidet Hinweise ab — beides verbraucht keinen Tipp.
describe("hints are used up only by a top-level MCP response (Stufe 2 H3, Plancheck P15)", () => {
  const evaluateAnswer = async (method: string): Promise<unknown> =>
    method === "Runtime.evaluate" ? { result: { type: "undefined" } } : {};

  it("a run_plan step with btn.click() does not use up the tip — a direct evaluate afterwards shows it", async () => {
    const { mcp } = registryWith(evaluateAnswer);

    const plan = await mcp("run_plan")({ steps: [{ tool: "evaluate", params: { expression: "btn.click()" } }] });
    expect(plan.isError).toBeFalsy();
    expect(allText(plan)).not.toContain(JS_CLICK_TIP);

    const direct = await mcp("evaluate")({ expression: "btn.click()" });
    expect(allText(direct)).toContain(JS_CLICK_TIP);

    const again = await mcp("evaluate")({ expression: "btn.click()" });
    expect(allText(again)).not.toContain(JS_CLICK_TIP);
  });

  it("a Script-API call (session bound to its tab) does not use up the tip either", async () => {
    const { registry, mcp } = registryWith(evaluateAnswer);
    bindScriptTab("session-B", "TAB-B");
    try {
      await registry.executeTool("evaluate", { expression: "btn.click()" }, "session-B");

      const direct = await mcp("evaluate")({ expression: "btn.click()" });
      expect(allText(direct)).toContain(JS_CLICK_TIP);
    } finally {
      forgetScriptTab("TAB-B");
    }
  });
});
