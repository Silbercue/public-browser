/**
 * Story 12a.3: Markov Transition Table — Cortex Phase 1.
 *
 * Weighted first-order Markov transition table that models:
 *   P(next_tool | last_tool, page_type)
 *
 * Data flow:
 *   CortexPattern[] (from PatternRecorder / LocalStore)
 *     -> ingest() (extracts bigrams from tool sequences)
 *       -> predict(pageType, lastTool) -> MarkovTransition[] (sorted by weight)
 *
 * Export:
 *   toJSON() -> MarkovTableJSON (normalised 0-1 weights, ~10KB community bundle)
 *   fromJSON() -> MarkovTable (imports community bundles)
 *
 * ACO Decay:
 *   applyDecay() reduces weights of stale entries (0.95 per week),
 *   removes entries older than 30 days.
 *
 * Error philosophy: NEVER throw — graceful degradation on any failure.
 * All public methods are wrapped in try/catch, errors are debug-logged.
 */
import { debug } from "../cdp/debug.js";
import type { CortexPattern, MarkovTransition, MarkovTableJSON } from "./cortex-types.js";
import {
  MARKOV_DECAY_FACTOR,
  MARKOV_DECAY_INTERVAL_MS,
  MARKOV_MAX_AGE_MS,
} from "./cortex-types.js";
import { PAGE_TYPES } from "./page-classifier.js";

/** Separator for the composite Map key "pageType||lastTool". */
const KEY_SEP = "||";

export class MarkovTable {
  /**
   * Internal state: outer Map keyed by "pageType||lastTool",
   * inner Map keyed by nextTool -> MarkovTransition.
   */
  private _transitions = new Map<string, Map<string, MarkovTransition>>();

  /** Whether refreshFromStore has been called at least once. */
  private _initialised = false;

  // ═══════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Ingest patterns and extract bigram transitions.
   *
   * For a pattern with toolSequence [navigate, view_page, fill_form, click]
   * on pageType "login", this extracts 3 transitions:
   *   (login, navigate) -> view_page
   *   (login, view_page) -> fill_form
   *   (login, fill_form) -> click
   *
   * Each transition increments `count` and sets `weight = count`.
   * Decay is applied separately via applyDecay().
   */
  ingest(patterns: CortexPattern[]): void {
    try {
      if (!patterns || !Array.isArray(patterns)) return;

      for (const pattern of patterns) {
        if (!pattern || !Array.isArray(pattern.toolSequence)) continue;
        if (!pattern.pageType) continue;

        const seq = pattern.toolSequence;
        const pageType = pattern.pageType;
        const timestamp = pattern.timestamp ?? Date.now();

        // Extract bigrams (consecutive tool pairs)
        for (let i = 0; i < seq.length - 1; i++) {
          const lastTool = seq[i];
          const nextTool = seq[i + 1];
          if (!lastTool || !nextTool) continue;

          const outerKey = `${pageType}${KEY_SEP}${lastTool}`;
          let inner = this._transitions.get(outerKey);
          if (!inner) {
            inner = new Map();
            this._transitions.set(outerKey, inner);
          }

          const existing = inner.get(nextTool);
          if (existing) {
            existing.count++;
            existing.weight = existing.count;
            existing.lastSeen = Math.max(existing.lastSeen, timestamp);
          } else {
            inner.set(nextTool, {
              tool: nextTool,
              weight: 1,
              count: 1,
              lastSeen: timestamp,
            });
          }
        }
      }
    } catch (err) {
      debug(
        "[markov-table] ingest() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Predict the most likely next tools given the current state.
   *
   * Returns transitions sorted descending by weight.
   * Returns empty array for pageType "unknown" or if no data exists.
   */
  predict(pageType: string, lastTool: string): MarkovTransition[] {
    try {
      if (!pageType || !lastTool) return [];
      if (pageType === "unknown") return [];

      const outerKey = `${pageType}${KEY_SEP}${lastTool}`;
      const inner = this._transitions.get(outerKey);
      if (!inner || inner.size === 0) return [];

      return [...inner.values()].sort((a, b) => b.weight - a.weight);
    } catch (err) {
      debug(
        "[markov-table] predict() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  /**
   * ACO decay: reduce weights of stale entries, remove entries older than 30 days.
   *
   * Formula: weight = count * MARKOV_DECAY_FACTOR ^ weeksSinceLastSeen
   * Entries older than MARKOV_MAX_AGE_MS are removed entirely.
   *
   * @param now - Current timestamp in ms (default: Date.now()). Injectable for testing.
   */
  applyDecay(now?: number): void {
    try {
      const currentTime = now ?? Date.now();
      const outerKeysToDelete: string[] = [];

      for (const [outerKey, inner] of this._transitions) {
        const toolsToDelete: string[] = [];

        for (const [toolKey, transition] of inner) {
          const age = currentTime - transition.lastSeen;

          // Remove entries older than 30 days
          if (age > MARKOV_MAX_AGE_MS) {
            toolsToDelete.push(toolKey);
            continue;
          }

          // Apply decay: weight = count * factor ^ weeks
          const weeksSinceLastSeen = age / MARKOV_DECAY_INTERVAL_MS;
          transition.weight = transition.count * Math.pow(MARKOV_DECAY_FACTOR, weeksSinceLastSeen);
        }

        // Clean up expired entries
        for (const key of toolsToDelete) {
          inner.delete(key);
        }

        // Remove empty outer entries
        if (inner.size === 0) {
          outerKeysToDelete.push(outerKey);
        }
      }

      // Clean up empty outer map entries
      for (const key of outerKeysToDelete) {
        this._transitions.delete(key);
      }
    } catch (err) {
      debug(
        "[markov-table] applyDecay() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Export to community bundle format (MarkovTableJSON).
   *
   * Normalises weights to 0-1 per (pageType, lastTool) bucket.
   * Only includes transitions with weight > 0.
   * Weights rounded to 2 decimal places.
   */
  toJSON(): MarkovTableJSON {
    try {
      const result: MarkovTableJSON = {};

      for (const [outerKey, inner] of this._transitions) {
        const sepIdx = outerKey.indexOf(KEY_SEP);
        if (sepIdx < 0) continue;

        const pageType = outerKey.slice(0, sepIdx);
        const lastTool = outerKey.slice(sepIdx + KEY_SEP.length);

        // Collect transitions with weight > 0
        const entries: Array<{ tool: string; weight: number }> = [];
        let totalWeight = 0;
        for (const t of inner.values()) {
          if (t.weight > 0) {
            entries.push({ tool: t.tool, weight: t.weight });
            totalWeight += t.weight;
          }
        }

        if (entries.length === 0 || totalWeight === 0) continue;

        // Normalise to 0-1 and round to 2 decimal places.
        // Weights may sum to ≈1.0 due to floating-point rounding —
        // consumers must use tolerance-based checks (±0.01).
        if (!result[pageType]) result[pageType] = {};
        const bucket: { [nextTool: string]: number } = {};
        for (const e of entries) {
          bucket[e.tool] = Math.round((e.weight / totalWeight) * 100) / 100;
        }
        result[pageType][lastTool] = bucket;
      }

      return result;
    } catch (err) {
      debug(
        "[markov-table] toJSON() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
      return {};
    }
  }

  /**
   * Import from community bundle format (MarkovTableJSON).
   *
   * Validates pageType keys against PAGE_TYPES — unknown pageTypes are
   * skipped and debug-logged. Tool names are NOT validated (tool palette
   * may differ between versions).
   *
   * count is set to 1 (community data has no local count).
   * lastSeen is set to Date.now().
   */
  static fromJSON(data: MarkovTableJSON): MarkovTable {
    const table = new MarkovTable();
    try {
      if (!data || typeof data !== "object") return table;

      // PAGE_TYPES is a synchronous const array from page-classifier.ts
      // (static import — no async preload race, no circular dependency).
      const knownPageTypes: readonly string[] = PAGE_TYPES;

      const now = Date.now();

      for (const [pageType, toolBuckets] of Object.entries(data)) {
        // Validate pageType if we have the list
        if (knownPageTypes.length > 0 && !knownPageTypes.includes(pageType)) {
          debug("[markov-table] fromJSON: skipping unknown pageType %s", pageType);
          continue;
        }

        if (!toolBuckets || typeof toolBuckets !== "object") continue;

        for (const [lastTool, nextTools] of Object.entries(toolBuckets)) {
          if (!nextTools || typeof nextTools !== "object") continue;

          const outerKey = `${pageType}${KEY_SEP}${lastTool}`;
          let inner = table._transitions.get(outerKey);
          if (!inner) {
            inner = new Map();
            table._transitions.set(outerKey, inner);
          }

          for (const [nextTool, weight] of Object.entries(nextTools)) {
            if (typeof weight !== "number" || weight <= 0) continue;
            inner.set(nextTool, {
              tool: nextTool,
              weight,
              count: 1,
              lastSeen: now,
            });
          }
        }
      }
    } catch (err) {
      debug(
        "[markov-table] fromJSON() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
    return table;
  }

  /**
   * Merge another MarkovTable into this one (e.g. community + local).
   *
   * For each transition:
   *   weight = max(local.weight, other.weight)
   *   count = local.count + other.count
   *   lastSeen = max(local.lastSeen, other.lastSeen)
   */
  merge(other: MarkovTable): void {
    try {
      if (!other || !(other instanceof MarkovTable)) return;

      for (const [outerKey, otherInner] of other._transitions) {
        let localInner = this._transitions.get(outerKey);
        if (!localInner) {
          localInner = new Map();
          this._transitions.set(outerKey, localInner);
        }

        for (const [toolKey, otherTransition] of otherInner) {
          const localTransition = localInner.get(toolKey);
          if (localTransition) {
            localTransition.weight = Math.max(localTransition.weight, otherTransition.weight);
            localTransition.count += otherTransition.count;
            localTransition.lastSeen = Math.max(localTransition.lastSeen, otherTransition.lastSeen);
          } else {
            localInner.set(toolKey, { ...otherTransition });
          }
        }
      }
    } catch (err) {
      debug(
        "[markov-table] merge() threw: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Refresh from PatternRecorder + LocalStore.
   *
   * Loads all patterns from both sources, rebuilds the table via ingest(),
   * then applies decay. Fire-and-forget, errors debug-logged.
   */
  async refreshFromStore(): Promise<void> {
    try {
      const [{ patternRecorder }, { LocalStore: LS }] = await Promise.all([
        import("./pattern-recorder.js"),
        import("./local-store.js"),
      ]);

      const store = new LS();
      const persisted = await store.getAll();
      const inMemory = patternRecorder.emittedPatterns;

      // Rebuild table from all known patterns
      this._transitions.clear();
      this.ingest([...persisted, ...inMemory]);
      this.applyDecay();
      this._initialised = true;

      debug("[markov-table] refreshFromStore: %d transitions", this.size);
    } catch (err) {
      debug(
        "[markov-table] refreshFromStore() failed: %s",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Total number of transitions (for diagnostics and tests). */
  get size(): number {
    try {
      let total = 0;
      for (const inner of this._transitions.values()) {
        total += inner.size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  /** List of all pageTypes that have transitions (for diagnostics). */
  get pageTypes(): string[] {
    try {
      const types = new Set<string>();
      for (const outerKey of this._transitions.keys()) {
        const sepIdx = outerKey.indexOf(KEY_SEP);
        if (sepIdx >= 0) {
          types.add(outerKey.slice(0, sepIdx));
        }
      }
      return [...types];
    } catch {
      return [];
    }
  }
}

// ─── Module-level Singleton ─────────────────────────────────────────

/**
 * Module-level singleton (same pattern as patternRecorder, hintMatcher,
 * telemetryUploader). Starts empty — populated via refreshFromStore()
 * on first pattern emission or explicit call.
 */
export const markovTable = new MarkovTable();
