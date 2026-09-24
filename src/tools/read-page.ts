import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import type { ToolResponse } from "../types.js";
import { a11yTree, RefNotFoundError } from "../cache/a11y-tree.js";
import { wrapCdpError } from "./error-utils.js";
import { foreignTabRefMessage, staleRefMessage } from "./element-utils.js";
import { toolSequence } from "../telemetry/tool-sequence.js";
import { hintMatcher, formatCortexLine } from "../cortex/hint-matcher.js";
import { debug } from "../cdp/debug.js";
import { HINT_KIND, hintLedger } from "../telemetry/hint-ledger.js";

export const readPageSchema = z.object({
  depth: z.number().optional().default(3).describe("Tree levels shown; indentation only, hidden sections need a click"),
  ref: z.string().optional().describe("Element ref for a subtree"),
  filter: z
    .enum(["interactive", "all", "landmark", "visual"])
    .optional()
    .default("interactive")
    .describe("interactive | all | landmark | visual (bounds, click point, visibility)"),
  max_tokens: z.number().int().optional().transform(v => v !== undefined && v < 500 ? 500 : v).describe("Token budget; content downsampled. Omit for full output"),
});

export type ReadPageParams = z.infer<typeof readPageSchema>;

export async function readPageHandler(
  params: ReadPageParams,
  cdpClient: CdpClient,
  sessionId?: string,
  sessionManager?: SessionManager,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "view_page";

  try {
    const result = await a11yTree.getTree(cdpClient, sessionId!, {
      depth: params.depth,
      ref: params.ref,
      filter: params.filter,
      max_tokens: params.max_tokens,
      fresh: true, // Story 13a.2 fix: always fetch fresh data — precomputed cache may be stale after SPA navigation
    }, sessionManager);

    let responseText = result.text;

    // FR-016: Warn when a subtree request returns a single leaf node — likely stale ref
    if (params.ref && result.refCount <= 1) {
      const trimmed = result.text.trim();
      const isLeaf = /^(\[e\d+\]\s+)?(StaticText|img|separator|none)\b/.test(trimmed) ||
        trimmed.split("\n").length <= 2;
      if (isLeaf) {
        responseText += `\n\n⚠ This ref points to a single leaf node — the DOM may have changed since view_page was last called. Consider calling view_page without ref for a fresh view.`;
      }
    }

    // Stufe 2 H5: the FR-03 footer "[~N tokens | N refs]" is gone — the numbers
    // stay in _meta (tokenCount, refCount, originalTokens), and a downsampled
    // tree already says "downsampled Lx from ~N tokens" in its header.

    // Truncation warning — when downsampled, tell the LLM the collapse
    // format AND the positive action (no "avoid screenshot" negative framing
    // — research shows that pushes the LLM toward the next defensive
    // fallback instead of the useful action).
    if (result.downsampled && params.max_tokens) {
      responseText += `\n⚠ Truncated to ~${params.max_tokens} tokens. Remaining content collapsed into \`[eXX role, N items]\` summary lines. Call view_page(ref:'eXX', filter:'all') on a summary ref to expand that subtree.`;
    }

    // FR-H6: Detect hidden interactive elements — hint when page has hidden sections
    if (params.filter === "interactive" && result.refCount > 0) {
      try {
        const hiddenResult = await cdpClient.send<{ result: { value: number } }>(
          "Runtime.evaluate",
          {
            expression: `(() => { let h = 0; for (const el of document.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,[role="button"],[role="tab"],[role="link"]')) { if (el.offsetParent === null) { const p = getComputedStyle(el).position; if (p !== "fixed" && p !== "sticky") h++; } } return h; })()`,
            returnByValue: true,
          },
          sessionId,
        );
        const hiddenCount = hiddenResult?.result?.value;
        if (typeof hiddenCount === "number" && hiddenCount >= 5) {
          // Stufe 2 H3: the count is state and comes every time; the advice
          // after it comes once per MCP session.
          responseText += `\n\nNote: ${hiddenCount} interactive elements are hidden (display: none).`;
          if (hintLedger.claim(HINT_KIND.viewPageHiddenInteractive)) {
            responseText += " Click tabs/buttons to reveal hidden sections.";
          }
        }
      } catch {
        // Best-effort — ignore errors
      }
    }

    // FR-022: Hint that visible text content (table cells, codes, labels) is filtered out by 'interactive'.
    // Prevents the LLM from reaching for evaluate/querySelector to read visible text.
    if (params.filter === "interactive" && (result.hiddenContentCount ?? 0) >= 5) {
      // Stufe 2 H3: the count comes every time, the advice once per MCP session.
      responseText += `\n\nNote: ${result.hiddenContentCount} text/content nodes (table cells, paragraphs, static text) are not shown by filter:"interactive".`;
      if (hintLedger.claim(HINT_KIND.viewPageHiddenContent)) {
        responseText += ` If you need to read visible text content, call view_page(ref: "eN", filter: "all") on the subtree — don't fall back to evaluate/querySelector.`;
      }
    }

    const elapsedMs = Math.round(performance.now() - start);

    // BUG-018: Anti-Spiral telemetry — successful read_page resets the
    // evaluate-streak counter (per session) so a healthy workflow
    // (evaluate → oops → read_page → click) never triggers the nudge.
    toolSequence.record("view_page", undefined, sessionId);

    // Story 12a.4: Cortex hint injection — pageType-based Markov predictions.
    // In view_page the A11y-Tree was JUST built, so getPageType() is always current.
    let cortexMeta: Record<string, unknown> | undefined;
    try {
      const pageType = a11yTree.getPageType(sessionId);
      const hintResult = hintMatcher.matchByPageType(pageType, "view_page");
      if (hintResult.matchCount > 0) {
        cortexMeta = { hints: hintResult.hints, matchCount: hintResult.matchCount };
        // Stufe 2 H5: the text line only at P >= 0.9, _meta.cortex always.
        const cortexLine = formatCortexLine(pageType, hintResult);
        if (cortexLine) responseText += `\n${cortexLine}`;
      }
    } catch (err) {
      debug("[cortex-hint] view_page error: %s", err instanceof Error ? err.message : String(err));
    }

    return {
      content: [{ type: "text", text: responseText }],
      _meta: {
        elapsedMs,
        method,
        refCount: result.refCount,
        depth: result.depth,
        tokenCount: result.tokenCount,
        pageUrl: result.pageUrl,
        ...(result.hasVisualData !== undefined ? { hasVisualData: result.hasVisualData } : {}),
        ...(result.downsampled ? {
          downsampled: true,
          originalTokens: result.originalTokens,
          downsampleLevel: result.downsampleLevel,
        } : {}),
        ...(cortexMeta ? { cortex: cortexMeta } : {}),
      },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);

    if (err instanceof RefNotFoundError) {
      // B1: a ref of another tab — name that tab instead of "did you mean" in this one.
      // B5: a ref of a page left earlier is stale — no neighbour guess either.
      const owner = params.ref ? a11yTree.findRefOwnerTab(params.ref) : undefined;
      const text = owner && params.ref
        ? foreignTabRefMessage(params.ref, owner)
        : params.ref && a11yTree.isRetiredRef(params.ref) ? staleRefMessage(params.ref) : err.message;
      return {
        content: [{ type: "text", text }],
        isError: true,
        _meta: { elapsedMs, method },
      };
    }

    return {
      content: [{ type: "text", text: wrapCdpError(err, "view_page") }],
      isError: true,
      _meta: { elapsedMs, method },
    };
  }
}
