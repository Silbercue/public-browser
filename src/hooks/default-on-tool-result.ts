/**
 * FR-022 (P3 fix): Free-tier default `onToolResult` hook.
 *
 * The `click` tool description promises every caller that the response
 * "already includes the DOM diff (NEW/REMOVED/CHANGED lines)". Up until
 * Story 16.6 that promise was kept by the Pro-Repo's
 * `silbercuechrome-pro/src/visual/ambient-context.ts` — but the Free-Repo
 * never registered any `onToolResult` hook by default, so Free users got
 * the bare `Clicked eX (...)` text and a documentation lie.
 *
 * This module ports the 3-stage click-analysis logic into the Free-Repo as
 * the default hook so the promise holds for everyone, on every page. The
 * Pro-Repo can still register its own richer hook before `startServer()` —
 * `ToolRegistry.registerAll()` only installs this default when no
 * `onToolResult` is set.
 *
 * Improvements over the original Pro-Repo implementation:
 *
 *  - **Settle-Loop** (P3 root cause #2): when the first refresh produces an
 *    empty diff — typical for slow React/Vue re-renders that exceed the
 *    initial 350 ms wait window — the hook waits an additional
 *    `SILBERCUE_CHROME_DIFF_RETRY_MS` ms (default 500) and refreshes once
 *    more before giving up. This catches modal-close + table-reload races
 *    that the original fixed-wait variant silently dropped.
 *  - **Removed-Detection** (P3 root cause #3): refs whose owning
 *    backendNodeId is no longer present in the live AX tree get reported as
 *    REMOVED, even though `reverseMap` deliberately keeps them around (so
 *    the LLM can react to "stale ref" errors). The hook compares the
 *    pre-click snapshot map against the new `getActiveRefs()` set exposed
 *    on `A11yTreePublic`.
 *
 * Tunable via env vars (zero = disable):
 *   SILBERCUE_CHROME_DIFF_SETTLE_MS  — initial waitForAXChange budget (350)
 *   SILBERCUE_CHROME_DIFF_RETRY_MS   — extra settle window before retry  (500)
 */
import type { ToolResponse } from "../types.js";
import type { ProHooks } from "./pro-hooks.js";
import type { DOMChange } from "../cache/a11y-tree.js";
import { debug } from "../cdp/debug.js";

const DEFAULT_INITIAL_WAIT_MS = 350;
const DEFAULT_RETRY_WAIT_MS = 500;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type OnToolResult = NonNullable<ProHooks["onToolResult"]>;

/**
 * Builds the default `onToolResult` callback. Reads the env-var tunables
 * once at construction time so a single hook instance has stable timing
 * during the life of a server.
 */
export function createDefaultOnToolResult(): OnToolResult {
  const initialWaitMs = envInt("SILBERCUE_CHROME_DIFF_SETTLE_MS", DEFAULT_INITIAL_WAIT_MS);
  const retryWaitMs = envInt("SILBERCUE_CHROME_DIFF_RETRY_MS", DEFAULT_RETRY_WAIT_MS);

  return async (toolName, result, context) => {
    try {
      // Scope: only `click`, and only when the resolved element was actually
      // clickable. classifyRef returns "static" for refs that are not in the
      // a11y cache or live on a non-interactive role — pushing a diff for
      // those calls would just be noise.
      if (toolName !== "click") return result;
      const cls = (
        result as ToolResponse & { _meta?: { elementClass?: string } }
      )._meta?.elementClass;
      if (cls !== "clickable" && cls !== "widget-state") return result;

      // Stage 1: Snapshot of the cache as it stood when the click landed.
      // This reflects the state of the previous read_page() — the click
      // itself does not refresh the cache.
      const before = context.a11yTree.getSnapshotMap();

      // Stage 2 + 3: refresh the AX tree, take the after-snapshot, diff.
      // Wrapped in a closure so the settle-loop can call it twice.
      const computeChanges = async (waitMs: number): Promise<DOMChange[]> => {
        if (waitMs > 0) {
          try {
            await context.waitForAXChange?.(waitMs);
          } catch (err) {
            debug("[default-on-tool-result] waitForAXChange threw:", err);
          }
        }
        await context.a11yTree.refreshPrecomputed(
          context.cdpClient,
          context.sessionId,
          context.sessionManager,
        );
        const after = context.a11yTree.getSnapshotMap();
        const changes = context.a11yTree.diffSnapshots(before, after);

        // Removed-Detection: refs that were in `before` but whose owning
        // backendNodeId is no longer in the freshly-refreshed AX tree.
        // refreshPrecomputed never evicts old refs from reverseMap (so the
        // LLM can keep stale refs around long enough to react to them), so
        // diffSnapshots alone never catches truly removed nodes.
        const activeRefs = context.a11yTree.getActiveRefs();
        if (activeRefs.size > 0) {
          const reportedRefs = new Set(changes.map((c) => c.ref));
          for (const [refNum, encoded] of before) {
            const refTag = `e${refNum}`;
            if (reportedRefs.has(refTag)) continue;
            if (activeRefs.has(refNum)) continue;
            const sep = encoded.indexOf("\0");
            const role = sep >= 0 ? encoded.slice(0, sep) : encoded;
            const name = sep >= 0 ? encoded.slice(sep + 1) : "";
            if (!name) continue;
            changes.push({ type: "removed", ref: refTag, role, before: name, after: "" });
          }
        }

        return changes;
      };

      let changes = await computeChanges(initialWaitMs);

      // Settle-Loop: if the first refresh found nothing, the page might
      // still be re-rendering (typical for React modal-close + table reload
      // sequences). Give it one extra grace window before giving up.
      if (changes.length === 0 && retryWaitMs > 0) {
        try {
          await new Promise<void>((r) => setTimeout(r, retryWaitMs));
        } catch (err) {
          debug("[default-on-tool-result] settle delay threw:", err);
        }
        changes = await computeChanges(retryWaitMs);
      }

      const diffText = context.a11yTree.formatDomDiff(
        changes,
        context.a11yTree.currentUrl || undefined,
      );
      if (diffText) {
        result.content.push({ type: "text", text: diffText });
      }
      return result;
    } catch (err) {
      // Belt-and-braces — the hook must never destroy a tool response.
      debug("[default-on-tool-result] hook threw:", err);
      return result;
    }
  };
}
