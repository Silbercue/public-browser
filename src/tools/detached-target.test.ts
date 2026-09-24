import { describe, it, expect, vi, beforeEach } from "vitest";
import { typeHandler } from "./type.js";
import type { TypeParams } from "./type.js";
import { fillFormHandler } from "./fill-form.js";
import { pressKeyHandler } from "./press-key.js";
import { clickHandler } from "./click.js";
import { a11yTree } from "../cache/a11y-tree.js";
import type { AXNode } from "../cache/a11y-tree.js";
import { selectorCache } from "../cache/selector-cache.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// B6: e2 is a textbox the page re-rendered away. DOM.resolveNode still finds
// the old node (it is alive), but it no longer hangs in the document —
// focusing it does nothing and typing would land in whatever had focus.
const formTree: AXNode[] = [
  { nodeId: "1", ignored: false, role: { type: "role", value: "WebArea" }, backendDOMNodeId: 100, childIds: ["2"] },
  {
    nodeId: "2",
    ignored: false,
    parentId: "1",
    role: { type: "role", value: "textbox" },
    name: { type: "computedString", value: "Email" },
    backendDOMNodeId: 101,
  },
];

function detachedTargetCdp(): { cdpClient: CdpClient; sendFn: ReturnType<typeof vi.fn> } {
  const sendFn = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "Runtime.evaluate") return { result: { value: "https://example.com/form" } };
    if (method === "Accessibility.getFullAXTree") return { nodes: formTree };
    if (method === "DOM.resolveNode") return { object: { objectId: "obj-email" } };
    if (method === "Runtime.callFunctionOn") {
      const connectedCheck = String(params?.functionDeclaration ?? "").includes("isConnected");
      return { result: { type: "boolean", value: !connectedCheck } };
    }
    return {};
  });
  const cdpClient = { send: sendFn, on: vi.fn(), once: vi.fn(), off: vi.fn() } as unknown as CdpClient;
  return { cdpClient, sendFn };
}

function inputEvents(sendFn: ReturnType<typeof vi.fn>): unknown[] {
  return sendFn.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("Input."));
}

describe("detached targets are reported, never acted on (B6)", () => {
  beforeEach(() => {
    a11yTree.resetAll();
    selectorCache.invalidate();
  });

  async function seeded(): Promise<{ cdpClient: CdpClient; sendFn: ReturnType<typeof vi.fn> }> {
    const cdp = detachedTargetCdp();
    await a11yTree.refreshPrecomputed(cdp.cdpClient, "s1");
    expect(a11yTree.resolveRefFull("e2")).toEqual({ backendNodeId: 101, sessionId: "s1" });
    return cdp;
  }

  it("B6: type refuses a detached field and types nothing", async () => {
    const { cdpClient, sendFn } = await seeded();

    const result = await typeHandler({ ref: "e2", text: "max@test.de" } as TypeParams, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Element e2 is a stale ref");
    expect((result.content[0] as { text: string }).text).toContain("view_page");
    expect(inputEvents(sendFn)).toHaveLength(0);
  });

  it("B6: fill_form refuses a detached field and fills nothing", async () => {
    const { cdpClient, sendFn } = await seeded();

    const result = await fillFormHandler({ fields: [{ ref: "e2", value: "max@test.de" }] }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Element e2 is a stale ref");
    expect(inputEvents(sendFn)).toHaveLength(0);
  });

  it("B6: press_key refuses to focus a detached element and sends no key", async () => {
    const { cdpClient, sendFn } = await seeded();

    const result = await pressKeyHandler({ key: "Enter", ref: "e2" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Element e2 is a stale ref");
    expect(inputEvents(sendFn)).toHaveLength(0);
  });

  it("B6: click goes through the same check", async () => {
    const { cdpClient, sendFn } = await seeded();

    const result = await clickHandler({ ref: "e2" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Element e2 is a stale ref");
    expect(inputEvents(sendFn)).toHaveLength(0);
  });
});
