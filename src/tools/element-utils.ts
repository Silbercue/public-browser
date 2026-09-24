import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";
import type { RefTabOwner } from "../cache/a11y-tree.js";
import { inScriptTab } from "../cache/a11y-tree.js";
import { selectorCache } from "../cache/selector-cache.js";
import { wrapCdpError, isFatalCdpError } from "./error-utils.js";
import { formatElementLabel } from "./element-label.js";
import { debug } from "../cdp/debug.js";

// --- Public Types ---

export interface ResolvedElement {
  backendNodeId: number;
  objectId: string;
  role: string;
  name: string;
  /** S3: the element's view_page ref, if it has one (always set on the ref path). */
  ref?: string;
  resolvedVia: "ref" | "css";
  resolvedSessionId: string;
}

export interface ElementTarget {
  ref?: string;
  selector?: string;
}

// --- Ref error messages (B1 / S3) ---

/** B1: The node behind a known ref is gone. Never guess a neighbour — the model re-reads. */
export function staleRefMessage(ref: string): string {
  return `Element ${ref} is a stale ref: its node no longer exists (page re-rendered or navigated). Call view_page for fresh refs and retry.`;
}

/** B1: The ref was issued in another tab; that tab's table still holds it. */
export function foreignTabRefMessage(ref: string, owner: RefTabOwner): string {
  const where = owner.url ? ` (${owner.url})` : "";
  return `Element ${ref} belongs to tab ${owner.targetId}${where}, not to the active tab. switch_tab to that tab first, or call view_page for refs of this tab.`;
}

// --- Strict selectors (S3) ---

/** S3: how many candidates an ambiguous selector error lists. */
const MAX_SELECTOR_CANDIDATES = 5;

/**
 * S3: A CSS selector matched more than one element, so nothing was done.
 * Deliberately not a RefNotFoundError — tools report it via wrapCdpError
 * as "<tool> failed: Selector … matches N elements …".
 */
export class AmbiguousSelectorError extends Error {
  constructor(selector: string, count: number, candidates: string[]) {
    const more = count > candidates.length ? `\n  … ${count - candidates.length} more` : "";
    super(
      `Selector '${selector}' matches ${count} elements, so nothing was done. ` +
      `Use a ref or a more specific selector. Candidates:\n  ${candidates.join("\n  ")}${more}`,
    );
    this.name = "AmbiguousSelectorError";
  }
}

/** S3: `[e12] button "Save"` for a candidate; tag, id and label when the a11y tree does not know it. */
async function describeCandidate(cdpClient: CdpClient, sessionId: string, nodeId: number): Promise<string> {
  try {
    const { node } = await cdpClient.send<{
      node: { backendNodeId: number; localName?: string; attributes?: string[] };
    }>("DOM.describeNode", { nodeId }, sessionId);
    const attrs = node.attributes ?? [];
    const attr = (name: string): string | undefined => {
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === name) return attrs[i + 1];
      }
      return undefined;
    };
    const info = a11yTree.getNodeInfo(node.backendNodeId, sessionId);
    const id = attr("id");
    const role = info?.role || `${node.localName || "element"}${id ? `#${id}` : ""}`;
    const name = info?.name || attr("aria-label") || attr("title") || attr("placeholder") || attr("value") || "";
    return formatElementLabel(a11yTree.getRefForBackendNodeId(node.backendNodeId, sessionId), role, name);
  } catch {
    return `(node ${nodeId} could not be described)`;
  }
}

/**
 * B6: true only when the node is known to hang outside its document — a
 * re-render removed it, but it is still alive, so DOM.resolveNode found it.
 * Acting on it would focus nothing and type into whatever had focus.
 * When the probe itself fails (context gone), the action reports that.
 */
async function isDetached(cdpClient: CdpClient, objectId: string, sessionId: string): Promise<boolean> {
  try {
    const probe = await cdpClient.send<{ result?: { value?: unknown } }>(
      "Runtime.callFunctionOn",
      { functionDeclaration: "function() { return this.isConnected; }", objectId, returnByValue: true },
      sessionId,
    );
    return probe?.result?.value === false;
  } catch (err) {
    if (isFatalCdpError(err)) throw err;
    return false;
  }
}

// --- Element Resolution ---

/**
 * Resolve an element target (ref or CSS selector) to a ResolvedElement.
 * When both ref and selector are given, ref takes priority.
 * Throws RefNotFoundError when a ref cannot be resolved.
 * When sessionManager is provided, routes to the correct OOPIF session.
 */
export async function resolveElement(
  cdpClient: CdpClient,
  sessionId: string,
  target: ElementTarget,
  sessionManager?: SessionManager,
): Promise<ResolvedElement> {
  // Ref path (preferred)
  if (target.ref) {
    // P21: a ref belongs to the document it was assigned in. If the page's main
    // document changed since (link click, redirect — no navigate call reset
    // the table), its backendNodeId may name another node after a renderer
    // swap: stale, never a silent hit. One Page.getFrameTree per resolution.
    if (a11yTree.resolveRefFull(target.ref) && !(await a11yTree.isCurrentDocument(cdpClient, sessionId))) {
      throw new RefNotFoundError(staleRefMessage(target.ref));
    }

    // --- Selector-Cache Check (Story 7.5) ---
    // P5: The cache is keyed by the ref text alone and belongs to the MCP
    // table. A Script-API tab numbers refs in its own table ("e5" there is
    // another node), so it neither reads nor writes the cache.
    const cached = inScriptTab() ? undefined : selectorCache.get(target.ref);
    if (cached) {
      // M1 fix: Verify cached sessionId still matches current session
      const currentSessionForNode = sessionManager?.getSessionForNode(cached.backendNodeId) ?? sessionId;
      const sessionMatch = cached.sessionId === currentSessionForNode;
      if (!sessionMatch) {
        debug("SelectorCache: session mismatch for %s (cached=%s, current=%s), treating as miss", target.ref, cached.sessionId, currentSessionForNode);
        // Fall through to normal resolution — session changed
      } else {
        try {
          const resolved = await cdpClient.send<{ object: { objectId: string } }>(
            "DOM.resolveNode",
            { backendNodeId: cached.backendNodeId },
            currentSessionForNode,
          );
          // B6: a detached node falls through — the normal path reports it as stale.
          if (!(await isDetached(cdpClient, resolved.object.objectId, currentSessionForNode))) {
            const info = a11yTree.getNodeInfo(cached.backendNodeId);
            debug("SelectorCache: hit for %s (backendNodeId=%d)", target.ref, cached.backendNodeId);
            return {
              backendNodeId: cached.backendNodeId,
              objectId: resolved.object.objectId,
              role: info?.role ?? "",
              name: info?.name ?? "",
              ref: target.ref,
              resolvedVia: "ref",
              resolvedSessionId: currentSessionForNode,
            };
          }
          debug("SelectorCache: %s is detached, falling back", target.ref);
          selectorCache.invalidate();
        } catch {
          // Stale cache entry — node no longer in DOM. Remove and fall through.
          debug("SelectorCache: stale entry for %s, invalidating", target.ref);
          selectorCache.invalidate();
        }
      }
    }

    // --- Normal Ref Resolution ---
    // BUG-016: resolveRefFull returns both backendNodeId AND the owning
    // sessionId in a single lookup. Eliminates the SessionManager linear
    // scan and the silent-wrong-session collision that caused T2.5 to
    // type into a Chrome Webstore iframe.
    const full = a11yTree.resolveRefFull(target.ref);
    if (!full) {
      // B1: a ref of another tab is not unknown, it is foreign — say whose it is.
      const owner = a11yTree.findRefOwnerTab(target.ref);
      if (owner) throw new RefNotFoundError(foreignTabRefMessage(target.ref, owner));
      // B5: numbers are never reused, so an issued ref no table holds belongs to a left document.
      throw new RefNotFoundError(
        a11yTree.isRetiredRef(target.ref) ? staleRefMessage(target.ref) : `Element ${target.ref} not found.`,
      );
    }
    const { backendNodeId, sessionId: targetSessionId } = full;

    // Safety net: ensure DOM domain is enabled before resolveNode.
    // DOM.getDocument implicitly enables DOM and is idempotent.
    try {
      await cdpClient.send("DOM.getDocument", { depth: 0 }, targetSessionId);
    } catch {
      // Best-effort — resolveNode may still work with backendNodeId
    }

    // Get objectId via DOM.resolveNode — may fail for stale refs (node removed from DOM)
    let resolved: { object: { objectId: string } };
    try {
      resolved = await cdpClient.send<{ object: { objectId: string } }>(
        "DOM.resolveNode",
        { backendNodeId },
        targetSessionId,
      );
    } catch (err) {
      // M1: Distinguish CDP connection errors from stale refs
      const wrapped = wrapCdpError(err, "resolveElement");
      if (wrapped.startsWith("CDP connection lost")) {
        throw new Error(wrapped);
      }
      // Distinguish "DOM not enabled" from actual stale refs
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("DOM agent needs to be enabled")) {
        throw new Error(`DOM domain not enabled for session — this is a server bug, not a stale ref. Try calling view_page first or report this issue.`);
      }
      throw new RefNotFoundError(staleRefMessage(target.ref));
    }
    // B6: DOM.resolveNode also finds nodes a re-render removed but that are
    // still alive — refuse them before any tool focuses, types or clicks.
    if (await isDetached(cdpClient, resolved.object.objectId, targetSessionId)) {
      throw new RefNotFoundError(staleRefMessage(target.ref));
    }
    // Get role/name directly from nodeInfoMap via backendNodeId
    const info = a11yTree.getNodeInfo(backendNodeId);

    // Cache the resolved ref for future lookups (Story 7.5)
    // H1 fix: Pass URL + nodeCount so set() can compute on-the-fly fingerprint
    // when no fingerprint is active yet (first resolution after navigation)
    if (!inScriptTab()) {
      selectorCache.set(target.ref, backendNodeId, targetSessionId, a11yTree.currentUrl, a11yTree.refCount);
    }

    return {
      backendNodeId,
      objectId: resolved.object.objectId,
      role: info?.role ?? "",
      name: info?.name ?? "",
      ref: target.ref,
      resolvedVia: "ref",
      resolvedSessionId: targetSessionId,
    };
  }

  // CSS path — always main frame (CSS selectors don't work cross-frame).
  // S3: strict — querySelectorAll on the same root DOM.querySelector used
  // (main document, no iframe or shadow-root piercing), and more than one
  // match is an error instead of a silent "first match in document order".
  const doc = await cdpClient.send<{ root: { nodeId: number } }>(
    "DOM.getDocument",
    { depth: 0 },
    sessionId,
  );
  let nodeIds: number[];
  try {
    ({ nodeIds } = await cdpClient.send<{ nodeIds: number[] }>(
      "DOM.querySelectorAll",
      { nodeId: doc.root.nodeId, selector: target.selector! },
      sessionId,
    ));
  } catch (err) {
    // S3: Chrome answers a selector it cannot parse with ServerError -32000
    // "DOM Error while querying" (InspectorDOMAgent::querySelectorAll) —
    // usually Playwright syntax. Say what works instead. Anything else (lost
    // connection, closed session) passes through unchanged.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("DOM Error while querying")) {
      throw new Error(
        `Invalid CSS selector '${target.selector}': Playwright syntax like :has-text() is not supported, use a ref from view_page or valid CSS.`,
      );
    }
    throw err;
  }
  if (nodeIds.length === 0) {
    throw new Error(`Element not found for selector '${target.selector}'`);
  }
  if (nodeIds.length > 1) {
    const candidates = await Promise.all(
      nodeIds.slice(0, MAX_SELECTOR_CANDIDATES).map((nodeId) => describeCandidate(cdpClient, sessionId, nodeId)),
    );
    throw new AmbiguousSelectorError(target.selector!, nodeIds.length, candidates);
  }
  const desc = await cdpClient.send<{ node: { backendNodeId: number } }>(
    "DOM.describeNode",
    { nodeId: nodeIds[0] },
    sessionId,
  );
  const backendNodeId = desc.node.backendNodeId;
  // Get objectId
  const resolved = await cdpClient.send<{ object: { objectId: string } }>(
    "DOM.resolveNode",
    { backendNodeId },
    sessionId,
  );
  // S3: role/name/ref from the a11y tree when it knows the node (0 CDP calls);
  // click fills in tag and text itself when it does not.
  const info = a11yTree.getNodeInfo(backendNodeId, sessionId);
  return {
    backendNodeId,
    objectId: resolved.object.objectId,
    role: info?.role ?? "",
    name: info?.name ?? "",
    ref: a11yTree.getRefForBackendNodeId(backendNodeId, sessionId),
    resolvedVia: "css",
    resolvedSessionId: sessionId,
  };
}

// --- Contextual Error Messages ---

/**
 * Build a contextual "did you mean?" error message for a missing ref.
 * When roleFilter is provided, only suggests elements matching those roles.
 */
// Roles that are useless as suggestions when their name is empty (BUG-013)
const CONTAINER_ROLES = new Set(["generic", "group", "none", "Section", "div"]);

export function buildRefNotFoundError(
  ref: string,
  roleFilter?: Set<string>,
): string {
  // B1: a ref of another tab — name that tab instead of guessing a neighbour here.
  const owner = a11yTree.findRefOwnerTab(ref);
  if (owner) return foreignTabRefMessage(ref, owner);
  // B1: this tab knows the ref, so resolving it failed on its node — stale, not a typo.
  // B5: a number handed out earlier that no table holds any more is stale, too.
  if (a11yTree.resolveRefFull(ref) || a11yTree.isRetiredRef(ref)) return staleRefMessage(ref);

  const suggestion = a11yTree.findClosestRef(ref, roleFilter);

  // FR-004 + BUG-013: Detect stale / useless suggestions.
  // — no suggestion at all
  // — suggestion ref equals the requested ref (safety-net)
  // — suggestion is an unnamed container (e.g. generic '') — not actionable
  const isUseless =
    !suggestion ||
    suggestion.ref === ref ||
    (!suggestion.name && CONTAINER_ROLES.has(suggestion.role));

  if (isUseless) {
    return `Element ${ref} not found (possibly stale after navigation, DOM change, or tab/frame switch). Call view_page for fresh refs and retry; avoid selector-based evaluate as default recovery.`;
  }

  return `Element ${ref} not found. Did you mean ${suggestion.ref} (${suggestion.role} '${suggestion.name}')?`;
}

export { RefNotFoundError } from "../cache/a11y-tree.js";
