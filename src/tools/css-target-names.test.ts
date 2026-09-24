import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { typeHandler } from "./type.js";
import type { TypeParams } from "./type.js";
import { fillFormHandler } from "./fill-form.js";
import { fileUploadHandler } from "./file-upload.js";
import { a11yTree } from "../cache/a11y-tree.js";
import type { AXNode } from "../cache/a11y-tree.js";
import { selectorCache } from "../cache/selector-cache.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// S3 (Plancheck P32): the CSS path now returns role and name from the a11y
// tree, so the success texts of type, fill_form and file_upload name the
// element the way the ref path always did. Real element-utils, real a11yTree.
const formTree: AXNode[] = [
  { nodeId: "1", ignored: false, role: { type: "role", value: "WebArea" }, backendDOMNodeId: 100, childIds: ["2", "3"] },
  { nodeId: "2", ignored: false, parentId: "1", role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "Email" }, backendDOMNodeId: 101 },
  { nodeId: "3", ignored: false, parentId: "1", role: { type: "role", value: "button" }, name: { type: "computedString", value: "Resume" }, backendDOMNodeId: 102 },
];

/** `#email` → backendNodeId 101 (textbox "Email"), `#resume` → 102, `#unknown` → 999 (not in the tree). */
function formCdp(): CdpClient {
  const nodeIdOf: Record<string, number> = { "#email": 11, "#resume": 12, "#unknown": 19 };
  const backendOf: Record<number, number> = { 11: 101, 12: 102, 19: 999 };
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case "Runtime.evaluate":
        return { result: { value: "https://example.com/form" } };
      case "Accessibility.getFullAXTree":
        return { nodes: formTree };
      case "DOM.getDocument":
        return { root: { nodeId: 1 } };
      case "DOM.querySelector": // before S3 the CSS path asked for the first match only
        return { nodeId: nodeIdOf[String(params?.selector)] };
      case "DOM.querySelectorAll":
        return { nodeIds: [nodeIdOf[String(params?.selector)]] };
      case "DOM.describeNode":
        return { node: { backendNodeId: backendOf[Number(params?.nodeId)] } };
      case "DOM.resolveNode":
        return { object: { objectId: `obj-${String(params?.backendNodeId)}` } };
      case "Runtime.callFunctionOn": {
        const fn = String(params?.functionDeclaration ?? "");
        if (fn.includes("this.tagName + '|' + this.type")) return { result: { value: "INPUT|file" } };
        if (fn.includes("JSON.stringify({ tag: tag")) {
          return { result: { value: JSON.stringify({ tag: "INPUT", type: "text", checked: false }) } };
        }
        return { result: { value: null } };
      }
      default:
        return {};
    }
  });
  return { send, on: vi.fn(), once: vi.fn(), off: vi.fn() } as unknown as CdpClient;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text;
}

describe("success texts name a CSS-resolved element (S3, P32)", () => {
  let dir: string;

  beforeEach(async () => {
    a11yTree.resetAll();
    selectorCache.invalidate();
    dir = mkdtempSync(join(tmpdir(), "pb-css-names-"));
    await a11yTree.getTree(formCdp(), "s1");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    a11yTree.resetAll();
  });

  it("S3: type names the field the a11y tree knows", async () => {
    const result = await typeHandler({ selector: "#email", text: "max@test.de" } as TypeParams, formCdp(), "s1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(`Typed "max@test.de" into textbox 'Email'`);
  });

  it("S3: type keeps the selector for an element the a11y tree does not know", async () => {
    const result = await typeHandler({ selector: "#unknown", text: "x" } as TypeParams, formCdp(), "s1");

    expect(text(result)).toContain(`Typed "x" into #unknown`);
  });

  it("S3: fill_form names the field the a11y tree knows", async () => {
    const result = await fillFormHandler({ fields: [{ selector: "#email", value: "max@test.de" }] }, formCdp(), "s1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("textbox 'Email'");
  });

  it("S3: file_upload names the input the a11y tree knows", async () => {
    const file = join(dir, "cv.pdf");
    writeFileSync(file, "x");

    const result = await fileUploadHandler({ selector: "#resume", path: file }, formCdp(), "s1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Uploaded 1 file to button 'Resume'");
  });
});
