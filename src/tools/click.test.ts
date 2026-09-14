import { describe, it, expect, vi, beforeEach } from "vitest";
import { clickSchema, clickHandler } from "./click.js";
import type { ClickParams } from "./click.js";
import type { CdpClient } from "../cdp/cdp-client.js";

// --- Mock element-utils ---

vi.mock("./element-utils.js", () => {
  class RefNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RefNotFoundError";
    }
  }
  return {
    resolveElement: vi.fn(),
    buildRefNotFoundError: vi.fn(),
    RefNotFoundError,
  };
});

vi.mock("../cache/a11y-tree.js", () => ({
  a11yTree: {
    classifyRef: vi.fn().mockReturnValue("clickable"),
    getInteractiveElements: vi.fn().mockReturnValue([]),
    findByText: vi.fn().mockReturnValue(null),
    hasRefs: vi.fn().mockReturnValue(true),
    getTree: vi.fn().mockResolvedValue({ text: "", tokenCount: 0, refCount: 0 }),
    findAllByText: vi.fn().mockReturnValue([]),
    resolveRefFull: vi.fn().mockReturnValue(undefined),
  },
}));

import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";
const mockResolveElement = vi.mocked(resolveElement);
const mockBuildRefNotFoundError = vi.mocked(buildRefNotFoundError);
const mockGetInteractiveElements = vi.mocked(a11yTree.getInteractiveElements);
const mockFindByText = vi.mocked(a11yTree.findByText);
const mockHasRefs = vi.mocked(a11yTree.hasRefs);
const mockFindAllByText = vi.mocked(a11yTree.findAllByText);
const mockResolveRefFull = vi.mocked(a11yTree.resolveRefFull);
const mockGetTree = vi.mocked(a11yTree.getTree);

// --- Mock CDP client ---

type EventCallback = (params: unknown, sessionId?: string) => void;

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
}

function createMockCdp(overrides: Record<string, unknown> = {}): MockCdpSetup {
  const defaultResponses: Record<string, unknown> = {
    "Runtime.evaluate": { result: { value: { sx: 0, sy: 0 } } },
    "DOM.scrollIntoViewIfNeeded": {},
    "DOM.getContentQuads": { quads: [[100, 100, 200, 100, 200, 200, 100, 200]] },
    "Input.dispatchMouseEvent": {},
    "DOM.getDocument": { root: { nodeId: 1 } },
    "DOM.querySelector": { nodeId: 42 },
    "DOM.describeNode": { node: { backendNodeId: 100 } },
    "Target.getTargets": { targetInfos: [{ targetId: "t1", type: "page", url: "https://example.com", title: "Test" }] },
    ...overrides,
  };

  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async (method: string, args?: unknown) => {
    if (method in defaultResponses) {
      const val = defaultResponses[method];
      if (typeof val === "function") return (val as (a?: unknown) => unknown)(args);
      return val;
    }
    return {};
  });

  const onFn = vi.fn((method: string, callback: EventCallback, sessionId?: string) => {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add({ callback, sessionId });
  });

  const offFn = vi.fn((method: string, callback: EventCallback) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        if (entry.callback === callback) {
          set.delete(entry);
          break;
        }
      }
    }
  });

  const cdpClient = {
    send: sendFn,
    on: onFn,
    once: vi.fn(),
    off: offFn,
  } as unknown as CdpClient;

  return { cdpClient, sendFn };
}

describe("clickSchema", () => {
  it("should accept only ref", () => {
    const result = clickSchema.parse({ ref: "e5" });
    expect(result.ref).toBe("e5");
    expect(result.selector).toBeUndefined();
  });

  it("should accept only selector", () => {
    const result = clickSchema.parse({ selector: "#btn" });
    expect(result.selector).toBe("#btn");
    expect(result.ref).toBeUndefined();
  });

  it("should accept both ref and selector", () => {
    const result = clickSchema.parse({ ref: "e5", selector: "#btn" });
    expect(result.ref).toBe("e5");
    expect(result.selector).toBe("#btn");
  });

  it("should accept empty object (validation in handler)", () => {
    const result = clickSchema.parse({});
    expect(result.ref).toBeUndefined();
    expect(result.selector).toBeUndefined();
  });
});

describe("clickHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Validation tests ---

  it("should return isError when neither ref nor selector provided", async () => {
    const { cdpClient } = createMockCdp();
    const result = await clickHandler({} as ClickParams, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("click requires either 'ref'"),
      }),
    );
    expect(result._meta?.elapsedMs).toBe(0);
    expect(result._meta?.method).toBe("click");
  });

  // --- Ref click tests (AC #1) ---

  it("should click element by ref and return immediately without settle", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked e5 (ref)" }),
    );
    expect(result._meta?.method).toBe("click");
    expect(result._meta?.resolvedVia).toBe("ref");
    // No settle — no settleSignal or settleMs in _meta
    expect(result._meta).not.toHaveProperty("settleSignal");
    expect(result._meta).not.toHaveProperty("settleMs");

    // Verify CDP calls: scrollTo(0,0), scroll, getContentQuads, 3x mouse — NO Page.getFrameTree
    expect(sendFn).toHaveBeenCalledWith("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }, "s1");
    expect(sendFn).toHaveBeenCalledWith("DOM.scrollIntoViewIfNeeded", { backendNodeId: 42 }, "s1");
    expect(sendFn).toHaveBeenCalledWith("DOM.getContentQuads", { backendNodeId: 42 }, "s1");
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).not.toContain("Page.getFrameTree");
  });

  it("should dispatch mouseMoved, mousePressed and mouseReleased with correct center coordinates", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    // getContentQuads returns quad [100,100, 200,100, 200,200, 100,200]
    // Center: x = (100+200+200+100)/4 = 150, y = (100+100+200+200)/4 = 150
    const { cdpClient, sendFn } = createMockCdp();

    await clickHandler({ ref: "e5" }, cdpClient, "s1");

    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);

    // mouseMoved (establishes mouseenter/mouseover context)
    expect(mouseEvents[0][1]).toEqual({
      type: "mouseMoved",
      x: 150,
      y: 150,
      button: "none",
      buttons: 0,
    });

    // mousePressed
    expect(mouseEvents[1][1]).toEqual({
      type: "mousePressed",
      x: 150,
      y: 150,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });

    // mouseReleased
    expect(mouseEvents[2][1]).toEqual({
      type: "mouseReleased",
      x: 150,
      y: 150,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  });

  it("should not call settle or Page.getFrameTree", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp();

    await clickHandler({ ref: "e5" }, cdpClient, "s1");

    // 8 CDP calls: Target.getTargets (before), scrollTo(0,0), scrollIntoView, getContentQuads, 3x mouse, Target.getTargets (after)
    expect(sendFn).toHaveBeenCalledTimes(8);
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).toEqual([
      "Target.getTargets",
      "Runtime.evaluate",
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Target.getTargets",
    ]);
  });

  // --- CSS click tests (AC #2) ---

  it("should click element by CSS selector successfully", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 100,
      objectId: "obj-100",
      role: "",
      name: "",
      resolvedVia: "css",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: "#submit-btn" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked #submit-btn (css)" }),
    );
    expect(result._meta?.resolvedVia).toBe("css");

    // Verify resolveElement was called with selector target
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { selector: "#submit-btn" },
      undefined,
    );
  });

  it("should return isError when CSS selector not found", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '.nonexistent'"),
    );
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: ".nonexistent" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "click failed: Element not found for selector '.nonexistent'",
      }),
    );
  });

  // --- Contextual error message tests (AC #3) ---

  it("should include suggestion with role and name when ref not found", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e99 not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue(
      "Element e99 not found. Did you mean e5 (button 'Submit')?",
    );
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e99" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e99 not found. Did you mean e5 (button 'Submit')?",
      }),
    );
  });

  it("should show error without suggestion when buildRefNotFoundError returns no suggestion", async () => {
    mockResolveElement.mockRejectedValue(
      new RefNotFoundError("Element e99 not found."),
    );
    mockBuildRefNotFoundError.mockReturnValue("Element e99 not found.");
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e99" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "Element e99 not found.",
      }),
    );
  });

  // --- Priority tests ---

  it("should use ref when both ref and selector are provided", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e5", selector: "#btn" }, cdpClient, "s1");

    expect(result._meta?.resolvedVia).toBe("ref");
    // resolveElement should be called with ref target (not selector)
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { ref: "e5" },
      undefined,
    );
  });

  // --- Error handling tests ---

  it("should fallback to getBoundingClientRect when getContentQuads throws (BUG-005)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getContentQuads": () => {
        throw new Error("Node does not have a layout object");
      },
      "Runtime.callFunctionOn": () => ({
        result: { value: { x: 200, y: 300 } },
      }),
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        text: "Clicked e5 (ref, fallback: js-rect)",
      }),
    );
    expect(result._meta?.clickMethod).toBe("js-rect");

    // Should have called Runtime.callFunctionOn for getBoundingClientRect
    const jsCall = sendFn.mock.calls.find(
      (c: unknown[]) => c[0] === "Runtime.callFunctionOn" && typeof c[1] === "object" &&
        (c[1] as Record<string, unknown>).objectId === "obj-42",
    );
    expect(jsCall).toBeDefined();

    // Should still dispatch mouse events at the JS-computed coordinates
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
    expect(mouseEvents[0][1]).toEqual(expect.objectContaining({ type: "mouseMoved", x: 200, y: 300 }));
    expect(mouseEvents[1][1]).toEqual(expect.objectContaining({ type: "mousePressed", x: 200, y: 300 }));
    expect(mouseEvents[2][1]).toEqual(expect.objectContaining({ type: "mouseReleased", x: 200, y: 300 }));
  });

  it("should fallback to JS click when both getContentQuads and getBoundingClientRect fail (BUG-005 Shadow-DOM)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    let callCount = 0;
    const { cdpClient, sendFn } = createMockCdp({
      "DOM.getContentQuads": () => {
        throw new Error("Node does not have a layout object");
      },
      "Runtime.callFunctionOn": () => {
        callCount++;
        if (callCount === 1) {
          // First call: getBoundingClientRect fails
          throw new Error("Cannot find context with specified id");
        }
        // Second call: this.click() succeeds
        return { result: { value: undefined } };
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        text: "Clicked e5 (ref, fallback: js-click)",
      }),
    );
    expect(result._meta?.clickMethod).toBe("js-click");

    // No mouse events dispatched — pure JS click
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(0);
  });

  it("should return isError when DOM.scrollIntoViewIfNeeded throws", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp({
      "DOM.scrollIntoViewIfNeeded": () => {
        throw new Error("Could not find node with given id");
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "click failed: Could not find node with given id",
      }),
    );
  });

  // --- OOPIF tests ---

  it("click resolves OOPIF element and uses correct session", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 300,
      objectId: "obj-300",
      role: "button",
      name: "Sign In",
      resolvedVia: "ref",
      resolvedSessionId: "oopif-session-1",
    });
    const { cdpClient, sendFn } = createMockCdp();
    const mockSessionManager = {} as unknown as import("../cdp/session-manager.js").SessionManager;

    const result = await clickHandler({ ref: "e42" }, cdpClient, "s1", mockSessionManager);

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Clicked e42 (ref)" }),
    );

    // Verify CDP calls use OOPIF session for element interaction
    expect(sendFn).toHaveBeenCalledWith(
      "Runtime.evaluate",
      { expression: "window.scrollTo(0,0)" },
      "oopif-session-1",
    );
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.scrollIntoViewIfNeeded",
      { backendNodeId: 300 },
      "oopif-session-1",
    );
    expect(sendFn).toHaveBeenCalledWith(
      "DOM.getContentQuads",
      { backendNodeId: 300 },
      "oopif-session-1",
    );

    // Mouse events use OOPIF session (mouseMoved + mousePressed + mouseReleased)
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
    expect(mouseEvents[0][2]).toBe("oopif-session-1");

    // No settle — no Page.getFrameTree call
    const callMethods = sendFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(callMethods).not.toContain("Page.getFrameTree");

    // resolveElement was called with sessionManager
    expect(mockResolveElement).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      { ref: "e42" },
      mockSessionManager,
    );
  });

  // --- FR-008: Interactive element suggestions on CSS selector failure ---

  it("should include available interactive elements when CSS selector not found (FR-008)", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '#t2-1-verify'"),
    );
    mockGetInteractiveElements.mockReturnValue([
      "[e52] button 'Load Data'",
      "[e53] textbox 'Enter loaded value...'",
      "[e54] button 'Verify'",
    ]);
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: "#t2-1-verify" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Element not found for selector '#t2-1-verify'");
    expect(text).toContain("Available interactive elements:");
    expect(text).toContain("[e52] button 'Load Data'");
    expect(text).toContain("[e53] textbox 'Enter loaded value...'");
    expect(text).toContain("[e54] button 'Verify'");
    expect(mockGetInteractiveElements).toHaveBeenCalledWith(8);
  });

  it("should not include element hints when no interactive elements are known (FR-008)", async () => {
    mockResolveElement.mockRejectedValue(
      new Error("Element not found for selector '.nonexistent'"),
    );
    mockGetInteractiveElements.mockReturnValue([]);
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ selector: ".nonexistent" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("click failed: Element not found for selector '.nonexistent'");
    expect(text).not.toContain("Available interactive elements");
  });

  // --- FR-D: Coordinate-based click tests ---

  // Helper: mock for the combined FR-01 viewport-check-and-scroll evaluate
  function coordMock(sx: number, sy: number, oob: boolean, w = 1280, h = 800) {
    return {
      "Runtime.evaluate": (args: { expression: string }) => {
        // Combined FR-01 expression (contains innerWidth)
        if (args.expression.includes("innerWidth")) return { result: { value: { sx, sy, w, h, oob } } };
        // Ref-based click path (scrollTo(0,0))
        return { result: { value: undefined } };
      },
    };
  }

  it("should click at viewport coordinates without element resolution (FR-D)", async () => {
    const { cdpClient, sendFn } = createMockCdp(coordMock(0, 0, false));

    const result = await clickHandler({ x: 250, y: 100 }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked at (250, 100)" }),
    );
    expect(result._meta?.clickMethod).toBe("coordinates");
    expect(result._meta?.autoScrolled).toBe(false);

    // Should NOT call resolveElement
    expect(mockResolveElement).not.toHaveBeenCalled();

    // Should dispatch mouse events at exact coordinates
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
    expect(mouseEvents[0][1]).toEqual(expect.objectContaining({ type: "mouseMoved", x: 250, y: 100 }));
    expect(mouseEvents[1][1]).toEqual(expect.objectContaining({ type: "mousePressed", x: 250, y: 100 }));
    expect(mouseEvents[2][1]).toEqual(expect.objectContaining({ type: "mouseReleased", x: 250, y: 100 }));
  });

  it("should prefer coordinates over ref when both provided (FR-D)", async () => {
    const { cdpClient } = createMockCdp(coordMock(0, 0, false));

    const result = await clickHandler({ ref: "e5", x: 100, y: 200 }, cdpClient, "s1");

    expect(result.content[0]).toEqual(
      expect.objectContaining({ text: "Clicked at (100, 200)" }),
    );
    expect(mockResolveElement).not.toHaveBeenCalled();
  });

  // --- FR-01: Auto-scroll for out-of-viewport coordinates ---

  it("should auto-scroll when y exceeds viewport height (FR-01)", async () => {
    // After scrollTo, page is at sy=1200. Viewport coord = 1600-1200 = 400.
    // Headless adds scroll back: 400+1200 = 1600 (document coords for dispatch).
    const { cdpClient, sendFn } = createMockCdp(coordMock(0, 1200, true));

    const result = await clickHandler({ x: 300, y: 1600 }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked at (300, 1600) (auto-scrolled from page position)" }),
    );
    expect(result._meta?.autoScrolled).toBe(true);

    // Only 1 Runtime.evaluate call (combined viewport-check + scroll + read position)
    const evalCalls = sendFn.mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    expect(evalCalls).toHaveLength(1);

    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(3);
    expect(mouseEvents[0][1]).toEqual(expect.objectContaining({ type: "mouseMoved", x: 300, y: 1600 }));
  });

  it("should auto-scroll when x exceeds viewport width (FR-01)", async () => {
    const { cdpClient } = createMockCdp(coordMock(500, 0, true));

    const result = await clickHandler({ x: 1500, y: 300 }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result._meta?.autoScrolled).toBe(true);
  });

  it("should return isError for negative coordinates that can't be scrolled into view (FR-01)", async () => {
    // x=-10 → scrollTo(0,...) → viewportX = -10-0 = -10 → still out of bounds
    const { cdpClient } = createMockCdp(coordMock(0, 0, true));

    const result = await clickHandler({ x: -10, y: 100 }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("outside page bounds");
    expect(result._meta?.autoScrolled).toBe(true);
  });

  it("should return isError when auto-scroll fails to bring coords into viewport (FR-01 fallback)", async () => {
    // Page is only 1000px tall, LLM asks click at y=5000.
    // scrollTo lands at sy=202 (max scroll), viewportY = 5000-202 = 4798 >> 800 → still out.
    const { cdpClient, sendFn } = createMockCdp(coordMock(0, 202, true));

    const result = await clickHandler({ x: 300, y: 5000 }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("outside page bounds");
    expect(text).toContain("view_page");
    expect(result._meta?.autoScrolled).toBe(true);

    // Should NOT have dispatched any mouse events
    const mouseEvents = sendFn.mock.calls.filter(
      (call: unknown[]) => call[0] === "Input.dispatchMouseEvent",
    );
    expect(mouseEvents).toHaveLength(0);
  });

  it("should not auto-scroll when coordinates are within viewport (FR-01)", async () => {
    const { cdpClient } = createMockCdp(coordMock(0, 0, false));

    const result = await clickHandler({ x: 640, y: 400 }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result._meta?.autoScrolled).toBe(false);
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked at (640, 400)" }),
    );
  });

  // --- FR-E: New tab detection tests ---

  it("should report new tab when click opens one (FR-E)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "link",
      name: "Open in new tab",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    let callCount = 0;
    const { cdpClient } = createMockCdp({
      "Target.getTargets": () => {
        callCount++;
        if (callCount === 1) {
          return { targetInfos: [{ targetId: "t1", type: "page", url: "https://example.com", title: "Main" }] };
        }
        // After click: new tab appeared
        return {
          targetInfos: [
            { targetId: "t1", type: "page", url: "https://example.com", title: "Main" },
            { targetId: "t2", type: "page", url: "https://other.com", title: "Other" },
          ],
        };
      },
    });

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("New tab opened");
    expect(text).toContain("https://other.com");
    expect(text).toContain("switch_tab");
  });

  it("should not report new tab when click stays on same page (FR-E)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("New tab");
  });

  it("should not include element hints for non-selector errors (FR-008)", async () => {
    mockResolveElement.mockResolvedValue({
      backendNodeId: 42,
      objectId: "obj-42",
      role: "button",
      name: "Submit",
      resolvedVia: "css",
      resolvedSessionId: "s1",
    });
    mockGetInteractiveElements.mockReturnValue([
      "[e1] button 'Click me'",
    ]);
    const { cdpClient } = createMockCdp({
      "DOM.scrollIntoViewIfNeeded": () => {
        throw new Error("Could not find node with given id");
      },
    });

    const result = await clickHandler({ selector: "#btn" }, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("Available interactive elements");
  });

  // --- UX-001: Text-based click ---

  it("should resolve text to ref via findByText and click", async () => {
    mockFindByText.mockReturnValue({ ref: "e10", backendNodeId: 100 });
    mockResolveElement.mockResolvedValue({
      backendNodeId: 100,
      objectId: "obj-100",
      role: "button",
      name: "Submit",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ text: "Submit" } as ClickParams, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "text", text: "Clicked e10 (ref)" }),
    );
    expect(mockFindByText).toHaveBeenCalledWith("Submit");
  });

  it("should return error with available elements when text not found", async () => {
    mockFindByText.mockReturnValue(null);
    mockGetInteractiveElements.mockReturnValue(["[e1] button 'OK'", "[e2] link 'Home'"]);
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ text: "Nonexistent" } as ClickParams, cdpClient, "s1");

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('No element found with text "Nonexistent"');
    expect(text).toContain("[e1] button 'OK'");
  });

  it("should fetch a11y tree when refs not yet populated", async () => {
    mockHasRefs.mockReturnValue(false);
    mockFindByText.mockReturnValue({ ref: "e5", backendNodeId: 50 });
    mockResolveElement.mockResolvedValue({
      backendNodeId: 50,
      objectId: "obj-50",
      role: "link",
      name: "Home",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ text: "Home" } as ClickParams, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    expect(a11yTree.getTree).toHaveBeenCalled();
  });

  it("should always fetch fresh a11y tree even when refs exist (FR-046: stale ref after DOM mutation)", async () => {
    // Simulate: hasRefs() returns true (stale refs from before a type/DOM-restructure)
    mockHasRefs.mockReturnValue(true);
    mockFindByText.mockReturnValue({ ref: "e200", backendNodeId: 200 });
    mockResolveElement.mockResolvedValue({
      backendNodeId: 200,
      objectId: "obj-200",
      role: "button",
      name: "Suchen",
      resolvedVia: "ref",
      resolvedSessionId: "s1",
    });
    const { cdpClient } = createMockCdp();

    const result = await clickHandler({ text: "Suchen" } as ClickParams, cdpClient, "s1");

    expect(result.isError).toBeUndefined();
    // Key assertion: getTree MUST be called with fresh:true even though hasRefs() was true
    expect(a11yTree.getTree).toHaveBeenCalledWith(
      cdpClient,
      "s1",
      expect.objectContaining({ fresh: true }),
      undefined,
    );
    expect(mockFindByText).toHaveBeenCalledWith("Suchen");
  });

  // --- FR-051: detached node — clear message, no click at (0,0) ---

  describe("FR-051 — detached node handling in dispatchClick", () => {
    const resolved = () => mockResolveElement.mockResolvedValue({
      backendNodeId: 42, objectId: "obj-42", role: "button", name: "Speichern",
      resolvedVia: "ref", resolvedSessionId: "s1",
    });
    const mouseEvents = (sendFn: ReturnType<typeof vi.fn>) =>
      sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Input.dispatchMouseEvent");
    const detachedText =
      "click failed: Element e42 was replaced by a page re-render (node detached from document). Call view_page for fresh refs and retry.";

    it("scrollIntoViewIfNeeded detached → stale-ref message, no mouse events", async () => {
      resolved();
      const { cdpClient, sendFn } = createMockCdp({
        "DOM.scrollIntoViewIfNeeded": () => { throw new Error("CDP error -32000: Node is detached from document"); },
      });

      const result = await clickHandler({ ref: "e42" }, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(detachedText);
      expect(mouseEvents(sendFn)).toHaveLength(0);
    });

    it("getContentQuads detached → stale-ref message instead of a (0,0) click", async () => {
      resolved();
      const { cdpClient, sendFn } = createMockCdp({
        "DOM.getContentQuads": () => { throw new Error("CDP error -32000: Node is detached from document"); },
        "Runtime.callFunctionOn": () => ({ result: { value: { x: 0, y: 0, w: 0, h: 0, connected: false } } }),
      });

      const result = await clickHandler({ ref: "e42" }, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(detachedText);
      expect(mouseEvents(sendFn)).toHaveLength(0);
    });

    it("getContentQuads detached and rect probe unavailable → stale-ref message, no js-click on the detached node", async () => {
      resolved();
      const { cdpClient, sendFn } = createMockCdp({
        "DOM.getContentQuads": () => { throw new Error("CDP error -32000: Node is detached from document"); },
        "Runtime.callFunctionOn": () => { throw new Error("Cannot find context with specified id"); },
      });

      const result = await clickHandler({ ref: "e42" }, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(detachedText);
      expect(sendFn.mock.calls.filter((c: unknown[]) => c[0] === "Runtime.callFunctionOn")).toHaveLength(0);
    });

    it("rect fallback reports a disconnected node → stale-ref message, no js-click", async () => {
      resolved();
      const { cdpClient, sendFn } = createMockCdp({
        "DOM.getContentQuads": () => { throw new Error("Could not compute content quads"); },
        "Runtime.callFunctionOn": () => ({ result: { value: { x: 0, y: 0, w: 0, h: 0, connected: false } } }),
      });

      const result = await clickHandler({ ref: "e42" }, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(detachedText);
      expect(mouseEvents(sendFn)).toHaveLength(0);
      const jsClicks = sendFn.mock.calls.filter(
        (c: unknown[]) => c[0] === "Runtime.callFunctionOn" && String((c[1] as { functionDeclaration: string }).functionDeclaration).includes("this.click()"),
      );
      expect(jsClicks).toHaveLength(0);
    });

    it("rect fallback with a zero-size but connected box → js-click instead of a coordinate click", async () => {
      resolved();
      let calls = 0;
      const { cdpClient, sendFn } = createMockCdp({
        "DOM.getContentQuads": () => { throw new Error("Could not compute content quads"); },
        "Runtime.callFunctionOn": () => {
          calls++;
          if (calls === 1) return { result: { value: { x: 0, y: 0, w: 0, h: 0, connected: true } } };
          return { result: { value: undefined } }; // this.click()
        },
      });

      const result = await clickHandler({ ref: "e42" }, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(result._meta?.clickMethod).toBe("js-click");
      expect(mouseEvents(sendFn)).toHaveLength(0);
    });
  });

  // --- FR-050: several same-name matches → take the first connected, visible one in the same context ---

  describe("FR-050 — live check of same-name candidates", () => {
    type Probe = { connected: boolean; visible: boolean; docUrl: string };
    const PAGE = "https://example.com/app";
    const candidates = [
      { ref: "e5", backendNodeId: 5, sessionId: "s1" },
      { ref: "e9", backendNodeId: 9, sessionId: "s1" },
      { ref: "e12", backendNodeId: 12, sessionId: "oopif-1" },
      { ref: "e13", backendNodeId: 13, sessionId: "s1" },
    ];
    const PROBE_MARK = "ownerDocument";
    const probeCalls = (sendFn: ReturnType<typeof vi.fn>) =>
      sendFn.mock.calls.filter(
        (c: unknown[]) => c[0] === "Runtime.callFunctionOn"
          && String((c[1] as { functionDeclaration: string }).functionDeclaration).includes(PROBE_MARK),
      );
    const live = (connected: boolean, visible = true, docUrl = PAGE): Probe => ({ connected, visible, docUrl });

    /**
     * probes: objectId ("live-<ref>") → probe result; a ref listed in `gone`
     * fails DOM.resolveNode ("No node with given id found"); a ref listed in
     * `fatal` fails with a transport error.
     */
    function arm(list: typeof candidates, probes: Record<string, Probe>, gone: string[] = [], fatal: string[] = []) {
      mockFindByText.mockReturnValue({ ref: list[0].ref, backendNodeId: list[0].backendNodeId });
      mockFindAllByText.mockReturnValue(list);
      mockResolveRefFull.mockImplementation((ref: string) => {
        const c = list.find((x) => x.ref === ref);
        return c ? { backendNodeId: c.backendNodeId, sessionId: c.sessionId } : undefined;
      });
      mockResolveElement.mockImplementation(async (_cdp, _sid, target) => ({
        backendNodeId: list.find((x) => x.ref === target.ref)!.backendNodeId,
        objectId: `obj-${target.ref}`,
        role: "button", name: "Speichern", resolvedVia: "ref" as const, resolvedSessionId: "s1",
      }));
      return createMockCdp({
        "Runtime.evaluate": (args: unknown) => {
          const expr = (args as { expression: string }).expression;
          if (expr === "document.URL") return { result: { value: PAGE } };
          return { result: { value: { sx: 0, sy: 0 } } };
        },
        "DOM.resolveNode": (args: unknown) => {
          const { backendNodeId } = args as { backendNodeId: number };
          const ref = list.find((x) => x.backendNodeId === backendNodeId)!.ref;
          if (fatal.includes(ref)) throw new Error("CdpClient is closed");
          if (gone.includes(ref)) throw new Error("CDP error -32000: No node with given id found");
          return { object: { objectId: `live-${ref}` } };
        },
        "Runtime.callFunctionOn": (args: unknown) => {
          const { objectId, functionDeclaration } = args as { objectId: string; functionDeclaration: string };
          if (functionDeclaration.includes(PROBE_MARK)) {
            return { result: { value: probes[objectId] ?? live(false) } };
          }
          return { result: { value: undefined } };
        },
      });
    }

    it("clicks the second candidate when the first is detached and the second is connected, visible, same document", async () => {
      const { cdpClient, sendFn } = arm(candidates, { "live-e5": live(false), "live-e9": live(true) });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Clicked e9 (ref) — e5 was already replaced, took the live match");
      expect(result._meta?.liveMatchFrom).toBe("e5");
      expect(mockResolveElement).toHaveBeenCalledWith(cdpClient, "s1", { ref: "e9" }, undefined);
      expect(probeCalls(sendFn)).toHaveLength(3); // fix round 3: e5, then newest-first e13 and e9 (ambiguity check); e12 other session
    });

    it("treats a candidate whose node is gone (DOM.resolveNode fails) as not connected and moves on", async () => {
      const { cdpClient } = arm(candidates, { "live-e13": live(true) }, ["e5", "e9"]);

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      // e12 belongs to another session and is skipped without a probe; e13 is the replacement
      expect(result.content[0].text).toBe("Clicked e13 (ref) — e5 was already replaced, took the live match");
    });

    it("routes probes through the owner session of OOPIF candidates", async () => {
      const oopif = [
        { ref: "e20", backendNodeId: 20, sessionId: "oopif-1" },
        { ref: "e21", backendNodeId: 21, sessionId: "oopif-1" },
      ];
      const { cdpClient, sendFn } = arm(oopif, { "live-e20": live(false), "live-e21": live(true) });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.content[0].text).toBe("Clicked e21 (ref) — e20 was already replaced, took the live match");
      const routed = sendFn.mock.calls.filter(
        (c: unknown[]) => (c[0] === "DOM.resolveNode" || c[0] === "Runtime.callFunctionOn") && c[2] === "oopif-1",
      );
      expect(routed.length).toBeGreaterThanOrEqual(4);
    });

    it("keeps the first candidate when it is still connected — even if invisible (selection identical to today)", async () => {
      const { cdpClient, sendFn } = arm(candidates, { "live-e5": live(true, false), "live-e9": live(true) });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.content[0].text).toBe("Clicked e5 (ref)");
      expect(result._meta?.liveMatchFrom).toBeUndefined();
      expect(probeCalls(sendFn)).toHaveLength(1); // only the first is probed
    });

    it("rejects a replacement without a visible layout box and reports the stale hint", async () => {
      const { cdpClient, sendFn } = arm(candidates, { "live-e5": live(false), "live-e9": live(true, false), "live-e13": live(true, false) });
      mockResolveElement.mockResolvedValue({
        backendNodeId: 5, objectId: "obj-e5", role: "button", name: "Speichern", resolvedVia: "ref", resolvedSessionId: "s1",
      });
      const base = sendFn.getMockImplementation()!;
      sendFn.mockImplementation(async (method: string, args?: unknown, sid?: string) => {
        if (method === "DOM.scrollIntoViewIfNeeded") throw new Error("CDP error -32000: Node is detached from document");
        return base(method, args, sid);
      });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "click failed: Element e5 was replaced by a page re-render (node detached from document). Call view_page for fresh refs and retry.",
      );
    });

    it("rejects a replacement from another document (same session, other frame) and another session", async () => {
      const { cdpClient, sendFn } = arm(candidates, {
        "live-e5": live(false),
        "live-e9": live(true, true, "https://example.com/iframe"),
        "live-e13": live(true, true, "https://example.com/other-frame"),
      });
      mockResolveElement.mockResolvedValue({
        backendNodeId: 5, objectId: "obj-e5", role: "button", name: "Speichern", resolvedVia: "ref", resolvedSessionId: "s1",
      });
      const base = sendFn.getMockImplementation()!;
      sendFn.mockImplementation(async (method: string, args?: unknown, sid?: string) => {
        if (method === "DOM.scrollIntoViewIfNeeded") throw new Error("CDP error -32000: Node is detached from document");
        return base(method, args, sid);
      });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Element e5 was replaced by a page re-render");
      // e12 (oopif-1) was never probed: different owner session than the first hit
      const oopifProbes = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "DOM.resolveNode" && c[2] === "oopif-1");
      expect(oopifProbes).toHaveLength(0);
    });

    it("uses the session's main document as context when the first node is already gone", async () => {
      const { cdpClient } = arm(candidates, { "live-e9": live(true, true, PAGE) }, ["e5"]);

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.content[0].text).toBe("Clicked e9 (ref) — e5 was already replaced, took the live match");
    });

    it("rethrows transport/session/timeout errors instead of probing on", async () => {
      const { cdpClient, sendFn } = arm(candidates, {}, [], ["e5"]);

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.");
      const resolves = sendFn.mock.calls.filter((c: unknown[]) => c[0] === "DOM.resolveNode");
      expect(resolves).toHaveLength(1);
    });

    it("does not run the live check for a single candidate", async () => {
      mockFindByText.mockReturnValue({ ref: "e5", backendNodeId: 5 });
      mockFindAllByText.mockReturnValue([candidates[0]]);
      mockResolveElement.mockResolvedValue({
        backendNodeId: 5, objectId: "obj-e5", role: "button", name: "Speichern", resolvedVia: "ref", resolvedSessionId: "s1",
      });
      const { cdpClient, sendFn } = createMockCdp();

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.content[0].text).toBe("Clicked e5 (ref)");
      expect(probeCalls(sendFn)).toHaveLength(0);
      expect(mockResolveRefFull).not.toHaveBeenCalled();
    });

    it("probes at most five candidates (first + four replacements)", async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({ ref: `e${i + 1}`, backendNodeId: i + 1, sessionId: "s1" }));
      const { cdpClient, sendFn } = arm(many, {}); // every probe answers "not connected"
      mockResolveElement.mockResolvedValue({
        backendNodeId: 1, objectId: "obj-e1", role: "button", name: "Speichern", resolvedVia: "ref", resolvedSessionId: "s1",
      });

      await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(probeCalls(sendFn)).toHaveLength(5);
    });

    it("aborts the text click clearly when the fresh tree cannot be read", async () => {
      mockGetTree.mockRejectedValueOnce(new Error("Execution context was destroyed."));
      const { cdpClient } = createMockCdp();

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        'click failed: could not read the page to find text "Speichern" (Execution context was destroyed.). Call view_page and retry.',
      );
      expect(mockFindByText).not.toHaveBeenCalled();
    });

    // Fix round 1: a replacement must share the first hit's match tier and interactive flag.
    const staleClickOnFirst = (sendFn: ReturnType<typeof vi.fn>) => {
      mockResolveElement.mockResolvedValue({
        backendNodeId: 5, objectId: "obj-e5", role: "button", name: "Save", resolvedVia: "ref", resolvedSessionId: "s1",
      });
      const base = sendFn.getMockImplementation()!;
      sendFn.mockImplementation(async (method: string, args?: unknown, sid?: string) => {
        if (method === "DOM.scrollIntoViewIfNeeded") throw new Error("CDP error -32000: Node is detached from document");
        return base(method, args, sid);
      });
    };
    const STALE_E5 = "click failed: Element e5 was replaced by a page re-render (node detached from document). Call view_page for fresh refs and retry.";

    it("never takes a substring match as replacement for a detached exact match", async () => {
      const ranked = [
        { ref: "e5", backendNodeId: 5, sessionId: "s1", tier: 0, interactive: true },  // "Save", detached
        { ref: "e9", backendNodeId: 9, sessionId: "s1", tier: 2, interactive: true },  // "Save draft", live
      ];
      const { cdpClient, sendFn } = arm(ranked, { "live-e5": live(false), "live-e9": live(true) });
      staleClickOnFirst(sendFn);

      const result = await clickHandler({ text: "Save" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(STALE_E5);
      expect(mockResolveElement).not.toHaveBeenCalledWith(cdpClient, "s1", { ref: "e9" }, undefined);
      expect(probeCalls(sendFn)).toHaveLength(0);
      expect(mockFindAllByText).toHaveBeenCalledWith("Save", { withRank: true });
    });

    it("never takes a non-interactive exact match as replacement for a detached interactive one", async () => {
      const ranked = [
        { ref: "e5", backendNodeId: 5, sessionId: "s1", tier: 0, interactive: true },   // button, detached
        { ref: "e9", backendNodeId: 9, sessionId: "s1", tier: 0, interactive: false },  // heading, live
      ];
      const { cdpClient, sendFn } = arm(ranked, { "live-e5": live(false), "live-e9": live(true) });
      staleClickOnFirst(sendFn);

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(STALE_E5);
      expect(probeCalls(sendFn)).toHaveLength(0);
    });

    it("does not probe at all when the other matches sit only in other tiers or groups", async () => {
      const ranked = [
        { ref: "e5", backendNodeId: 5, sessionId: "s1", tier: 0, interactive: true },
        { ref: "e6", backendNodeId: 6, sessionId: "s1", tier: 0, interactive: false },
        { ref: "e7", backendNodeId: 7, sessionId: "s1", tier: 1, interactive: true },
        { ref: "e8", backendNodeId: 8, sessionId: "s1", tier: 2, interactive: true },
      ];
      const { cdpClient, sendFn } = arm(ranked, { "live-e5": live(true) });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.content[0].text).toBe("Clicked e5 (ref)");
      expect(mockResolveRefFull).not.toHaveBeenCalled();
      expect(probeCalls(sendFn)).toHaveLength(0);
    });

    it("still takes a same-tier, same-flag replacement and skips other tiers in between", async () => {
      const ranked = [
        { ref: "e5", backendNodeId: 5, sessionId: "s1", tier: 0, interactive: true },
        { ref: "e7", backendNodeId: 7, sessionId: "s1", tier: 0, interactive: false },
        { ref: "e9", backendNodeId: 9, sessionId: "s1", tier: 0, interactive: true },
        { ref: "e11", backendNodeId: 11, sessionId: "s1", tier: 2, interactive: true },
      ];
      const { cdpClient, sendFn } = arm(ranked, { "live-e5": live(false), "live-e7": live(true), "live-e9": live(true), "live-e11": live(true) });

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.content[0].text).toBe("Clicked e9 (ref) — e5 was already replaced, took the live match");
      expect(probeCalls(sendFn)).toHaveLength(2); // e5 and e9 — e7 (other flag) never probed
    });

    // Fix round 2: in every tier a replacement must carry the first hit's accessible name (case-insensitive).
    it("never takes a differently named partial match as replacement (\"Save as\" for \"Save draft\")", async () => {
      const ranked = [
        { ref: "e5", backendNodeId: 5, sessionId: "s1", tier: 2, interactive: true, name: "Save draft" }, // detached
        { ref: "e9", backendNodeId: 9, sessionId: "s1", tier: 2, interactive: true, name: "Save as" },    // live
      ];
      const { cdpClient, sendFn } = arm(ranked, { "live-e5": live(false), "live-e9": live(true) });
      staleClickOnFirst(sendFn);

      const result = await clickHandler({ text: "Save" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(STALE_E5);
      expect(probeCalls(sendFn)).toHaveLength(0);
    });

    it("takes a partial match with the same name in other case as replacement (\"save draft\" for \"Save draft\")", async () => {
      const ranked = [
        { ref: "e5", backendNodeId: 5, sessionId: "s1", tier: 2, interactive: true, name: "Save draft" }, // detached
        { ref: "e9", backendNodeId: 9, sessionId: "s1", tier: 2, interactive: true, name: "save draft" }, // live
      ];
      const { cdpClient } = arm(ranked, { "live-e5": live(false), "live-e9": live(true) });

      const result = await clickHandler({ text: "Save" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Clicked e9 (ref) — e5 was already replaced, took the live match");
    });

    // Fix round 3: replacements are scanned newest-first; two live namesakes are ambiguous.
    const probedObjectIds = (sendFn: ReturnType<typeof vi.fn>) =>
      probeCalls(sendFn).map((c: unknown[]) => (c[1] as { objectId: string }).objectId);

    it("reaches the live replacement behind six or more stale namesakes (newest-first)", async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({ ref: `e${i + 1}`, backendNodeId: i + 1, sessionId: "s1" }));
      const { cdpClient } = arm(many, { "live-e8": live(true) }); // e1..e7 detached, e8 is the live re-render

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Clicked e8 (ref) — e1 was already replaced, took the live match");
    });

    it("probes the first hit, then the replacements newest-first, capped at five", async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({ ref: `e${i + 1}`, backendNodeId: i + 1, sessionId: "s1" }));
      const { cdpClient, sendFn } = arm(many, {});

      await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(probedObjectIds(sendFn)).toEqual(["live-e1", "live-e8", "live-e7", "live-e6", "live-e5"]);
    });

    it("does not guess when two replacements qualify (e.g. a Delete button per row) and reports the stale hint", async () => {
      const { cdpClient, sendFn } = arm(candidates, { "live-e5": live(false), "live-e9": live(true), "live-e13": live(true) });
      staleClickOnFirst(sendFn);

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(STALE_E5);
      expect(mockResolveElement).toHaveBeenCalledTimes(1);
      expect(mockResolveElement).toHaveBeenCalledWith(cdpClient, "s1", { ref: "e5" }, undefined);
    });

    it("keeps the reconnect message when reading the fresh tree fails on transport loss", async () => {
      mockGetTree.mockRejectedValueOnce(new Error("CdpClient is closed"));
      const { cdpClient } = createMockCdp();

      const result = await clickHandler({ text: "Speichern" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.");
    });
  });

  // --- Story 16.5: humanMouseMove callback delegation ---

  describe("Story 16.5 — humanMouseMove callback", () => {
    it("dispatchClick delegates mouse-move to humanMouseMove callback when provided (ref path)", async () => {
      mockResolveElement.mockResolvedValue({
        backendNodeId: 42,
        objectId: "obj-42",
        role: "button",
        name: "Submit",
        resolvedVia: "ref",
        resolvedSessionId: "s1",
      });
      const { cdpClient, sendFn } = createMockCdp();

      const humanMouseMove = vi.fn().mockResolvedValue(undefined);

      // Pass humanMouseMove via params (cast — it is NOT in the Zod schema)
      const params = {
        ref: "e5",
        humanMouseMove,
      } as unknown as ClickParams;

      const result = await clickHandler(params, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(humanMouseMove).toHaveBeenCalledTimes(1);
      // No raw mouseMoved CDP-call should have been issued
      const mouseMovedCalls = sendFn.mock.calls.filter(
        (c) => c[0] === "Input.dispatchMouseEvent" && (c[1] as { type?: string })?.type === "mouseMoved",
      );
      expect(mouseMovedCalls.length).toBe(0);
      // mousePressed and mouseReleased still issued
      const pressedCalls = sendFn.mock.calls.filter(
        (c) => c[0] === "Input.dispatchMouseEvent" && (c[1] as { type?: string })?.type === "mousePressed",
      );
      expect(pressedCalls.length).toBe(1);
    });

    it("dispatchClick falls back to raw CDP mouseMoved when humanMouseMove is absent", async () => {
      mockResolveElement.mockResolvedValue({
        backendNodeId: 42,
        objectId: "obj-42",
        role: "button",
        name: "Submit",
        resolvedVia: "ref",
        resolvedSessionId: "s1",
      });
      const { cdpClient, sendFn } = createMockCdp();

      const result = await clickHandler({ ref: "e5" } as ClickParams, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      const mouseMovedCalls = sendFn.mock.calls.filter(
        (c) => c[0] === "Input.dispatchMouseEvent" && (c[1] as { type?: string })?.type === "mouseMoved",
      );
      expect(mouseMovedCalls.length).toBe(1);
    });

    // --- Story 20.1 M3: wait_for_diff sets _meta.syncDiff ---

    it("ref-based click with wait_for_diff: true sets _meta.syncDiff", async () => {
      mockResolveElement.mockResolvedValue({
        backendNodeId: 42,
        objectId: "obj-42",
        role: "button",
        name: "Submit",
        resolvedVia: "ref",
        resolvedSessionId: "s1",
      });
      const { cdpClient } = createMockCdp();

      const result = await clickHandler({ ref: "e5", wait_for_diff: true }, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(result._meta?.syncDiff).toBe(true);
    });

    it("ref-based click without wait_for_diff does NOT set _meta.syncDiff", async () => {
      mockResolveElement.mockResolvedValue({
        backendNodeId: 42,
        objectId: "obj-42",
        role: "button",
        name: "Submit",
        resolvedVia: "ref",
        resolvedSessionId: "s1",
      });
      const { cdpClient } = createMockCdp();

      const result = await clickHandler({ ref: "e5" }, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(result._meta?.syncDiff).toBeUndefined();
    });

    it("coordinate-based click delegates to humanMouseMove when provided", async () => {
      const { cdpClient, sendFn } = createMockCdp({
        "Runtime.evaluate": {
          result: { value: { sx: 0, sy: 0, w: 800, h: 600, oob: false } },
        },
      });

      const humanMouseMove = vi.fn().mockResolvedValue(undefined);
      const params = {
        x: 100,
        y: 200,
        humanMouseMove,
      } as unknown as ClickParams;

      const result = await clickHandler(params, cdpClient, "s1");

      expect(result.isError).toBeUndefined();
      expect(humanMouseMove).toHaveBeenCalledTimes(1);
      const mouseMovedCalls = sendFn.mock.calls.filter(
        (c) => c[0] === "Input.dispatchMouseEvent" && (c[1] as { type?: string })?.type === "mouseMoved",
      );
      expect(mouseMovedCalls.length).toBe(0);
    });
  });
});
