/**
 * FR-022 (P3 fix): Tests for the Free-tier default `onToolResult` hook.
 *
 * Covers:
 *  (a) Scope: only `click` + `clickable`/`widget-state` triggers the hook
 *  (b) Happy path: refresh + diff + format -> diff text appended
 *  (c) Settle-Loop: empty first refresh -> retry once with extra wait
 *  (d) Removed-Detection: refs missing from getActiveRefs() get a REMOVED entry
 *  (e) Errors inside the hook never destroy the original tool response
 *  (f) `formatDomDiff` returning null leaves the response untouched
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDefaultOnToolResult } from "./default-on-tool-result.js";
import type { A11yTreePublic, A11yTreeDiffs } from "./pro-hooks.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import type { DOMChange, SnapshotMap } from "../cache/a11y-tree.js";

type MockOptions = {
  /** Snapshot maps returned by getSnapshotMap() — first call is BEFORE, rest AFTER. */
  snapshots?: SnapshotMap[];
  /** Diff results returned by diffSnapshots() per call (one entry per refresh). */
  diffResults?: DOMChange[][];
  /** Sequence of formatDomDiff() return values per call. */
  formatResults?: Array<string | null>;
  /** Active refs reported by getActiveRefs() — controls REMOVED detection. */
  activeRefs?: Set<number>;
  currentUrl?: string;
  /** When true, omit waitForAXChange from the context entirely. */
  omitWaitForAXChange?: boolean;
};

function makeContext(opts: MockOptions = {}) {
  const snapshots = opts.snapshots ?? [new Map(), new Map()];
  const diffResults = opts.diffResults ?? [[]];
  const formatResults = opts.formatResults ?? [null];
  const activeRefs = opts.activeRefs ?? new Set<number>();

  let snapCall = 0;
  const getSnapshotMap = vi.fn(() => {
    const m = snapshots[snapCall] ?? snapshots[snapshots.length - 1];
    snapCall += 1;
    return m;
  });

  let diffCall = 0;
  const diffSnapshots = vi.fn(() => {
    const r = diffResults[diffCall] ?? diffResults[diffResults.length - 1];
    diffCall += 1;
    return r;
  });

  let formatCall = 0;
  const formatDomDiff = vi.fn(() => {
    const r = formatResults[formatCall] ?? formatResults[formatResults.length - 1];
    formatCall += 1;
    return r;
  });

  const a11yTree = {
    classifyRef: vi.fn(),
    getSnapshotMap,
    getCompactSnapshot: vi.fn(),
    refreshPrecomputed: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    currentUrl: opts.currentUrl ?? "https://example.com/page",
    diffSnapshots,
    formatDomDiff,
    getActiveRefs: vi.fn(() => new Set(activeRefs)),
  };

  const cdpClient = {} as unknown as CdpClient;
  const sessionManager = undefined as SessionManager | undefined;
  const waitForAXChange = vi.fn().mockResolvedValue(true);

  const context = {
    a11yTree: a11yTree as unknown as A11yTreePublic,
    a11yTreeDiffs: { diffSnapshots, formatDomDiff } as unknown as A11yTreeDiffs,
    cdpClient,
    sessionId: "sess-1",
    sessionManager,
  } as Parameters<ReturnType<typeof createDefaultOnToolResult>>[2];

  if (!opts.omitWaitForAXChange) {
    context.waitForAXChange = waitForAXChange;
  }

  return { a11yTree, context, waitForAXChange };
}

function makeClickResult(elementClass?: string): ToolResponse {
  return {
    content: [{ type: "text", text: "Clicked e2 (ref)" }],
    _meta: {
      elapsedMs: 1,
      method: "click",
      ...(elementClass !== undefined ? { elementClass } : {}),
    },
  };
}

describe("createDefaultOnToolResult (P3 — default Free-tier hook)", () => {
  beforeEach(() => {
    // Settle-Loop tests pick their own timing — make sure prior runs don't
    // leak the env var.
    delete process.env.SILBERCUE_CHROME_DIFF_RETRY_MS;
    delete process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a function", () => {
    expect(typeof createDefaultOnToolResult()).toBe("function");
  });

  // (a) Scope: non-click tools are passed through untouched
  it("ignores non-click tools", async () => {
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    const result = makeClickResult("clickable");

    const out = await hook("read_page", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(a11yTree.refreshPrecomputed).not.toHaveBeenCalled();
  });

  // (a) Scope: click on static elements is passed through
  it("ignores click on static element", async () => {
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    const result = makeClickResult("static");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
    expect(a11yTree.refreshPrecomputed).not.toHaveBeenCalled();
  });

  // (a) Scope: click on disabled elements is passed through
  it("ignores click on disabled element", async () => {
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    const result = makeClickResult("disabled");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(a11yTree.refreshPrecomputed).not.toHaveBeenCalled();
  });

  // (b) Happy path: clickable element with non-empty diff
  it("appends diff text on click + clickable when refresh produces changes", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree, waitForAXChange } = makeContext({
      snapshots: [
        new Map([[1, "button\0Old"]]),
        new Map([
          [1, "button\0Old"],
          [2, "row\0New row"],
        ]),
      ],
      diffResults: [
        [{ type: "added", ref: "e2", role: "row", after: "New row" }],
      ],
      formatResults: ["--- Action Result (1 changes) ---\n NEW row \"New row\""],
      activeRefs: new Set([1, 2]),
    });
    const result = makeClickResult("clickable");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("NEW row"),
    });
    expect(waitForAXChange).toHaveBeenCalledTimes(0);
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
    expect(a11yTree.getSnapshotMap).toHaveBeenCalledTimes(2);
    expect(a11yTree.diffSnapshots).toHaveBeenCalledTimes(1);
    expect(a11yTree.formatDomDiff).toHaveBeenCalledWith(
      expect.any(Array),
      "https://example.com/page",
    );
  });

  // (b) Happy path: widget-state element triggers the hook too
  it("triggers on widget-state element", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [new Map([[1, "checkbox\0Subscribe"]]), new Map([[1, "checkbox\0Subscribe (checked)"]])],
      diffResults: [
        [{ type: "changed", ref: "e1", role: "checkbox", before: "Subscribe", after: "Subscribe (checked)" }],
      ],
      formatResults: ["--- Action Result (1 changes) ---\n CHANGED checkbox..."],
      activeRefs: new Set([1]),
    });
    const result = makeClickResult("widget-state");

    const out = await hook("click", result, context);

    expect(out.content).toHaveLength(2);
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
  });

  // (c) Settle-Loop: first refresh empty -> retry refresh has changes
  it("retries once with extra wait when first refresh produces empty diff", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "10";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [
        // BEFORE
        new Map([[1, "button\0Open"]]),
        // AFTER (refresh #1 — slow React, empty)
        new Map([[1, "button\0Open"]]),
        // AFTER (refresh #2 — settle-loop catches the late re-render)
        new Map([
          [1, "button\0Open"],
          [2, "row\0Late row"],
        ]),
      ],
      diffResults: [
        [], // first refresh: nothing
        [{ type: "added", ref: "e2", role: "row", after: "Late row" }],
      ],
      formatResults: [
        null, // formatDomDiff returns null on empty changes (real behavior)
        "--- Action Result (1 changes) ---\n NEW row \"Late row\"",
      ],
      activeRefs: new Set([1, 2]),
    });
    const result = makeClickResult("clickable");

    const out = await hook("click", result, context);

    expect(out.content).toHaveLength(2);
    expect(out.content[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Late row"),
    });
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(2);
    expect(a11yTree.diffSnapshots).toHaveBeenCalledTimes(2);
  });

  it("does not retry when SILBERCUE_CHROME_DIFF_RETRY_MS=0", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      snapshots: [new Map(), new Map()],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });
    const result = makeClickResult("clickable");

    await hook("click", result, context);

    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
    expect(a11yTree.diffSnapshots).toHaveBeenCalledTimes(1);
  });

  // (d) Removed-Detection: ref dropped from getActiveRefs becomes REMOVED entry
  it("synthesizes REMOVED entries for refs missing from getActiveRefs()", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const formatDomDiffSpy = vi.fn(
      (changes: DOMChange[]) => `--- ${changes.length} changes ---`,
    );
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([
          [1, "button\0Save"],
          [5, "dialog\0Confirm dialog"],
        ]),
        // After refresh: dialog is gone from reverseMap NEVER, but its ref is
        // not in activeRefs anymore — that's the live signal.
        new Map([
          [1, "button\0Save"],
          [5, "dialog\0Confirm dialog"], // stale entry still here
          [9, "row\0New row"],
        ]),
      ],
      // diffSnapshots only catches the added row — reverseMap still has the
      // stale dialog, so it never reports removal on its own.
      diffResults: [
        [{ type: "added", ref: "e9", role: "row", after: "New row" }],
      ],
      // The hook will call formatDomDiff with both the added row AND a
      // synthesized REMOVED entry for ref 5.
      formatResults: ["mock"],
      activeRefs: new Set([1, 9]), // ref 5 is GONE
    });
    a11yTree.formatDomDiff = formatDomDiffSpy as unknown as typeof a11yTree.formatDomDiff;
    const result = makeClickResult("clickable");

    await hook("click", result, context);

    // formatDomDiff should have been called with 2 changes:
    //   1. the added row (from diffSnapshots)
    //   2. the synthesized removed dialog (ref 5 is no longer active)
    expect(formatDomDiffSpy).toHaveBeenCalledTimes(1);
    const passedChanges = formatDomDiffSpy.mock.calls[0][0] as DOMChange[];
    expect(passedChanges).toHaveLength(2);
    expect(passedChanges).toContainEqual(
      expect.objectContaining({ type: "added", ref: "e9" }),
    );
    expect(passedChanges).toContainEqual(
      expect.objectContaining({
        type: "removed",
        ref: "e5",
        role: "dialog",
        before: "Confirm dialog",
      }),
    );
  });

  it("does not double-report REMOVED for refs already in diffSnapshots output", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const formatDomDiffSpy = vi.fn(() => "mock");
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([[5, "dialog\0X"]]),
        new Map([[5, "dialog\0X"]]),
      ],
      // diffSnapshots already reported ref 5 as removed
      diffResults: [
        [{ type: "removed", ref: "e5", role: "dialog", before: "X", after: "" }],
      ],
      formatResults: ["mock"],
      activeRefs: new Set(), // ref 5 not active either
    });
    a11yTree.formatDomDiff = formatDomDiffSpy as unknown as typeof a11yTree.formatDomDiff;
    const result = makeClickResult("clickable");

    await hook("click", result, context);

    const passedChanges = formatDomDiffSpy.mock.calls[0][0] as DOMChange[];
    // Exactly one removed entry — no duplicate
    const removed = passedChanges.filter((c) => c.type === "removed");
    expect(removed).toHaveLength(1);
  });

  it("skips REMOVED synthesis when getActiveRefs() returns empty (no refresh yet)", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const formatDomDiffSpy = vi.fn(() => "mock");
    const { context, a11yTree } = makeContext({
      snapshots: [
        new Map([[5, "dialog\0X"]]),
        new Map([[5, "dialog\0X"]]),
      ],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(), // empty -> "no refresh has run yet" semantics
    });
    a11yTree.formatDomDiff = formatDomDiffSpy as unknown as typeof a11yTree.formatDomDiff;
    const result = makeClickResult("clickable");

    await hook("click", result, context);

    // No changes -> formatDomDiff never gets called (well, it might be —
    // but the test checks that no REMOVED entries get fabricated)
    if (formatDomDiffSpy.mock.calls.length > 0) {
      const passedChanges = formatDomDiffSpy.mock.calls[0][0] as DOMChange[];
      expect(passedChanges).toHaveLength(0);
    }
  });

  // (e) Belt-and-braces: hook errors must not destroy the response
  it("returns the original result unchanged when refreshPrecomputed throws", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext();
    a11yTree.refreshPrecomputed = vi
      .fn()
      .mockRejectedValue(new Error("CDP boom")) as unknown as typeof a11yTree.refreshPrecomputed;
    const result = makeClickResult("clickable");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1); // unchanged
    expect(out.content[0]).toMatchObject({ text: "Clicked e2 (ref)" });
  });

  // (f) formatDomDiff returns null -> response untouched
  it("does not append text when formatDomDiff returns null", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "0";
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context } = makeContext({
      snapshots: [new Map(), new Map()],
      diffResults: [[]],
      formatResults: [null],
      activeRefs: new Set(),
    });
    const result = makeClickResult("clickable");

    const out = await hook("click", result, context);

    expect(out).toBe(result);
    expect(out.content).toHaveLength(1);
  });

  // waitForAXChange undefined: hook still works (defensive optional chaining)
  it("runs without crash when waitForAXChange is missing from the context", async () => {
    process.env.SILBERCUE_CHROME_DIFF_SETTLE_MS = "1"; // non-zero so the call is attempted
    process.env.SILBERCUE_CHROME_DIFF_RETRY_MS = "0";
    const hook = createDefaultOnToolResult();
    const { context, a11yTree } = makeContext({
      omitWaitForAXChange: true,
      snapshots: [new Map(), new Map([[1, "row\0Inserted"]])],
      diffResults: [[{ type: "added", ref: "e1", role: "row", after: "Inserted" }]],
      formatResults: ["mock diff"],
      activeRefs: new Set([1]),
    });
    const result = makeClickResult("clickable");

    const out = await hook("click", result, context);

    expect(out.content).toHaveLength(2);
    expect(a11yTree.refreshPrecomputed).toHaveBeenCalledTimes(1);
  });
});
