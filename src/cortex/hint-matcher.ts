/**
 * Story 12a.4: Hint Matcher — Cortex Phase 1 Hint Delivery (PageType-based).
 *
 * Matches the current page type against Markov transition predictions
 * and returns actionable hints (recommended next tools with probabilities)
 * for the LLM agent.
 *
 * Data flow:
 *   MarkovTable (populated from PatternRecorder + LocalStore)
 *     → HintMatcher.matchByPageType(pageType, lastTool)
 *       → navigate.ts / read-page.ts (_meta.cortex in ToolResponse)
 *
 * Design:
 *  - Synchronous `matchByPageType()` for hot-path use in tool handlers.
 *  - Delegates entirely to markovTable.predict() — no own index.
 *  - Module-level singleton (`hintMatcher`), same pattern as patternRecorder.
 *
 * Error philosophy: NEVER throw — graceful degradation on any failure.
 */
import { debug } from "../cdp/debug.js";
import { markovTable } from "./markov-table.js";
import type { CortexHint, HintMatchResult, MarkovTransition } from "./cortex-types.js";

/** Empty result constant — reused to avoid allocations on miss. */
const EMPTY_RESULT: HintMatchResult = { hints: [], matchCount: 0 };

export class HintMatcher {

  /**
   * Total number of transitions in the Markov table.
   * Delegates to markovTable.size. Used in Server-Description (Story 12.4).
   */
  get patternCount(): number {
    try {
      return markovTable.size;
    } catch {
      return 0;
    }
  }

  /**
   * Match by page type and (optional) last tool using Markov predictions.
   *
   * Central entry point — replaces the old match(url) method.
   * Returns EMPTY_RESULT for "unknown" pageType or when no predictions exist.
   *
   * @param pageType - Page type classification (e.g. "login", "data_table").
   * @param lastTool - Last tool called (default: "navigate").
   */
  matchByPageType(pageType: string, lastTool?: string): HintMatchResult {
    try {
      if (!pageType || pageType === "unknown") return EMPTY_RESULT;

      const transitions = markovTable.predict(pageType, lastTool ?? "navigate");
      if (!transitions || transitions.length === 0) return EMPTY_RESULT;

      const hint = this._buildHint(pageType, transitions);
      return { hints: [hint], matchCount: transitions.length };
    } catch (err) {
      debug(
        "[hint-matcher] matchByPageType() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
      return EMPTY_RESULT;
    }
  }

  /**
   * @deprecated Use matchByPageType(pageType, lastTool) instead.
   * Kept as a stub for safety — returns EMPTY_RESULT always.
   */
  match(url: string): HintMatchResult {
    try {
      debug("[hint-matcher] match(url) is deprecated — use matchByPageType(pageType)");
      return EMPTY_RESULT;
    } catch {
      return EMPTY_RESULT;
    }
  }

  /**
   * Synchronous refresh: fire-and-forget async reload from MarkovTable.
   * Called after each new pattern emission.
   */
  refresh(): void {
    try {
      markovTable.refreshFromStore().catch((err: unknown) => {
        debug(
          "[hint-matcher] refresh() failed: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
    } catch (err) {
      debug(
        "[hint-matcher] refresh() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Async refresh: delegates to markovTable.refreshFromStore().
   * Called once at server start.
   */
  async refreshAsync(): Promise<void> {
    try {
      await markovTable.refreshFromStore();
      debug("[hint-matcher] refreshAsync loaded %d transitions", markovTable.size);
    } catch (err) {
      debug(
        "[hint-matcher] refreshAsync() failed: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Build a CortexHint from Markov transitions.
   *
   * Normalises weights to probabilities (0-1), rounds to 2 decimal places.
   * toolSequence = top-3 predicted tools (backward compatibility).
   * installationCount = number of transitions.
   */
  private _buildHint(pageType: string, transitions: MarkovTransition[]): CortexHint {
    const totalWeight = transitions.reduce((sum, t) => sum + t.weight, 0);

    const predictions = transitions.map((t) => ({
      tool: t.tool,
      probability: totalWeight > 0
        ? Math.round((t.weight / totalWeight) * 100) / 100
        : 0,
    }));

    // Top-3 tools for backward compat toolSequence field
    const toolSequence = predictions.slice(0, 3).map((p) => p.tool);

    return {
      pageType,
      predictions,
      toolSequence,
      installationCount: transitions.length,
    };
  }
}

/**
 * Module-level singleton (same pattern as `patternRecorder` and `toolSequence`).
 *
 * Starts empty — `refreshAsync()` is called at server start to load
 * persisted patterns into the Markov table.
 */
export const hintMatcher = new HintMatcher();
