import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listToolsOverWire } from "./test-utils/list-tools.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "tool-schema-manifest.json");

/**
 * Kanonische Form eines Tool-Schemas: alles, was den Vertrag mit dem Modell
 * ausmacht (Parameter-Namen, `type`, `enum`, `default`, `required`, `items`,
 * `anyOf`, `$ref`, `minimum`/`maximum`) bleibt; reine Prosa (`description`) und
 * SDK-Rauschen (`$schema`, `additionalProperties`) fallen weg, damit reine
 * Beschreibungs-Kuerzungen die Fixture nicht anfassen. Objekt-Keys werden
 * sortiert, Array-Reihenfolgen bleiben (bei `required`/`enum` sind sie Teil des
 * Vertrags).
 */
function canonical(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canonical);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node as Record<string, unknown>).sort()) {
    if (key === "description" || key === "$schema" || key === "additionalProperties") continue;
    out[key] = canonical((node as Record<string, unknown>)[key]);
  }
  return out;
}

describe("Tool-Schema-Manifest", () => {
  it("haelt Namen und Parameter-Vertraege aller Tools unveraendert", async () => {
    const tools = await listToolsOverWire();
    const manifest = tools
      .map((t) => ({ name: t.name, inputSchema: canonical(t.inputSchema) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(manifest).toHaveLength(25);

    if (process.env.UPDATE_MANIFEST === "1") {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, JSON.stringify(manifest, null, 2) + "\n");
      return;
    }

    const expected = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(manifest).toEqual(expected);
  });
});
