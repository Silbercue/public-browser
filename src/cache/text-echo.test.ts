import { describe, it, expect } from "vitest";
import { echoTextChildren, ownTextChildren, textsFormName } from "./text-echo.js";
import type { EchoNode } from "./text-echo.js";

/** Small AX tree: nodeId → node, children in document order. */
function tree(...nodes: EchoNode[]): Map<string, EchoNode> {
  return new Map(nodes.map((n) => [n.nodeId, n]));
}
const el = (nodeId: string, role: string, name: string | undefined, childIds: string[] = [], ignored = false): EchoNode => ({
  nodeId,
  ignored,
  role: { value: role },
  ...(name !== undefined ? { name: { value: name } } : {}),
  childIds,
});
const txt = (nodeId: string, text: string): EchoNode => el(nodeId, "StaticText", text);
const ids = (nodes: EchoNode[]): string[] => nodes.map((n) => n.nodeId);

describe("textsFormName (Stufe 2, H1/H2)", () => {
  it("joins the texts in order and compares without any whitespace", () => {
    expect(textsFormName(["T1.1", "Click the Button"], "T1.1 Click the Button")).toBe(true);
    expect(textsFormName(["Items:", "10"], "Items: 10")).toBe(true);
    expect(textsFormName(["Items: ", "10"], "Items:10")).toBe(true);
    expect(textsFormName(["Level 3 —\nAdvanced"], "Level 3 — Advanced")).toBe(true);
    expect(textsFormName(["1. Press ", "Ctrl", " + ", "K"], "1. Press Ctrl + K")).toBe(true);
  });

  it("is false for a mere part of the name — there is no substring rule", () => {
    expect(textsFormName(["0"], "Items: 10")).toBe(false);
    expect(textsFormName(["T1.1"], "T1.1 Click the Button")).toBe(false);
    expect(textsFormName(["Click the Button", "T1.1"], "T1.1 Click the Button")).toBe(false);
  });

  it("never matches without texts or without a name", () => {
    expect(textsFormName([], "Items: 10")).toBe(false);
    expect(textsFormName(["PENDING"], undefined)).toBe(false);
    expect(textsFormName(["PENDING"], "")).toBe(false);
    expect(textsFormName([" "], " ")).toBe(false);
  });
});

describe("ownTextChildren (Stufe 2, H1/H2)", () => {
  it("collects StaticText in document order, looks through ignored wrappers and stops at other nodes", () => {
    const map = tree(
      el("1", "heading", "A B C", ["2", "3", "5"]),
      txt("2", "A"),
      el("3", "generic", undefined, ["4"], true), // ignored wrapper
      txt("4", "B"),
      el("5", "link", "C", ["6"]), // parent of its own text
      txt("6", "C"),
    );
    expect(ids(ownTextChildren(map.get("1")!, map))).toEqual(["2", "4"]);
    expect(ids(ownTextChildren(map.get("5")!, map))).toEqual(["6"]);
  });
});

describe("echoTextChildren (Stufe 2, Review Focus 3)", () => {
  it("keeps the child '0' under a container whose aria-label is 'Items: 10'", () => {
    const map = tree(el("1", "group", "Items: 10", ["2"]), txt("2", "0"));
    expect(echoTextChildren(map.get("1")!, "Items: 10", map)).toEqual([]);
  });

  it("drops both children of heading 'T1.1 Click the Button'", () => {
    const map = tree(el("1", "heading", "T1.1 Click the Button", ["2", "3"]), txt("2", "T1.1"), txt("3", "Click the Button"));
    expect(ids(echoTextChildren(map.get("1")!, "T1.1 Click the Button", map))).toEqual(["2", "3"]);
  });

  it("keeps the children of a heading whose aria-label says something else", () => {
    const map = tree(el("1", "heading", "Settings", ["2", "3"]), txt("2", "⚙"), txt("3", "Open preferences"));
    expect(echoTextChildren(map.get("1")!, "Settings", map)).toEqual([]);
  });

  it("drops a card's two texts when together they form the card's name", () => {
    const map = tree(el("1", "link", "Item 3 In stock", ["2", "3"]), txt("2", "Item 3"), txt("3", "In stock"));
    expect(ids(echoTextChildren(map.get("1")!, "Item 3 In stock", map))).toEqual(["2", "3"]);
  });

  it("keeps every child when only some of them form the name", () => {
    const map = tree(el("1", "group", "Items: 10", ["2", "3"]), txt("2", "Items: 10"), txt("3", "(max)"));
    expect(echoTextChildren(map.get("1")!, "Items: 10", map)).toEqual([]);
  });

  it("never drops anything under a parent without a name", () => {
    const map = tree(el("1", "paragraph", undefined, ["2"]), txt("2", "PENDING"));
    expect(echoTextChildren(map.get("1")!, undefined, map)).toEqual([]);
    expect(echoTextChildren(map.get("1")!, "", map)).toEqual([]);
  });
});
