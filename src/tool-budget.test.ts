import { describe, it, expect } from "vitest";
import { listToolsOverWire, withToolServer } from "./test-utils/list-tools.js";

/**
 * NFR4: Die Tool-Definitionen, die ein MCP-Client beim Verbinden bekommt,
 * duerfen zusammen unter 5000 Token bleiben. Gemessen wird exakt wie in
 * `scripts/token-count.mjs`: Laenge des JSON-Dumps von `tools/list` / 4.
 */
const BUDGET_TOKENS = 5000;

function wireTokens(tools: unknown): number {
  return Math.ceil(JSON.stringify(tools).length / 4);
}

describe("NFR4 tool-definition budget", () => {
  it("liefert 25 Tools ohne $schema/taskSupport/additionalProperties:false", async () => {
    const tools = await listToolsOverWire();
    expect(tools).toHaveLength(25);
    expect(JSON.stringify(tools)).not.toMatch(/\$schema|taskSupport|"additionalProperties":false/);
  });

  it("bleibt unter 5000 Token (chars/4) auf der Leitung", async () => {
    const tools = await listToolsOverWire();
    const tokens = wireTokens(tools);
    expect(tokens, `tools/list kostet ${tokens} Token`).toBeLessThan(BUDGET_TOKENS);
  });

  it("jede Description ist englisch und ohne Selector-Beispiel", async () => {
    const tools = await listToolsOverWire();
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/alternative zu|Anzahl |fuer |zwischen /);
    expect(text).not.toMatch(/#submit-btn|#email|\.sidebar-list|input\[name=email\]|'e5'|'e8'/);
  });
});

describe("run_plan wire schema", () => {
  it("exponiert vars und errorStrategy und haelt parallel[].steps auf dem $ref", async () => {
    const tools = await listToolsOverWire();
    const rp = tools.find((t) => t.name === "run_plan")!;
    const props = (rp.inputSchema as { properties: Record<string, any> }).properties;
    expect(props.vars).toBeDefined();
    expect(props.errorStrategy.enum).toEqual(["abort", "continue", "capture_image"]);
    expect(props.parallel.items.properties.steps.items).toEqual({
      $ref: "#/properties/steps/items",
    });
  });

  it("weist einen Top-Level-Step ohne 'tool' als Validierungsfehler zurueck", async () => {
    await withToolServer(async ({ call }) => {
      const result = (await call("run_plan", { steps: [{ params: {} }] })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("-32602");
      expect(result.content[0].text).toMatch(/"steps",\s*0,\s*"tool"/);
    });
  });

  it("validiert Steps auch innerhalb einer parallel-Gruppe ($ref traegt das Step-Schema)", async () => {
    await withToolServer(async ({ call }) => {
      const result = (await call("run_plan", {
        parallel: [{ tab: "t1", steps: [{ params: {} }] }],
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/"parallel",\s*0,\s*"steps",\s*0,\s*"tool"/);
    });
  });

  it("laesst einen gueltigen Step durch die Validierung zum Handler", async () => {
    await withToolServer(async ({ call }) => {
      const result = (await call("run_plan", { steps: [{ tool: "tab_status" }] })) as {
        content: { text: string }[];
      };
      expect(result.content[0].text).not.toContain("Input validation error");
      expect(result.content[0].text).toContain("tab_status");
    });
  });
});
