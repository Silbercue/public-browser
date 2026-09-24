/**
 * Tests for `drag` tool (Story 18.6 FR-028, Aufschliessen S6).
 *
 * Mocked-CDP tests — no real Chrome. Verifies:
 *  1. Mouse path: mousePressed → N×mouseMoved → mouseReleased with the resolved coordinates
 *  2. S6: a ref/selector source is scrolled into view before its coordinates are read;
 *     a coordinate target moves with the source (mixed form)
 *  3. S6: HTML5 drag-and-drop — after Input.dragIntercepted the rest runs as
 *     Input.dispatchDragEvent (dragEnter → dragOver … → drop), intercept on the main session
 *  4. S6: no silent success — the page probe (isolated world) decides between "Dragged …" and an error;
 *     only DOM changes around source and target count, scrolling and text selection do not
 *  5. Validation, steps guard, ref errors, probe teardown
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dragHandler, dragSchema } from "./drag.js";
import type { DragProbeResult } from "./drag.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { a11yTree } from "../cache/a11y-tree.js";
import * as elementUtils from "./element-utils.js";
import { RefNotFoundError } from "./element-utils.js";

type EventCallback = (params: unknown, sessionId?: string) => void;

interface DragMockOptions {
  /** What the page probe reports on read(). */
  probe?: Partial<DragProbeResult>;
  /** Viewport the probe reports on install. */
  view?: { w: number; h: number; canvas?: boolean };
  /** Fire Input.dragIntercepted on the main session after this mouseMoved (1-based). */
  interceptAtMove?: number;
  /** Fire Input.dragIntercepted only when the handler asks the probe for a dragstart. */
  interceptOnPeek?: boolean;
  /** Answer of the dragstart peek. */
  sawDragstart?: boolean;
  /** Content quads per backendNodeId. */
  quads?: Record<number, number[]>;
  /** Successive content quads per backendNodeId (one per call, the last one repeats). */
  quadsSeq?: Record<number, number[][]>;
  /** Throw on this mouseMoved (1-based). */
  failOnMove?: number;
  /** Page.createIsolatedWorld fails — no probe at all. */
  noIsolatedWorld?: boolean;
  /** The frame gets a new document during the drag: new loaderId, the probe's context is gone. */
  navigates?: boolean;
}

const PROBE_CONTEXT_ID = 7;

const DEFAULT_PROBE: DragProbeResult = {
  mutationsInside: 1,
  mutationsOutside: 0,
  inputs: 0,
  selected: 0,
  dragstart: false,
  dragstartPrevented: false,
  drop: false,
  dragend: "",
};

const DRAG_DATA = { items: [], dragOperationsMask: 16 };

function mockCdpForDrag(opts: DragMockOptions = {}, mainSession = "sess-1") {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();
  const fire = (method: string, params: unknown, sessionId: string) => {
    for (const entry of listeners.get(method) ?? []) {
      if (entry.sessionId === undefined || entry.sessionId === sessionId) entry.callback(params, sessionId);
    }
  };
  let moves = 0;
  let frameTreeCalls = 0;
  const quadsSeq = Object.fromEntries(
    Object.entries(opts.quadsSeq ?? {}).map(([id, seq]) => [id, [...seq]]),
  ) as Record<string, number[][]>;

  const sendMock = vi.fn(async (method: string, params?: Record<string, unknown>, _sessionId?: string) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
    if (method === "DOM.getContentQuads") {
      const id = params?.backendNodeId as number;
      const seq = quadsSeq[String(id)];
      if (seq && seq.length > 0) return { quads: [seq.length > 1 ? seq.shift()! : seq[0]] };
      return { quads: [opts.quads?.[id] ?? [95, 95, 105, 95, 105, 105, 95, 105]] };
    }
    if (method === "Page.getFrameTree") {
      frameTreeCalls++;
      const loaderId = opts.navigates && frameTreeCalls > 1 ? "loader-2" : "loader-1";
      return { frameTree: { frame: { id: "frame-1", loaderId } } };
    }
    if (method === "Page.createIsolatedWorld") {
      if (opts.noIsolatedWorld) throw new Error("Page.createIsolatedWorld failed");
      return { executionContextId: PROBE_CONTEXT_ID };
    }
    if (method === "Runtime.evaluate") {
      const expr = String(params?.expression ?? "");
      if (expr.includes("new MutationObserver")) {
        return { result: { value: { w: opts.view?.w ?? 1200, h: opts.view?.h ?? 800, canvas: opts.view?.canvas ?? false } } };
      }
      if (opts.navigates) throw new Error("Cannot find context with specified id");
      if (expr.includes("requestAnimationFrame")) return { result: { value: true } };
      if (expr.includes("state.dragstart")) {
        if (opts.interceptOnPeek) fire("Input.dragIntercepted", { data: DRAG_DATA }, mainSession);
        return { result: { value: opts.sawDragstart ?? false } };
      }
      if (expr.includes("p.read()")) {
        return { result: { value: { ...DEFAULT_PROBE, ...opts.probe } } };
      }
      return { result: { value: true } };
    }
    if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") {
      moves++;
      if (opts.failOnMove === moves) throw new Error("Input.dispatchMouseEvent failed");
      if (opts.interceptAtMove === moves) fire("Input.dragIntercepted", { data: DRAG_DATA }, mainSession);
    }
    return {};
  });

  const cdp = {
    send: sendMock,
    on: vi.fn((method: string, callback: EventCallback, sessionId?: string) => {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add({ callback, sessionId });
    }),
    once: vi.fn(),
    off: vi.fn((method: string, callback: EventCallback) => {
      for (const entry of listeners.get(method) ?? []) {
        if (entry.callback === callback) listeners.get(method)!.delete(entry);
      }
    }),
  } as unknown as CdpClient;

  return { cdp, sendMock, listeners };
}

function calls(sendMock: ReturnType<typeof vi.fn>, method: string) {
  return sendMock.mock.calls.filter((c) => c[0] === method);
}

function expressions(sendMock: ReturnType<typeof vi.fn>): string[] {
  return calls(sendMock, "Runtime.evaluate").map((c) => String((c[1] as { expression?: string }).expression));
}

function installExpression(sendMock: ReturnType<typeof vi.fn>): string {
  const install = expressions(sendMock).find((e) => e.includes("new MutationObserver"));
  expect(install).toBeDefined();
  return install!;
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return (result.content[0] as { text: string }).text;
}

describe("drag tool (Story 18.6 FR-028, S6)", () => {
  beforeEach(() => {
    a11yTree.reset();
    vi.restoreAllMocks();
  });

  it("zod schema parses default steps=10 when omitted", () => {
    const parsed = dragSchema.parse({ from_x: 0, from_y: 0, to_x: 10, to_y: 10 });
    expect(parsed.steps).toBe(10);
  });

  it("zod schema rejects steps<5", () => {
    expect(() =>
      dragSchema.parse({ from_x: 0, from_y: 0, to_x: 10, to_y: 10, steps: 3 }),
    ).toThrow();
  });

  it("happy path with coordinates: dispatches press → 10×moved → released", async () => {
    const { cdp, sendMock } = mockCdpForDrag();
    const result = await dragHandler({ from_x: 0, from_y: 0, to_x: 100, to_y: 100, steps: 10 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    const mouseCalls = calls(sendMock, "Input.dispatchMouseEvent");
    // 1 mousePressed + 10 mouseMoved + 1 mouseReleased = 12 Events
    expect(mouseCalls.length).toBe(12);
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: "mousePressed", buttons: 1 });
    expect(mouseCalls[11]?.[1]).toMatchObject({ type: "mouseReleased", buttons: 0 });
    for (let i = 1; i <= 10; i++) {
      expect(mouseCalls[i]?.[1]).toMatchObject({ type: "mouseMoved", buttons: 1 });
    }
  });

  it("interpolation: steps=15 produces 15 mouseMoved events with linearly spaced coords", async () => {
    const { cdp, sendMock } = mockCdpForDrag();
    await dragHandler({ from_x: 0, from_y: 0, to_x: 150, to_y: 0, steps: 15 }, cdp, "sess-1");

    const movedCalls = calls(sendMock, "Input.dispatchMouseEvent").filter(
      (c) => (c[1] as { type: string }).type === "mouseMoved",
    );
    expect(movedCalls.length).toBe(15);
    expect((movedCalls[0]?.[1] as { x: number }).x).toBeCloseTo(10, 5);
    expect((movedCalls[6]?.[1] as { x: number }).x).toBeCloseTo(70, 5);
    expect((movedCalls[14]?.[1] as { x: number }).x).toBeCloseTo(150, 5);
  });

  it("error path: invalid from_ref returns isError, no CDP dispatchMouseEvent called", async () => {
    const { cdp, sendMock } = mockCdpForDrag();
    const result = await dragHandler({ from_ref: "e999", to_x: 100, to_y: 100 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(calls(sendMock, "Input.dispatchMouseEvent").length).toBe(0);
  });

  it("validation: missing source returns isError", async () => {
    const { cdp } = mockCdpForDrag();
    const result = await dragHandler({ to_x: 10, to_y: 10 }, cdp, "sess-1");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("source");
  });

  it("validation: missing target returns isError", async () => {
    const { cdp } = mockCdpForDrag();
    const result = await dragHandler({ from_x: 0, from_y: 0 }, cdp, "sess-1");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("target");
  });

  it("response content includes 'Dragged' and step count", async () => {
    const { cdp } = mockCdpForDrag();
    const result = await dragHandler({ from_x: 0, from_y: 0, to_x: 50, to_y: 50, steps: 8 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Dragged");
    expect(text(result)).toContain("8 steps");
  });

  it("RefNotFoundError is caught and its message names the ref", async () => {
    const sendMock = vi.fn(async () => {
      throw new RefNotFoundError("Element e42 not found.");
    });
    const cdp = { send: sendMock, on: vi.fn(), once: vi.fn(), off: vi.fn() } as unknown as CdpClient;

    const result = await dragHandler({ from_ref: "e42", to_x: 100, to_y: 100 }, cdp, "sess-1");
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("e42");
  });

  it("happy path ref→ref: resolves both refs, scrolls only the source into view, drags between the centers", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockImplementation(async (_cdp, sessionId, target) => {
      const ref = (target as { ref?: string }).ref;
      if (ref === "e5") {
        return { backendNodeId: 101, objectId: "obj-101", role: "listitem", name: "Source card", resolvedVia: "ref", resolvedSessionId: sessionId };
      }
      if (ref === "e8") {
        return { backendNodeId: 202, objectId: "obj-202", role: "list", name: "Target column", resolvedVia: "ref", resolvedSessionId: sessionId };
      }
      throw new RefNotFoundError(`Unexpected ref ${ref}`);
    });
    const { cdp, sendMock } = mockCdpForDrag({
      quads: {
        101: [40, 40, 60, 40, 60, 60, 40, 60], // center (50, 50)
        202: [240, 140, 260, 140, 260, 160, 240, 160], // center (250, 150)
      },
    });

    const result = await dragHandler({ from_ref: "e5", to_ref: "e8", steps: 10 }, cdp, "sess-ref");

    expect(result.isError).toBeFalsy();
    const scrolls = calls(sendMock, "DOM.scrollIntoViewIfNeeded");
    expect(scrolls).toEqual([["DOM.scrollIntoViewIfNeeded", { backendNodeId: 101 }, "sess-ref"]]);

    const mouseCalls = calls(sendMock, "Input.dispatchMouseEvent");
    expect(mouseCalls.length).toBe(12);
    expect(mouseCalls[0]?.[1]).toMatchObject({ type: "mousePressed", x: 50, y: 50, buttons: 1 });
    expect(mouseCalls[11]?.[1]).toMatchObject({ type: "mouseReleased", x: 250, y: 150, buttons: 0 });
    expect((mouseCalls[1]?.[1] as { x: number }).x).toBeCloseTo(70, 5);
    expect((mouseCalls[1]?.[1] as { y: number }).y).toBeCloseTo(60, 5);
    expect(text(result)).toContain("e5");
    expect(text(result)).toContain("e8");
    expect(text(result)).toContain("Dragged");
  });

  it("handler-guard: steps < 5 returns isError even when Zod is bypassed", async () => {
    const { cdp, sendMock } = mockCdpForDrag();
    const rawParams = { from_x: 0, from_y: 0, to_x: 100, to_y: 100, steps: 2 } as unknown as Parameters<typeof dragHandler>[0];

    const result = await dragHandler(rawParams, cdp, "sess-m4");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("steps");
    expect(text(result)).toContain(">= 5");
    expect(calls(sendMock, "Input.dispatchMouseEvent").length).toBe(0);
  });

  // --- S6: scroll into view --------------------------------------------------

  it("S6: scrolls a selector source into view before reading the coordinates it drags from", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockResolvedValue({
      backendNodeId: 7, objectId: "obj-7", role: "", name: "", resolvedVia: "css", resolvedSessionId: "sess-1",
    });
    const { cdp, sendMock } = mockCdpForDrag();

    await dragHandler({ from_selector: "#item-1", to_x: 100, to_y: 100 }, cdp, "sess-1");

    const methods = sendMock.mock.calls.map((c) => c[0] as string);
    const scrollIdx = methods.indexOf("DOM.scrollIntoViewIfNeeded");
    const quadsIdx = methods.lastIndexOf("DOM.getContentQuads");
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(scrollIdx).toBeLessThan(quadsIdx);
  });

  it("S6: a target outside the visible area is an error and nothing is dispatched", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockImplementation(async (_cdp, sessionId, target) => {
      const ref = (target as { ref?: string }).ref;
      return { backendNodeId: ref === "e1" ? 1 : 2, objectId: "o", role: "listitem", name: "", resolvedVia: "ref", resolvedSessionId: sessionId };
    });
    const { cdp, sendMock } = mockCdpForDrag({
      view: { w: 1200, h: 800 },
      quads: { 1: [590, 390, 610, 390, 610, 410, 590, 410], 2: [590, 1321, 610, 1321, 610, 1341, 590, 1341] },
    });

    const result = await dragHandler({ from_ref: "e1", to_ref: "e2" }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("outside the visible area");
    expect(text(result)).toContain("e2");
    expect(calls(sendMock, "Input.dispatchMouseEvent").length).toBe(0);
  });

  it("S6: from_ref + to_x/to_y — when scrolling the source moves it, the target point moves with it", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockResolvedValue({
      backendNodeId: 5, objectId: "o", role: "listitem", name: "", resolvedVia: "ref", resolvedSessionId: "sess-1",
    });
    const { cdp, sendMock } = mockCdpForDrag({
      quadsSeq: {
        5: [
          [90, 1290, 110, 1290, 110, 1310, 90, 1310], // before scrolling: center (100, 1300)
          [90, 290, 110, 290, 110, 310, 90, 310], // after scrolling: center (100, 300)
        ],
      },
    });

    const result = await dragHandler({ from_ref: "e1", to_x: 100, to_y: 1400 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    const mouse = calls(sendMock, "Input.dispatchMouseEvent");
    expect(mouse[0]?.[1]).toMatchObject({ type: "mousePressed", x: 100, y: 300 });
    expect(mouse[mouse.length - 1]?.[1]).toMatchObject({ type: "mouseReleased", x: 100, y: 400 });
    expect(text(result)).toContain("target point shifted by (0, -1000)");
  });

  // --- S6: HTML5 drag-and-drop ------------------------------------------------

  it("S6: HTML5 — after Input.dragIntercepted the drag continues as dispatchDragEvent and drops on the target", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ interceptAtMove: 1, probe: { dragstart: true, drop: true, dragend: "move" } });

    const result = await dragHandler({ from_x: 100, from_y: 100, to_x: 100, to_y: 200, steps: 10 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("HTML5 drag-and-drop");
    expect(result._meta?.dragMode).toBe("html5");

    const intercept = calls(sendMock, "Input.setInterceptDrags");
    expect(intercept[0]).toEqual(["Input.setInterceptDrags", { enabled: true }, "sess-1"]);
    expect(intercept[intercept.length - 1]).toEqual(["Input.setInterceptDrags", { enabled: false }, "sess-1"]);

    const mouseTypes = calls(sendMock, "Input.dispatchMouseEvent").map((c) => (c[1] as { type: string }).type);
    expect(mouseTypes).toEqual(["mousePressed", "mouseMoved"]); // no mouseReleased after a drop

    const dragTypes = calls(sendMock, "Input.dispatchDragEvent").map((c) => (c[1] as { type: string }).type);
    expect(dragTypes[0]).toBe("dragEnter");
    expect(dragTypes[dragTypes.length - 1]).toBe("drop");
    expect(dragTypes.filter((t) => t === "dragOver").length).toBe(10); // 9 remaining steps + 1 settle dragOver
    const drop = calls(sendMock, "Input.dispatchDragEvent").pop()!;
    expect(drop[1]).toMatchObject({ type: "drop", x: 100, y: 200, data: DRAG_DATA });
    expect(drop[2]).toBe("sess-1");
  });

  it("S6: HTML5 drag whose drop the target does not accept is an error, not 'Dragged'", async () => {
    const { cdp } = mockCdpForDrag({ interceptAtMove: 1, probe: { dragstart: true, drop: false, dragend: "none", mutationsInside: 2 } });

    const result = await dragHandler({ from_x: 100, from_y: 100, to_x: 600, to_y: 500 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("did not accept the drop");
    expect(text(result)).not.toMatch(/^Dragged/);
  });

  it("S6: a late Input.dragIntercepted (after the moves, dragstart seen) still ends in a drop", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ interceptOnPeek: true, sawDragstart: true, probe: { dragstart: true, drop: true } });

    const result = await dragHandler({ from_x: 100, from_y: 100, to_x: 104, to_y: 100, steps: 5 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    const dragTypes = calls(sendMock, "Input.dispatchDragEvent").map((c) => (c[1] as { type: string }).type);
    expect(dragTypes).toEqual(["dragEnter", "dragOver", "drop"]);
    const mouseTypes = calls(sendMock, "Input.dispatchMouseEvent").map((c) => (c[1] as { type: string }).type);
    expect(mouseTypes).not.toContain("mouseReleased");
  });

  it("S6: source inside an OOPIF — mouse and drag events go to the frame session, intercept stays on the main session", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockImplementation(async (_cdp, _sessionId, target) => {
      const ref = (target as { ref?: string }).ref;
      return { backendNodeId: ref === "e1" ? 1 : 2, objectId: "o", role: "listitem", name: "", resolvedVia: "ref", resolvedSessionId: "oopif-1" };
    });
    const { cdp, sendMock } = mockCdpForDrag({ interceptAtMove: 1, probe: { dragstart: true, drop: true } });

    const result = await dragHandler({ from_ref: "e1", to_ref: "e2" }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    for (const c of calls(sendMock, "Input.setInterceptDrags")) expect(c[2]).toBe("sess-1");
    for (const c of calls(sendMock, "Input.dispatchMouseEvent")) expect(c[2]).toBe("oopif-1");
    for (const c of calls(sendMock, "Input.dispatchDragEvent")) expect(c[2]).toBe("oopif-1");
  });

  it("S6: source and target in different frames is an error before any input", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockImplementation(async (_cdp, sessionId, target) => {
      const ref = (target as { ref?: string }).ref;
      return { backendNodeId: 1, objectId: "o", role: "listitem", name: "", resolvedVia: "ref", resolvedSessionId: ref === "e1" ? sessionId : "oopif-1" };
    });
    const { cdp, sendMock } = mockCdpForDrag();

    const result = await dragHandler({ from_ref: "e1", to_ref: "e2" }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("different frames");
    expect(calls(sendMock, "Input.dispatchMouseEvent").length).toBe(0);
  });

  it("S6: a source inside an OOPIF with a coordinate target is an error — frame and page coordinates differ", async () => {
    vi.spyOn(elementUtils, "resolveElement").mockResolvedValue({
      backendNodeId: 1, objectId: "o", role: "listitem", name: "", resolvedVia: "ref", resolvedSessionId: "oopif-1",
    });
    const { cdp, sendMock } = mockCdpForDrag();

    const result = await dragHandler({ from_ref: "e1", to_x: 300, to_y: 200 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("inside an iframe");
    expect(text(result)).toContain("to_ref");
    expect(calls(sendMock, "Input.dispatchMouseEvent").length).toBe(0);
  });

  it("S6: a stale to_ref is named in the error — not the valid from_ref", async () => {
    const stale = "Element e77 is a stale ref: its node no longer exists (page re-rendered or navigated). Call view_page for fresh refs and retry.";
    vi.spyOn(elementUtils, "resolveElement").mockImplementation(async (_cdp, sessionId, target) => {
      const ref = (target as { ref?: string }).ref;
      if (ref === "e5") {
        return { backendNodeId: 5, objectId: "o", role: "listitem", name: "Card", resolvedVia: "ref", resolvedSessionId: sessionId };
      }
      throw new RefNotFoundError(stale);
    });
    const { cdp, sendMock } = mockCdpForDrag();

    const result = await dragHandler({ from_ref: "e5", to_ref: "e77" }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(stale);
    expect(text(result)).not.toContain("e5");
    expect(calls(sendMock, "Input.dispatchMouseEvent").length).toBe(0);
  });

  // --- S6: no silent success ----------------------------------------------------

  it("S6: mouse drag with a page reaction (slider input events) reports the reaction", async () => {
    const { cdp } = mockCdpForDrag({ probe: { mutationsInside: 0, inputs: 11 } });

    const result = await dragHandler({ from_x: 48, from_y: 48, to_x: 250, to_y: 48 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Dragged");
    expect(text(result)).toContain("page reacted: 11 input events");
    expect(result._meta?.dragMode).toBe("mouse");
  });

  it("S6: mouse drag without any detectable effect is an error instead of 'Dragged'", async () => {
    const { cdp } = mockCdpForDrag({ probe: { mutationsInside: 0 } });

    const result = await dragHandler({ from_x: 600, from_y: 700, to_x: 650, to_y: 720 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("no detectable effect");
    expect(text(result)).not.toMatch(/^Dragged/);
  });

  it("S6: DOM changes outside source and target (ticker, clock) do not turn a no-effect mouse drag into success", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ probe: { mutationsInside: 0, mutationsOutside: 3 } });

    const result = await dragHandler({ from_x: 600, from_y: 700, to_x: 650, to_y: 720 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("no detectable effect");
    expect(text(result)).toContain("3 DOM changes elsewhere on the page did not count");
    expect(text(result)).not.toContain("Dragged");
    // The probe scopes DOM changes to the common ancestor of the elements at start and end point.
    const install = installExpression(sendMock);
    expect(install).toContain("document.elementFromPoint(600, 700)");
    expect(install).toContain("document.elementFromPoint(650, 720)");
    expect(install).toContain("scope.contains(r.target)");
  });

  it("S6: a mouse drag that only selected text is not reported as 'Dragged'", async () => {
    const { cdp } = mockCdpForDrag({ probe: { mutationsInside: 0, selected: 12 } });

    const result = await dragHandler({ from_x: 100, from_y: 300, to_x: 400, to_y: 300 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("only selected 12 characters of text");
    expect(text(result)).not.toContain("Dragged");
  });

  it("S6: scrolling is no page reaction — the probe listens for no scroll events (PB's own scrollIntoViewIfNeeded fires one)", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ probe: { mutationsInside: 0 } });

    const result = await dragHandler({ from_x: 100, from_y: 100, to_x: 200, to_y: 100 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    const install = installExpression(sendMock);
    expect(install).not.toMatch(/scroll\s*:/);
    expect(install).not.toContain('"scroll"');
  });

  it("S6: mouse drag on a canvas is not an error and points to capture_image", async () => {
    const { cdp } = mockCdpForDrag({ view: { w: 1200, h: 800, canvas: true }, probe: { mutationsInside: 0 } });

    const result = await dragHandler({ from_x: 80, from_y: 150, to_x: 300, to_y: 200 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("canvas");
    expect(text(result)).toContain("capture_image");
  });

  it("S6: the probe is read only after a frame pause — re-renders after the mouseup count", async () => {
    const { cdp, sendMock } = mockCdpForDrag();

    await dragHandler({ from_x: 10, from_y: 10, to_x: 50, to_y: 50 }, cdp, "sess-1");

    const all = sendMock.mock.calls;
    const released = all.findIndex((c) => c[0] === "Input.dispatchMouseEvent" && (c[1] as { type: string }).type === "mouseReleased");
    const exprOf = (c: unknown[]) => String((c[1] as { expression?: string } | undefined)?.expression ?? "");
    const pause = all.findIndex((c) => c[0] === "Runtime.evaluate" && exprOf(c).includes("requestAnimationFrame"));
    const read = all.findIndex((c) => c[0] === "Runtime.evaluate" && exprOf(c).includes("p.read()"));
    expect(released).toBeGreaterThan(-1);
    expect(pause).toBeGreaterThan(released);
    expect(read).toBeGreaterThan(pause);
    expect(all[pause]?.[1]).toMatchObject({ awaitPromise: true, contextId: PROBE_CONTEXT_ID });
  });

  it("S6: page gone after the drop (navigation) is reported, not claimed as plain success", async () => {
    const { cdp } = mockCdpForDrag({ navigates: true });

    const result = await dragHandler({ from_x: 10, from_y: 10, to_x: 50, to_y: 50 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("navigated or reloaded");
  });

  it("S6: without a page probe the answer says the effect is unchecked — never 'navigated'", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ noIsolatedWorld: true });

    const result = await dragHandler({ from_x: 10, from_y: 10, to_x: 50, to_y: 50 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("could not be checked");
    expect(text(result)).not.toContain("navigated");
    expect(calls(sendMock, "Runtime.evaluate")).toHaveLength(0);
  });

  // --- S6: probe in an isolated world, always torn down (Plancheck P31) ---------

  it("S6: the probe lives in an isolated world — every probe call carries its context id, and it is torn down after success", async () => {
    const { cdp, sendMock } = mockCdpForDrag();

    const result = await dragHandler({ from_x: 10, from_y: 10, to_x: 50, to_y: 50 }, cdp, "sess-1");

    expect(result.isError).toBeFalsy();
    expect(calls(sendMock, "Page.createIsolatedWorld")).toEqual([
      ["Page.createIsolatedWorld", { frameId: "frame-1", worldName: "__pb_drag_probe__" }, "sess-1"],
    ]);
    const evals = calls(sendMock, "Runtime.evaluate");
    expect(evals.length).toBeGreaterThan(0);
    for (const c of evals) expect((c[1] as { contextId?: number }).contextId).toBe(PROBE_CONTEXT_ID);
    const exprs = expressions(sendMock);
    expect(exprs[exprs.length - 1]).toContain("p.stop()");
  });

  it("S6: the probe is torn down even when a CDP call fails mid-drag", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ failOnMove: 3 });

    const result = await dragHandler({ from_x: 0, from_y: 0, to_x: 100, to_y: 0 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    const exprs = expressions(sendMock);
    expect(exprs.some((e) => e.includes("p.read()"))).toBe(false);
    expect(exprs[exprs.length - 1]).toContain("p.stop()");
  });

  it("S6: a failing CDP call mid-drag releases the mouse and switches interception off", async () => {
    const { cdp, sendMock } = mockCdpForDrag({ failOnMove: 3 });

    const result = await dragHandler({ from_x: 0, from_y: 0, to_x: 100, to_y: 0 }, cdp, "sess-1");

    expect(result.isError).toBe(true);
    const mouseTypes = calls(sendMock, "Input.dispatchMouseEvent").map((c) => (c[1] as { type: string }).type);
    expect(mouseTypes[mouseTypes.length - 1]).toBe("mouseReleased");
    const intercept = calls(sendMock, "Input.setInterceptDrags");
    expect(intercept[intercept.length - 1]?.[1]).toEqual({ enabled: false });
  });
});
