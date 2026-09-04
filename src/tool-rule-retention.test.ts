import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { listToolsOverWire, schemaProperties } from "./test-utils/list-tools.js";

/**
 * Regression gegen Codex-Finding #1 der Abnahme vom 2026-09-04: beim Kuerzen
 * der Tool-Definitionen auf < 5000 Token sind drei Regel-Aussagen verloren
 * gegangen bzw. verdreht worden. Dieser Test friert genau diese drei Aussagen
 * auf der Leitung ein — nicht den Wortlaut der ganzen Description, sondern
 * jeweils die Regel, die das Modell fuer einen korrekten Call braucht.
 */

async function wireTool(name: string): Promise<Tool> {
  const tools = await listToolsOverWire();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not on the wire`);
  return tool;
}

describe("Regel-Erhalt in den Tool-Definitionen", () => {
  it("wait_for nennt fuer jeden Bedingungs-Parameter die Pflicht-condition", async () => {
    const props = schemaProperties(await wireTool("wait_for"));
    expect(props.selector.description).toContain("required for condition 'element'");
    expect(props.text.description).toContain("required for condition 'text'");
    expect(props.url.description).toContain("required for condition 'url'");
    expect(props.expression.description).toContain("required for condition 'js'");
  });

  it("wait_for behaelt neben der Pflicht-Aussage auch das Format des Parameters", async () => {
    const props = schemaProperties(await wireTool("wait_for"));
    expect(props.selector.description).toContain("CSS selector or ref");
    expect(props.text.description).toContain("document.body.innerText");
    expect(props.url.description).toContain("page URL");
  });

  it("drag nennt beide Quell- und Ziel-Formate (ref/selector ODER x+y)", async () => {
    const description = (await wireTool("drag")).description ?? "";
    expect(description).toContain("from_ref/from_selector or from_x+from_y");
    expect(description).toContain("to_ref/to_selector or to_x+to_y");
  });

  it("handle_dialog.text beschreibt eingegebenen, nicht zurueckgegebenen Text", async () => {
    const props = schemaProperties(await wireTool("handle_dialog"));
    expect(props.text.description).toContain("entered into prompt dialogs");
    // Gegenprobe zur Negativ-Zusicherung darunter: die Description existiert
    // ueberhaupt und ist nicht leer.
    expect(props.text.description?.length).toBeGreaterThan(10);
    expect(props.text.description).not.toContain("returned");
  });
});
