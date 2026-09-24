import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "./registry.js";
import { bindScriptTab, forgetScriptTab } from "./cache/a11y-tree.js";
import { extractResultValue } from "./plan/plan-variables.js";
import { toolSequence } from "./telemetry/tool-sequence.js";

// Stufe 2 H5: String-Ergebnisse von evaluate kommen im MCP-Werkzeug roh zurück;
// executeTool (run_plan-Schritte, Script API, Node Library) behält JSON.
describe("ToolRegistry — evaluate string results (Stufe 2 H5)", () => {
  beforeEach(() => {
    toolSequence.reset();
  });

  function registryReturning(value: string) {
    const toolFn = vi.fn();
    const cdp = { send: vi.fn().mockResolvedValue({ result: { type: "string", value } }) } as never;
    const registry = new ToolRegistry({ tool: toolFn } as never, cdp, "session-1", {} as never);
    registry.registerAll();
    const call = toolFn.mock.calls.find((c: unknown[]) => c[0] === "evaluate")!;
    const mcpEvaluate = call[call.length - 1] as (p: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    return { registry, mcpEvaluate };
  }

  it("the MCP tool returns a string result raw", async () => {
    const { mcpEvaluate } = registryReturning("Device Max | $419.99");
    const result = await mcpEvaluate({ expression: "document.title" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "Device Max | $419.99" });
  });

  it("executeTool keeps the JSON form for programmatic callers", async () => {
    const { registry } = registryReturning("Device Max | $419.99");
    const result = await registry.executeTool("evaluate", { expression: "document.title" });
    expect(result.content[0]).toMatchObject({ type: "text", text: '"Device Max | $419.99"' });
    // Plancheck P35: the saveAs parser from Task 17 reads exactly this form.
    expect(extractResultValue(result)).toBe("Device Max | $419.99");
  });

  // Plancheck P35: the path Python and saveAs read keeps JSON after this task —
  // a number string stays a string there. P16: the MCP tool keeps the quotes, too.
  it("P35: a Script-API call gets JSON, so a number string stays a string for saveAs and Python", async () => {
    const { registry, mcpEvaluate } = registryReturning("42");
    bindScriptTab("session-B", "TAB-B");
    try {
      const script = await registry.executeTool("evaluate", { expression: "window.count" }, "session-B");
      expect(script.content[0]).toMatchObject({ type: "text", text: '"42"' });
      expect(extractResultValue(script)).toBe("42");

      const mcp = await mcpEvaluate({ expression: "window.count" });
      expect(mcp.content[0]).toMatchObject({ type: "text", text: '"42"' });
    } finally {
      forgetScriptTab("TAB-B");
    }
  });
});
