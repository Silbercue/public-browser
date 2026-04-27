/**
 * Story 12a.4: HintMatcher tests (PageType-based Markov predictions).
 *
 * Covers:
 *  - matchByPageType() with Markov predictions (AC #1, #2)
 *  - matchByPageType("unknown") returns empty result (AC #3)
 *  - Deprecated match(url) returns empty result always (AC #4)
 *  - CortexHint shape: pageType, predictions, toolSequence, installationCount
 *  - patternCount delegates to markovTable.size
 *  - refresh / refreshAsync delegate to markovTable.refreshFromStore
 *  - Edge cases: empty/null params, graceful degradation
 *  - Integration with MarkovTable: real predict() results
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MarkovTable, markovTable } from "./markov-table.js";
import type { CortexPattern, CortexHint } from "./cortex-types.js";

/**
 * Helper: Create a minimal CortexPattern for MarkovTable ingestion.
 */
function makePattern(overrides: Partial<CortexPattern> = {}): CortexPattern {
  return {
    pageType: "login",
    toolSequence: ["navigate", "fill_form", "click"],
    outcome: "success" as const,
    contentHash: "a1b2c3d4e5f6a7b8",
    timestamp: Date.now(),
    ...overrides,
  };
}

/**
 * Helper: Seed the markovTable singleton with patterns for testing.
 * Clears existing data, ingests the provided patterns.
 */
function seedMarkov(patterns: CortexPattern[]): void {
  // Access the private _transitions to clear it
  (markovTable as unknown as { _transitions: Map<string, unknown> })._transitions.clear();
  markovTable.ingest(patterns);
}

describe("HintMatcher (Story 12a.4)", () => {
  // Use a fresh HintMatcher import for each test.
  // We need to import after any mocking setup.
  let HintMatcher: typeof import("./hint-matcher.js").HintMatcher;
  let hintMatcher: import("./hint-matcher.js").HintMatcher;

  beforeEach(async () => {
    // Clear markov table state
    (markovTable as unknown as { _transitions: Map<string, unknown> })._transitions.clear();

    // Fresh import of the class
    const mod = await import("./hint-matcher.js");
    HintMatcher = mod.HintMatcher;
    hintMatcher = new HintMatcher();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // matchByPageType (AC #1, #2)
  // =========================================================================

  describe("matchByPageType", () => {
    it("returns predictions for known pageType with Markov data", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "view_page", "fill_form"] }),
      ]);

      const result = hintMatcher.matchByPageType("login", "navigate");
      expect(result.matchCount).toBeGreaterThan(0);
      expect(result.hints).toHaveLength(1);

      const hint = result.hints[0];
      expect(hint.pageType).toBe("login");
      expect(hint.predictions.length).toBeGreaterThan(0);
      expect(hint.predictions[0].tool).toBe("fill_form"); // Most frequent
      expect(hint.predictions[0].probability).toBeGreaterThan(0);
    });

    it("returns EMPTY_RESULT for pageType 'unknown' (AC #3)", () => {
      seedMarkov([makePattern()]);
      const result = hintMatcher.matchByPageType("unknown");
      expect(result.matchCount).toBe(0);
      expect(result.hints).toHaveLength(0);
    });

    it("defaults lastTool to 'navigate' when not provided", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form"] }),
      ]);

      const result = hintMatcher.matchByPageType("login");
      expect(result.matchCount).toBeGreaterThan(0);
      expect(result.hints[0].predictions[0].tool).toBe("fill_form");
    });

    it("returns different predictions for different pageTypes", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["view_page", "fill_form"] }),
        makePattern({ pageType: "data_table", toolSequence: ["view_page", "scroll"] }),
      ]);

      const loginResult = hintMatcher.matchByPageType("login", "view_page");
      const tableResult = hintMatcher.matchByPageType("data_table", "view_page");

      expect(loginResult.hints[0].predictions[0].tool).toBe("fill_form");
      expect(tableResult.hints[0].predictions[0].tool).toBe("scroll");
    });

    it("result contains pageType, not domain or pathPattern", () => {
      seedMarkov([makePattern()]);
      const result = hintMatcher.matchByPageType("login", "navigate");
      const hint = result.hints[0];

      expect(hint.pageType).toBe("login");
      expect(hint).not.toHaveProperty("domain");
      expect(hint).not.toHaveProperty("pathPattern");
      expect(hint).not.toHaveProperty("successRate");
    });

    it("returns EMPTY_RESULT when no Markov data exists for the pageType", () => {
      // markovTable is empty
      const result = hintMatcher.matchByPageType("login", "navigate");
      expect(result.matchCount).toBe(0);
      expect(result.hints).toHaveLength(0);
    });
  });

  // =========================================================================
  // Deprecated match(url) (AC #4)
  // =========================================================================

  describe("deprecated match(url)", () => {
    it("match(url) returns EMPTY_RESULT always (domain index removed)", () => {
      seedMarkov([makePattern()]);
      const result = hintMatcher.match("https://example.com/login");
      expect(result.matchCount).toBe(0);
      expect(result.hints).toHaveLength(0);
    });

    it("match() does not throw on any input", () => {
      expect(() => hintMatcher.match("")).not.toThrow();
      expect(() => hintMatcher.match("not-a-url")).not.toThrow();
      expect(() => hintMatcher.match("https://example.com")).not.toThrow();
    });
  });

  // =========================================================================
  // patternCount (delegates to markovTable.size)
  // =========================================================================

  describe("patternCount", () => {
    it("returns 0 on empty Markov table", () => {
      expect(hintMatcher.patternCount).toBe(0);
    });

    it("delegates to markovTable.size", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
      ]);
      // 2 transitions: navigate→fill_form, fill_form→click
      expect(hintMatcher.patternCount).toBe(2);
    });

    it("updates after more patterns are ingested", () => {
      seedMarkov([makePattern({ toolSequence: ["navigate", "fill_form"] })]);
      expect(hintMatcher.patternCount).toBe(1);

      markovTable.ingest([makePattern({ toolSequence: ["navigate", "click", "view_page"] })]);
      // navigate→fill_form + navigate→click + click→view_page = 3
      expect(hintMatcher.patternCount).toBe(3);
    });
  });

  // =========================================================================
  // refresh / refreshAsync
  // =========================================================================

  describe("refresh / refreshAsync", () => {
    it("refreshAsync() delegates to markovTable.refreshFromStore()", async () => {
      const spy = vi.spyOn(markovTable, "refreshFromStore").mockResolvedValue(undefined);

      await hintMatcher.refreshAsync();

      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });

    it("refresh() is fire-and-forget (no throw)", () => {
      const spy = vi.spyOn(markovTable, "refreshFromStore").mockRejectedValue(new Error("test"));

      expect(() => hintMatcher.refresh()).not.toThrow();

      spy.mockRestore();
    });

    it("after refreshAsync with mock data, predictions are available", async () => {
      // Mock refreshFromStore to ingest patterns
      const spy = vi.spyOn(markovTable, "refreshFromStore").mockImplementation(async () => {
        (markovTable as unknown as { _transitions: Map<string, unknown> })._transitions.clear();
        markovTable.ingest([makePattern()]);
      });

      await hintMatcher.refreshAsync();

      const result = hintMatcher.matchByPageType("login", "navigate");
      expect(result.matchCount).toBeGreaterThan(0);

      spy.mockRestore();
    });
  });

  // =========================================================================
  // CortexHint shape (AC #4)
  // =========================================================================

  describe("CortexHint shape", () => {
    it("has pageType, predictions, toolSequence, installationCount", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
      ]);

      const result = hintMatcher.matchByPageType("login", "navigate");
      const hint = result.hints[0];

      expect(hint).toHaveProperty("pageType");
      expect(hint).toHaveProperty("predictions");
      expect(hint).toHaveProperty("toolSequence");
      expect(hint).toHaveProperty("installationCount");
    });

    it("does NOT have domain, pathPattern, or successRate", () => {
      seedMarkov([makePattern()]);
      const hint = hintMatcher.matchByPageType("login", "navigate").hints[0];

      expect(hint).not.toHaveProperty("domain");
      expect(hint).not.toHaveProperty("pathPattern");
      expect(hint).not.toHaveProperty("successRate");
    });

    it("predictions is Array of { tool: string; probability: number }", () => {
      seedMarkov([makePattern()]);
      const hint = hintMatcher.matchByPageType("login", "navigate").hints[0];

      expect(Array.isArray(hint.predictions)).toBe(true);
      for (const p of hint.predictions) {
        expect(typeof p.tool).toBe("string");
        expect(typeof p.probability).toBe("number");
        expect(p.probability).toBeGreaterThanOrEqual(0);
        expect(p.probability).toBeLessThanOrEqual(1);
      }
    });

    it("probabilities sum to approximately 1.0", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "view_page"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form"] }),
      ]);

      const hint = hintMatcher.matchByPageType("login", "navigate").hints[0];
      const sum = hint.predictions.reduce((acc, p) => acc + p.probability, 0);
      // Allow rounding tolerance
      expect(sum).toBeGreaterThanOrEqual(0.95);
      expect(sum).toBeLessThanOrEqual(1.05);
    });

    it("toolSequence contains at most 3 entries (top-N)", () => {
      // Create a pattern with many different next tools from "navigate"
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "view_page"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "click"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "scroll"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "type"] }),
      ]);

      const hint = hintMatcher.matchByPageType("login", "navigate").hints[0];
      expect(hint.toolSequence.length).toBeLessThanOrEqual(3);
      // predictions has all entries
      expect(hint.predictions.length).toBe(5);
    });

    it("installationCount equals number of transitions", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "view_page"] }),
      ]);

      const hint = hintMatcher.matchByPageType("login", "navigate").hints[0];
      expect(hint.installationCount).toBe(2); // fill_form + view_page
    });
  });

  // =========================================================================
  // Integration with MarkovTable
  // =========================================================================

  describe("Integration with Markov table", () => {
    it("MarkovTable with known patterns yields correct predictions", () => {
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form", "click"] }),
      ]);

      const result = hintMatcher.matchByPageType("login", "navigate");
      expect(result.hints[0].predictions[0].tool).toBe("fill_form");
      expect(result.hints[0].predictions[0].probability).toBe(1.0);
    });

    it("empty MarkovTable yields EMPTY_RESULT", () => {
      const result = hintMatcher.matchByPageType("login", "navigate");
      expect(result).toEqual({ hints: [], matchCount: 0 });
    });

    it("MarkovTable with decay reflects current weights", () => {
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      seedMarkov([
        makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form"], timestamp: oneWeekAgo }),
        makePattern({ pageType: "login", toolSequence: ["navigate", "click"], timestamp: Date.now() }),
      ]);

      // Apply decay — the old fill_form transition should have lower weight
      markovTable.applyDecay();

      const result = hintMatcher.matchByPageType("login", "navigate");
      expect(result.hints[0].predictions.length).toBe(2);
      // click should have higher probability since fill_form is decayed
      const clickPred = result.hints[0].predictions.find((p) => p.tool === "click");
      const formPred = result.hints[0].predictions.find((p) => p.tool === "fill_form");
      expect(clickPred!.probability).toBeGreaterThan(formPred!.probability);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("empty pageType returns EMPTY_RESULT", () => {
      seedMarkov([makePattern()]);
      const result = hintMatcher.matchByPageType("");
      expect(result.matchCount).toBe(0);
    });

    it("null/undefined-like parameters degrade gracefully", () => {
      seedMarkov([makePattern()]);
      expect(hintMatcher.matchByPageType(null as unknown as string)).toEqual(EMPTY_RESULT());
      expect(hintMatcher.matchByPageType(undefined as unknown as string)).toEqual(EMPTY_RESULT());
    });

    it("very many predictions — all returned in predictions, toolSequence capped at 3", () => {
      // Ingest patterns that create many unique transitions from navigate
      const patterns: CortexPattern[] = [];
      for (let i = 0; i < 10; i++) {
        patterns.push(makePattern({
          pageType: "form",
          toolSequence: ["navigate", `tool_${i}`],
        }));
      }
      seedMarkov(patterns);

      const result = hintMatcher.matchByPageType("form", "navigate");
      expect(result.hints[0].predictions.length).toBe(10);
      expect(result.hints[0].toolSequence.length).toBe(3);
    });
  });

  // =========================================================================
  // Singleton export
  // =========================================================================

  it("hintMatcher singleton is exported", async () => {
    const mod = await import("./hint-matcher.js");
    expect(mod.hintMatcher).toBeInstanceOf(mod.HintMatcher);
  });
});

/** Helper to create EMPTY_RESULT for comparison. */
function EMPTY_RESULT() {
  return { hints: [], matchCount: 0 };
}
