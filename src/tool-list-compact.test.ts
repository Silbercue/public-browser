import { describe, it, expect } from "vitest";
import { compactToolList, installToolListCompaction } from "./tool-list-compact.js";
import { withToolServer } from "./test-utils/list-tools.js";

const rawTool = {
  name: "click",
  description: "Click",
  inputSchema: {
    type: "object",
    properties: {
      ref: { type: "string", description: "ref" },
      opts: { type: "object", properties: { a: { type: "number" } }, additionalProperties: false },
      list: { type: "array", items: { type: "object", properties: {}, additionalProperties: false } },
    },
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  },
  execution: { taskSupport: "forbidden" },
};

describe("compactToolList", () => {
  it("entfernt $schema, execution und additionalProperties:false auf allen Ebenen", () => {
    const [t] = compactToolList([rawTool]) as any[];
    expect(t.execution).toBeUndefined();
    expect(t.inputSchema.$schema).toBeUndefined();
    expect(t.inputSchema.additionalProperties).toBeUndefined();
    expect(t.inputSchema.properties.opts.additionalProperties).toBeUndefined();
    expect(t.inputSchema.properties.list.items.additionalProperties).toBeUndefined();
    expect(JSON.stringify(t)).not.toMatch(/\$schema|taskSupport|additionalProperties/);
  });

  it("laesst Name, Description, Typen, enum, default und required unangetastet", () => {
    const tool = {
      ...rawTool,
      inputSchema: {
        ...rawTool.inputSchema,
        required: ["ref"],
        properties: {
          ...rawTool.inputSchema.properties,
          mode: { type: "string", enum: ["a", "b"], default: "a" },
        },
      },
    };
    const [t] = compactToolList([tool]) as any[];
    expect(t.name).toBe("click");
    expect(t.description).toBe("Click");
    expect(t.inputSchema.required).toEqual(["ref"]);
    expect(t.inputSchema.properties.mode).toEqual({ type: "string", enum: ["a", "b"], default: "a" });
    // Gegenprobe zu den Negativzusicherungen oben: die Beschreibung eines
    // Parameters bleibt auf der Leitung, nur SDK-Rauschen faellt weg.
    expect(t.inputSchema.properties.ref).toEqual({ type: "string", description: "ref" });
  });

  it("behaelt additionalProperties, wenn es nicht false ist, und veraendert die Eingabe nicht", () => {
    // Eigenes Literal statt Spread von `rawTool`: nur so belegt der Vergleich,
    // dass compactToolList das uebergebene Objekt selbst nicht anfasst.
    const tool = {
      name: "click",
      description: "Click",
      inputSchema: {
        type: "object",
        properties: { opts: { type: "object", properties: {}, additionalProperties: false } },
        additionalProperties: true,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      execution: { taskSupport: "forbidden" },
    };
    const before = JSON.stringify(tool);
    const [t] = compactToolList([tool]) as any[];
    expect(t.inputSchema.additionalProperties).toBe(true);
    expect(JSON.stringify(tool)).toBe(before);
  });

  it("fasst default-Werte nicht als Schema-Knoten auf", () => {
    const tool = {
      name: "x",
      inputSchema: {
        type: "object",
        properties: {
          cfg: { type: "object", default: { additionalProperties: false, $schema: "keep" } },
        },
      },
    };
    const [t] = compactToolList([tool]) as any[];
    expect(t.inputSchema.properties.cfg.default).toEqual({ additionalProperties: false, $schema: "keep" });
  });

  it("laesst Nicht-Objekte und Tools ohne inputSchema unveraendert", () => {
    const out = compactToolList([null, "x", { name: "a", description: "d" }]) as any[];
    expect(out[0]).toBeNull();
    expect(out[1]).toBe("x");
    expect(out[2]).toEqual({ name: "a", description: "d" });
  });
});

describe("installToolListCompaction", () => {
  /** Minimaler Fake-Transport, der alle gesendeten Nachrichten mitschreibt. */
  function fakeInner() {
    const sent: unknown[] = [];
    const calls: string[] = [];
    const inner: any = {
      sessionId: "s-1",
      send: async (m: unknown) => { sent.push(m); },
      start: async () => { calls.push("start"); },
      close: async () => { calls.push("close"); },
      setProtocolVersion: (v: string) => { calls.push(`version:${v}`); },
    };
    return { inner, sent, calls };
  }

  it("kompaktiert die Antwort auf einen zuvor gesehenen tools/list-Request", async () => {
    const { inner, sent } = fakeInner();
    const outer = installToolListCompaction(inner);
    inner.onmessage({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    await outer.send({ jsonrpc: "2.0", id: 7, result: { tools: [rawTool] } } as never);
    expect(JSON.stringify(sent[0])).not.toMatch(/taskSupport|\$schema|additionalProperties/);
    // Gegenprobe: der Tool-Name ueberlebt die Kompaktierung.
    expect(JSON.stringify(sent[0])).toContain('"click"');
  });

  it("laesst eine tools-Antwort ohne passenden tools/list-Request unveraendert", async () => {
    const { inner, sent } = fakeInner();
    const outer = installToolListCompaction(inner);
    await outer.send({ jsonrpc: "2.0", id: 8, result: { tools: [rawTool] } } as never);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 8, result: { tools: [rawTool] } });
  });

  it("merkt sich nur tools/list-Requests, nicht andere Methoden mit gleicher ID", async () => {
    const { inner, sent } = fakeInner();
    const outer = installToolListCompaction(inner);
    inner.onmessage({ jsonrpc: "2.0", id: 9, method: "tools/call" });
    await outer.send({ jsonrpc: "2.0", id: 9, result: { tools: [rawTool] } } as never);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [rawTool] } });
  });

  it("laesst andere Nachrichten unveraendert durch", async () => {
    const { inner, sent } = fakeInner();
    const outer = installToolListCompaction(inner);
    inner.onmessage({ jsonrpc: "2.0", id: 2, method: "tools/call" });
    await outer.send({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "x" }] } } as never);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "x" }] } });
  });

  it("kompaktiert eine ID nur einmal (pending wird verbraucht)", async () => {
    const { inner, sent } = fakeInner();
    const outer = installToolListCompaction(inner);
    inner.onmessage({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    await outer.send({ jsonrpc: "2.0", id: 7, result: { tools: [rawTool] } } as never);
    await outer.send({ jsonrpc: "2.0", id: 7, result: { tools: [rawTool] } } as never);
    expect(JSON.stringify(sent[0])).not.toMatch(/taskSupport/);
    expect(JSON.stringify(sent[1])).toMatch(/taskSupport/);
  });

  it("reicht start, close, setProtocolVersion, sessionId, onmessage, onclose und onerror durch", async () => {
    const { inner, calls } = fakeInner();
    const outer = installToolListCompaction(inner);
    const seen: unknown[] = [];
    outer.onmessage = (m) => { seen.push(m); };
    let closed = false;
    let err: Error | undefined;
    outer.onclose = () => { closed = true; };
    outer.onerror = (e) => { err = e; };

    await outer.start();
    await outer.close();
    outer.setProtocolVersion?.("2025-06-18");
    inner.onmessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    inner.onclose();
    inner.onerror(new Error("boom"));

    expect(calls).toEqual(["start", "close", "version:2025-06-18"]);
    expect(outer.sessionId).toBe("s-1");
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(closed).toBe(true);
    expect(err?.message).toBe("boom");
  });
});

/**
 * A2.3: Beleg dafuer, dass `additionalProperties: false` auf der Leitung nichts
 * bewacht. Die Server-Validierung laeuft am originalen Zod-Schema, und
 * Zod-Objekte strippen unbekannte Keys — sie lehnen sie nicht ab. Faellt dieser
 * Test, muss `additionalProperties: false` auf der Leitung bleiben.
 */
describe("unbekannte Argument-Keys (A2.3)", () => {
  it("loest keinen -32602-Fehler aus und liefert dieselbe Antwortform wie ohne Extra-Key", async () => {
    await withToolServer(async ({ call }) => {
      const withoutExtra = (await call("virtual_desk", {})) as Record<string, unknown>;
      const withExtra = (await call("virtual_desk", { foo: 1 })) as Record<string, unknown>;
      expect(JSON.stringify(withExtra)).not.toMatch(/-32602|nvalid arguments/);
      // Positive Gegenprobe: ein bekannter Key mit falschem TYP wird sehr wohl
      // abgelehnt — die Zusicherung oben ist also nicht vakuum-wahr.
      const badType = (await call("navigate", { url: 123 })) as Record<string, unknown>;
      expect(JSON.stringify(badType)).toMatch(/-32602/);
      expect(Object.keys(withExtra).sort()).toEqual(Object.keys(withoutExtra).sort());
      expect(withExtra.isError).toEqual(withoutExtra.isError);
      // Gegenprobe: die Antwort ist ueberhaupt eine Tool-Antwort mit Inhalt.
      expect(Array.isArray(withExtra.content)).toBe(true);
    });
  });
});
