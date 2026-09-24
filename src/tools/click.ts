import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { resolveElement, buildRefNotFoundError, RefNotFoundError } from "./element-utils.js";
import type { ResolvedElement } from "./element-utils.js";
import { formatElementLabel } from "./element-label.js";
import { wrapCdpError, isDetachedNodeError, isFatalCdpError } from "./error-utils.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { isHeadless } from "../cdp/emulation.js";
import { toolSequence } from "../telemetry/tool-sequence.js";

// --- Schema (Task 2) ---

export const clickSchema = z.object({
  ref: z
    .string()
    .optional()
    .describe("Element ref (preferred)"),
  selector: z
    .string()
    .optional()
    .describe("CSS selector (fallback)"),
  text: z
    .string()
    .optional()
    .describe("Visible text (a11y name); no view_page needed, prefers interactive"),
  x: z
    .number()
    .optional()
    .describe("Viewport X in px; with y, not ref/selector"),
  y: z
    .number()
    .optional()
    .describe("Viewport Y in px; use with x"),
  wait_for_diff: z
    .boolean()
    .optional()
    .describe("Wait for the DOM diff before returning (default false, slower)"),
});

export type ClickParams = z.infer<typeof clickSchema>;

// --- Click dispatch (Task 4) ---

export type ClickMethod = "cdp" | "js-rect" | "js-click" | "coordinates";

/**
 * Story 16.5: Optional human-mouse-move callback injected via the
 * `enhanceTool` Pro-Hook. When present, this replaces the raw
 * `Input.dispatchMouseEvent("mouseMoved",...)` with a Bezier-curve mouse
 * movement from the Human Touch module (registered via hook system).
 * The core repo does NOT contain any Human-Touch logic — it only
 * knows how to delegate.
 */
export type HumanMouseMoveFn = (
  cdpClient: CdpClient,
  sessionId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) => Promise<void>;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

interface ClickResult { method: ClickMethod; x: number; y: number }

async function dispatchClick(
  cdpClient: CdpClient,
  sessionId: string,
  backendNodeId: number,
  objectId: string,
  humanMouseMove?: HumanMouseMoveFn,
): Promise<ClickResult> {
  // Step 1: Reset scroll to origin before clicking.
  // When Emulation.setDeviceMetricsOverride is active, Input.dispatchMouseEvent
  // hit-tests at document coordinates (viewport + scrollY) instead of viewport
  // coordinates. Scrolling to 0 ensures viewport coords = document coords.
  await cdpClient.send(
    "Runtime.evaluate",
    { expression: "window.scrollTo(0,0)" },
    sessionId,
  );

  // Step 2: Scroll element into view (from scroll 0)
  await cdpClient.send(
    "DOM.scrollIntoViewIfNeeded",
    { backendNodeId },
    sessionId,
  );

  // Step 3: Get viewport-relative center — try getContentQuads, fallback chain
  let x: number;
  let y: number;
  let clickMethod: ClickMethod = "cdp";

  try {
    const quadsResult = await cdpClient.send<{ quads: number[][] }>(
      "DOM.getContentQuads",
      { backendNodeId },
      sessionId,
    );
    if (!quadsResult.quads || quadsResult.quads.length === 0) {
      throw new Error("Element has no visible layout quads");
    }
    // Quad is [x1,y1, x2,y2, x3,y3, x4,y4] — average all 4 corners for center
    const q = quadsResult.quads[0];
    x = (q[0] + q[2] + q[4] + q[6]) / 4;
    y = (q[1] + q[3] + q[5] + q[7]) / 4;
  } catch (quadsErr) {
    // FR-051: a detached node must not fall through to the rect fallback —
    // getBoundingClientRect() of a detached element is 0/0/0/0, which used
    // to become a real mouse click at (0,0).
    if (isDetachedNodeError(quadsErr)) throw quadsErr;

    // Fallback 1: getBoundingClientRect via Runtime.callFunctionOn
    // Handles Shadow-DOM nodes and post-mutation stale layouts (BUG-005, BUG-007, BUG-012)
    try {
      const rectResult = await cdpClient.send<{
        result: { value: { x: number; y: number; w?: number; h?: number; connected?: boolean } };
      }>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: `function() {
            var rect = this.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height, connected: this.isConnected };
          }`,
          objectId,
          returnByValue: true,
        },
        sessionId,
      );
      const box = rectResult.result.value;
      // FR-051: the element left the document between scroll and here.
      if (box.connected === false) throw new Error("Node is detached from document");
      // A connected element without a box cannot be hit by coordinates —
      // the click would land on whatever is at that point. Use the JS click.
      if (box.w === 0 && box.h === 0) throw new Error("Element has no layout box");
      x = box.x;
      y = box.y;
      clickMethod = "js-rect";
    } catch (rectErr) {
      if (isDetachedNodeError(rectErr)) throw rectErr;
      // Fallback 2: Pure JS click — no coordinates needed
      await cdpClient.send(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: `function() { this.click(); }`,
          objectId,
          returnByValue: false,
        },
        sessionId,
      );
      return { method: "js-click" as ClickMethod, x: 0, y: 0 };
    }
  }

  // Step 4: Dispatch mouse events — mouseMoved → mousePressed → mouseReleased
  // mouseMoved establishes mouseenter/mouseover context (BUG-002)
  // Story 16.5: If humanMouseMove callback is injected (via Pro-Hook),
  // delegate the mouse-move sequence to it. Otherwise: raw CDP dispatch.
  if (humanMouseMove) {
    await humanMouseMove(cdpClient, sessionId, 0, 0, x, y);
  } else {
    await cdpClient.send(
      "Input.dispatchMouseEvent",
      { type: "mouseMoved", x, y, button: "none", buttons: 0 },
      sessionId,
    );
  }
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
    sessionId,
  );
  await cdpClient.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
    sessionId,
  );

  return { method: clickMethod, x, y };
}

/**
 * S3: `[e12] button "Save"` — what the click is about to hit. The ref path and
 * selector hits the a11y tree knows carry role and name already; any other
 * element is asked once for tag and visible text, before the click (it may be
 * gone afterwards).
 */
async function describeClickTarget(
  cdpClient: CdpClient,
  element: ResolvedElement,
  ref: string | undefined,
): Promise<string> {
  if (element.role) return formatElementLabel(ref, element.role, element.name);
  try {
    const probe = await cdpClient.send<{ result?: { value?: { tag?: string; text?: string } } }>(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function() {
          var label = (this.getAttribute && (this.getAttribute("aria-label") || this.getAttribute("title"))) || this.innerText || this.value || "";
          return { tag: this.localName || "", text: String(label).replace(/\\s+/g, " ").trim().slice(0, 80) };
        }`,
        objectId: element.objectId,
        returnByValue: true,
      },
      element.resolvedSessionId,
    );
    return formatElementLabel(ref, probe?.result?.value?.tag ?? "", probe?.result?.value?.text ?? "");
  } catch (err) {
    if (isFatalCdpError(err)) throw err;
    return formatElementLabel(ref, "", "");
  }
}

// --- Main handler (Task 6) ---

/** FR-050: how many candidates click(text) probes live (first hit + replacements) before giving up. */
const MAX_LIVE_PROBES = 5;

interface LiveProbe {
  connected: boolean;
  visible: boolean;
  docUrl: string;
}

/**
 * FR-050: ask the browser about one candidate. Returns null when the node is
 * gone (DOM.resolveNode rejects with a node error). Transport, session and
 * timeout errors are rethrown — probing on would only multiply them.
 */
async function probeCandidate(
  cdpClient: CdpClient,
  owner: { backendNodeId: number; sessionId: string },
): Promise<LiveProbe | null> {
  try {
    await cdpClient.send("DOM.getDocument", { depth: 0 }, owner.sessionId); // ensures DOM domain, idempotent
    const resolved = await cdpClient.send<{ object: { objectId: string } }>(
      "DOM.resolveNode",
      { backendNodeId: owner.backendNodeId },
      owner.sessionId,
    );
    const probe = await cdpClient.send<{ result?: { value?: LiveProbe } }>(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function() {
          var r = this.getBoundingClientRect ? this.getBoundingClientRect() : { width: 0, height: 0 };
          return {
            connected: this.isConnected === true,
            visible: r.width > 0 && r.height > 0,
            docUrl: (this.ownerDocument && this.ownerDocument.URL) || ""
          };
        }`,
        objectId: resolved.object.objectId,
        returnByValue: true,
      },
      owner.sessionId,
    );
    const value = probe?.result?.value;
    return value && typeof value.connected === "boolean" ? value : null;
  } catch (err) {
    if (isFatalCdpError(err)) throw err;
    return null;
  }
}

/**
 * FR-050: Refs stay stable per backendNodeId on the same URL, so after an SPA
 * re-render findByText's first hit may be the old, detached node while its
 * replacement sits further down the list under the same name. If the first
 * hit is still connected (visible or not) nothing changes. Otherwise look
 * for a replacement that is connected, has a visible layout box, belongs to
 * the same owner session and lives in the same document as the first hit
 * (its document while it still exists, else the session's main document).
 * Candidates are scanned newest ref first: every re-render the server sees
 * leaves one more stale namesake behind, and the live node is the latest one.
 * Returns undefined when no replacement or more than one qualifies (e.g. a
 * "Delete" button per row — no guessing) — the caller proceeds exactly as
 * before and reports the FR-051 stale hint.
 */
async function pickLiveReplacement(
  cdpClient: CdpClient,
  candidates: Array<{ ref: string; backendNodeId: number; sessionId: string }>,
): Promise<{ ref: string } | undefined> {
  const first = candidates[0];
  const firstOwner = a11yTree.resolveRefFull(first.ref);
  if (!firstOwner) return undefined;

  const firstProbe = await probeCandidate(cdpClient, firstOwner);
  if (firstProbe?.connected) return undefined; // still in the DOM — today's behaviour

  let contextUrl = firstProbe?.docUrl ?? "";
  if (!contextUrl) {
    try {
      const doc = await cdpClient.send<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: "document.URL", returnByValue: true },
        firstOwner.sessionId,
      );
      contextUrl = doc.result.value;
    } catch (err) {
      if (isFatalCdpError(err)) throw err;
      return undefined;
    }
  }

  const newestFirst = candidates
    .slice(1)
    .filter((cand) => cand.sessionId === first.sessionId)
    .sort((a, b) => Number(b.ref.slice(1)) - Number(a.ref.slice(1)));
  let probes = 1; // the first hit
  let match: { ref: string } | undefined;
  for (const cand of newestFirst) {
    if (probes >= MAX_LIVE_PROBES) break;
    const owner = a11yTree.resolveRefFull(cand.ref);
    if (!owner) continue;
    probes++;
    const probe = await probeCandidate(cdpClient, owner);
    if (probe && probe.connected && probe.visible && probe.docUrl === contextUrl) {
      if (match) return undefined; // two live namesakes — ambiguous
      match = { ref: cand.ref };
    }
  }
  return match;
}

export async function clickHandler(
  params: ClickParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();

  // Story 16.5: Extract optional humanMouseMove callback injected by the
  // `enhanceTool` Pro-Hook. The field is NOT part of the Zod schema — it is
  // read from the raw params map via type-guard and stripped from the params
  // object before downstream code uses it (so it never leaks into CDP calls
  // or schema-validation paths).
  const rawParams = params as unknown as Record<string, unknown>;
  const maybeHuman = rawParams.humanMouseMove;
  const humanMouseMove: HumanMouseMoveFn | undefined =
    typeof maybeHuman === "function" ? (maybeHuman as HumanMouseMoveFn) : undefined;
  if ("humanMouseMove" in rawParams) {
    const { humanMouseMove: _humanMouseMove, ...rest } = rawParams;
    void _humanMouseMove;
    params = rest as unknown as ClickParams;
  }

  // FR-D: Coordinate-based click — skip element resolution entirely
  if (params.x !== undefined && params.y !== undefined) {
    try {
      const x = params.x;
      const y = params.y;

      // Snapshot tab count before click (FR-E: new tab detection)
      let beforeTabIds: Set<string> | undefined;
      try {
        const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
        beforeTabIds = new Set(targetInfos.filter(t => t.type === "page").map(t => t.targetId));
      } catch { /* non-critical */ }

      // FR-01: Auto-scroll + headless adjustment in a single atomic evaluate.
      // If coordinates exceed viewport dimensions, the LLM passed document/page
      // coordinates (e.g. from a full_page screenshot). Scroll to center the target,
      // then return the final scroll position for coordinate adjustment.
      const snap = await cdpClient.send<{ result: { value: { sx: number; sy: number; w: number; h: number; oob: boolean } } }>(
        "Runtime.evaluate",
        {
          expression: `((x,y)=>{const w=window.innerWidth,h=window.innerHeight,oob=x<0||y<0||x>=w||y>=h;if(oob)window.scrollTo(Math.max(0,x-Math.round(w/2)),Math.max(0,y-Math.round(h/2)));return{sx:Math.round(window.scrollX),sy:Math.round(window.scrollY),w,h,oob}})(${x},${y})`,
          returnByValue: true,
        },
        sessionId,
      );
      const { sx, sy, w: vw, h: vh, oob: autoScrolled } = snap.result.value;

      // Viewport-relative coordinates (subtract scroll offset applied by auto-scroll)
      const viewportX = autoScrolled ? x - sx : x;
      const viewportY = autoScrolled ? y - sy : y;

      // FR-01 fallback: if viewport coords are still out of bounds after scroll
      // (page shorter than expected, overflow:hidden, etc.), warn immediately.
      if (autoScrolled && (viewportX < 0 || viewportY < 0 || viewportX >= vw || viewportY >= vh)) {
        const elapsedMs = Math.round(performance.now() - start);
        return {
          content: [{ type: "text", text: `click at (${x}, ${y}) failed: coordinates are outside page bounds (page scrolled to ${sy}px but target is at ${y}px). The page may be shorter than expected — use view_page or capture_image to verify element positions.` }],
          isError: true,
          _meta: { elapsedMs, method: "click", clickMethod: "coordinates" as ClickMethod, autoScrolled },
        };
      }

      // FR-H: Headless mode — Emulation.setDeviceMetricsOverride causes hit-testing
      // at document coords, so add scroll offset to convert viewport → document space.
      let dispatchX = viewportX;
      let dispatchY = viewportY;
      if (isHeadless()) {
        dispatchX += sx;
        dispatchY += sy;
      }

      // Dispatch mouse events at coordinates via CDP
      // Story 16.5: If humanMouseMove callback is injected, delegate the move.
      if (humanMouseMove) {
        await humanMouseMove(cdpClient, sessionId!, 0, 0, dispatchX, dispatchY);
      } else {
        await cdpClient.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: dispatchX, y: dispatchY, button: "none", buttons: 0 }, sessionId);
      }
      await cdpClient.send("Input.dispatchMouseEvent", { type: "mousePressed", x: dispatchX, y: dispatchY, button: "left", buttons: 1, clickCount: 1 }, sessionId);
      await cdpClient.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: dispatchX, y: dispatchY, button: "left", buttons: 0, clickCount: 1 }, sessionId);

      // FR-E: Check for new tabs after click
      const newTabHint = await detectNewTab(cdpClient, beforeTabIds);

      const elapsedMs = Math.round(performance.now() - start);
      const scrollHint = autoScrolled ? ` (auto-scrolled from page position)` : "";
      return {
        content: [{ type: "text", text: `Clicked at (${x}, ${y})${scrollHint}${newTabHint}` }],
        _meta: { elapsedMs, method: "click", clickMethod: "coordinates" as ClickMethod, autoScrolled },
      };
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - start);
      return {
        content: [{ type: "text", text: wrapCdpError(err, "click", `(${params.x}, ${params.y})`) }],
        isError: true,
        _meta: { elapsedMs, method: "click" },
      };
    }
  }

  let liveMatchFrom: string | undefined;

  // UX-001: Resolve text to ref before validation
  if (params.text && !params.ref && !params.selector) {
    // FR-046: Always fetch fresh a11y tree — previous refs may be stale after DOM mutations (e.g. type → restructure)
    // FR-050: a failed fetch is reported, not swallowed — searching the old cache can only yield a stale click.
    try {
      await a11yTree.getTree(cdpClient, sessionId!, { depth: 3, filter: "interactive", fresh: true }, sessionManager);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text = isFatalCdpError(err)
        ? wrapCdpError(err, "click")
        : `click failed: could not read the page to find text "${params.text}" (${message}). Call view_page and retry.`;
      return {
        content: [{ type: "text", text }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "click" },
      };
    }
    const match = a11yTree.findByText(params.text);
    if (match) {
      params.ref = match.ref;
      // FR-050: with several same-name hits the first may be a node the page
      // has already replaced — take a connected, visible replacement in the
      // same context, if there is one. Only true namesakes qualify: same match
      // tier, same interactive flag and the same accessible name (ignoring
      // case) as the first hit ("Save draft" never stands in for "Save" or
      // "Save as", a heading never for a button).
      const all = a11yTree.findAllByText(params.text, { withRank: true });
      const firstName = all[0]?.name?.toLowerCase();
      const namesakes = all.filter(
        (c) => c.tier === all[0]?.tier
          && c.interactive === all[0]?.interactive
          && c.name?.toLowerCase() === firstName,
      );
      if (namesakes.length > 1) {
        try {
          const live = await pickLiveReplacement(cdpClient, namesakes);
          if (live && live.ref !== match.ref) {
            liveMatchFrom = match.ref;
            params.ref = live.ref;
          }
        } catch (err) {
          return {
            content: [{ type: "text", text: wrapCdpError(err, "click", match.ref) }],
            isError: true,
            _meta: { elapsedMs: Math.round(performance.now() - start), method: "click" },
          };
        }
      }
    } else {
      const elements = a11yTree.getInteractiveElements(8);
      const hint = elements.length > 0
        ? "\nAvailable interactive elements:\n  " + elements.join("\n  ")
        : "\nNo interactive elements found — try view_page first.";
      return {
        content: [{ type: "text", text: `No element found with text "${params.text}".${hint}` }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "click" },
      };
    }
  }

  // Validation (Task 2.4)
  if (!params.ref && !params.selector) {
    return {
      content: [
        {
          type: "text",
          text: "click requires either 'ref' (e.g. 'e5'), 'selector' (e.g. '#submit-btn'), 'text' (e.g. 'Submit'), or coordinates (x + y)",
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "click" },
    };
  }

  try {
    // FR-E: Snapshot tab count before click (new tab detection)
    let beforeTabIds: Set<string> | undefined;
    try {
      const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      beforeTabIds = new Set(targetInfos.filter(t => t.type === "page").map(t => t.targetId));
    } catch { /* non-critical */ }

    // Resolve element via shared utility (with OOPIF routing)
    const target = params.ref ? { ref: params.ref } : { selector: params.selector };
    const element = await resolveElement(cdpClient, sessionId!, target, sessionManager);

    // S3: name the target before the click — the click may remove it.
    const label = await describeClickTarget(cdpClient, element, params.ref ?? element.ref);

    // Dispatch click using the resolved session (may be OOPIF or main)
    const clickResult = await dispatchClick(
      cdpClient, element.resolvedSessionId, element.backendNodeId, element.objectId, humanMouseMove,
    );

    // FR-E: Check for new tabs after click
    const newTabHint = await detectNewTab(cdpClient, beforeTabIds);

    // Story 13a.2: Classify clicked element for ambient context decision.
    //
    // Story 18.6 review-fix M2: When the caller used a CSS selector (not a
    // ref), we do NOT know the element's a11y-tree classification — the
    // selector may target a non-interactive span/div that happens to have
    // a click handler. The old code pauschal assigned "clickable" which
    // caused the FR-029 AJAX-race hint to fire on arbitrary selector
    // clicks, including legitimate no-op clicks on static elements.
    //
    // New behaviour: selector-path clicks get the distinct class
    // `"selector-click"`. The FR-029 hint trigger in `registry.ts`
    // explicitly allow-lists `"clickable"` and `"widget-state"` only,
    // so selector clicks never fire the hint — we have no proof that
    // the target was interactive.
    const elementClass = params.ref ? a11yTree.classifyRef(params.ref) : "selector-click";

    const elapsedMs = Math.round(performance.now() - start);
    const suffix = clickResult.method !== "cdp" ? `, fallback: ${clickResult.method}` : "";

    // BUG-018: Anti-Spiral telemetry — successful click resets the
    // per-session evaluate-streak.
    toolSequence.record("click", undefined, sessionId);

    return {
      content: [
        {
          type: "text",
          text: `Clicked ${label} (${element.resolvedVia}${suffix})${liveMatchFrom ? ` — ${liveMatchFrom} was already replaced, took the live match` : ""}${newTabHint}`,
        },
      ],
      _meta: {
        elapsedMs,
        method: "click",
        resolvedVia: element.resolvedVia,
        clickMethod: clickResult.method,
        clickX: clickResult.x,
        clickY: clickResult.y,
        elementClass,
        ...(liveMatchFrom ? { liveMatchFrom } : {}),
        // Story 20.1: When wait_for_diff is true, signal the onToolResult
        // hook to run the diff synchronously (pre-20.1 behaviour).
        ...(params.wait_for_diff ? { syncDiff: true } : {}),
      },
    };
  } catch (err) {
    if (err instanceof RefNotFoundError && params.ref) {
      const errorText = buildRefNotFoundError(params.ref);
      return {
        content: [{ type: "text", text: errorText }],
        isError: true,
        _meta: { elapsedMs: 0, method: "click" },
      };
    }
    const elapsedMs = Math.round(performance.now() - start);
    const elementHint = params.ref ?? params.selector;
    let errorText = wrapCdpError(err, "click", elementHint);

    // FR-008: When CSS selector not found, suggest available interactive elements
    const message = err instanceof Error ? err.message : String(err);
    if (params.selector && message.includes("Element not found for selector")) {
      const elements = a11yTree.getInteractiveElements(8);
      if (elements.length > 0) {
        errorText += "\nAvailable interactive elements:\n  " + elements.join("\n  ");
      }
    }

    return {
      content: [{ type: "text", text: errorText }],
      isError: true,
      _meta: { elapsedMs, method: "click" },
    };
  }
}

// --- FR-E: New tab detection ---

/** S4: how long a click waits for a freshly opened tab to report its title. */
const NEW_TAB_TITLE_WAIT_MS = 1_000;
const NEW_TAB_TITLE_POLL_MS = 100;

/** S4: until the page sets a <title>, Chrome reports its URL (with or without scheme) as title. */
function hasPageTitle(tab: TargetInfo): boolean {
  const bare = (text: string): string => text.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/$/, "");
  const title = (tab.title ?? "").trim();
  return title !== "" && title !== "about:blank" && bare(title) !== bare(tab.url ?? "");
}

async function detectNewTab(
  cdpClient: CdpClient,
  beforeTabIds?: Set<string>,
): Promise<string> {
  if (!beforeTabIds) return "";
  try {
    const { targetInfos } = await cdpClient.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    const newTabs = targetInfos.filter(t => t.type === "page" && !beforeTabIds.has(t.targetId));
    if (newTabs.length > 0) {
      // S4: the ID is what switch_tab needs; the title is for orientation, so
      // it gets a short wait (the new page is usually still loading).
      let tab = newTabs[0];
      const deadline = Date.now() + NEW_TAB_TITLE_WAIT_MS;
      while (!hasPageTitle(tab) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, NEW_TAB_TITLE_POLL_MS));
        try {
          const { targetInfo } = await cdpClient.send<{ targetInfo: TargetInfo }>(
            "Target.getTargetInfo",
            { targetId: tab.targetId },
          );
          tab = targetInfo;
        } catch {
          break; // tab closed again or not inspectable — report what we have
        }
      }
      const title = hasPageTitle(tab) ? ` "${tab.title.trim()}"` : "";
      return `\n⮕ New tab opened: ${tab.targetId}${title} (${tab.url || "about:blank"}) — switch_tab with this ID to use it`;
    }
  } catch { /* non-critical */ }
  return "";
}
