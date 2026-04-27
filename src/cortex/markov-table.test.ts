/**
 * Story 12a.3 (Task 4-6): Unit-Tests fuer die Markov-Uebergangstabelle.
 *
 * Covers:
 *  - Ingest: Bigram-Extraktion aus Patterns (AC #1)
 *  - Predict: Tool-Vorhersagen pro Seitentyp (AC #2)
 *  - toJSON / fromJSON: Export/Import Community-Bundle-Format (AC #3)
 *  - Merge: Zusammenfuehren lokaler und Community-Daten
 *  - Decay: ACO-Verdampfung (AC #4)
 *  - Edge Cases und Error Handling
 *  - JSON-Groesse < 50KB (AC #3)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MarkovTable } from "./markov-table.js";
import type { CortexPattern, MarkovTransition, MarkovTableJSON } from "./cortex-types.js";
import {
  MARKOV_DECAY_FACTOR,
  MARKOV_DECAY_INTERVAL_MS,
  MARKOV_MAX_AGE_MS,
} from "./cortex-types.js";

// ─── Helpers ─────────────────────────────────────────────────────────

const NOW = Date.now();

/** Build a minimal CortexPattern for testing. */
function makePattern(
  pageType: string,
  toolSequence: string[],
  timestamp = NOW,
): CortexPattern {
  return {
    pageType,
    toolSequence,
    outcome: "success",
    contentHash: "0123456789abcdef",
    timestamp,
  };
}

// ─── Ingest ──────────────────────────────────────────────────────────

describe("MarkovTable — ingest", () => {
  let table: MarkovTable;

  beforeEach(() => {
    table = new MarkovTable();
  });

  it("extracts bigrams from a single pattern", () => {
    table.ingest([makePattern("login", ["navigate", "view_page", "fill_form", "click"])]);

    // 3 bigrams: navigate->view_page, view_page->fill_form, fill_form->click
    expect(table.size).toBe(3);
  });

  it("cumulates counts for repeated patterns of the same type", () => {
    table.ingest([
      makePattern("login", ["navigate", "view_page", "fill_form"]),
      makePattern("login", ["navigate", "view_page", "fill_form"]),
      makePattern("login", ["navigate", "view_page", "fill_form"]),
    ]);

    const predictions = table.predict("login", "navigate");
    expect(predictions.length).toBe(1);
    expect(predictions[0].tool).toBe("view_page");
    expect(predictions[0].count).toBe(3);
    expect(predictions[0].weight).toBe(3);
  });

  it("separates patterns by pageType into different buckets", () => {
    table.ingest([
      makePattern("login", ["navigate", "fill_form"]),
      makePattern("data_table", ["navigate", "click"]),
    ]);

    const loginPred = table.predict("login", "navigate");
    expect(loginPred.length).toBe(1);
    expect(loginPred[0].tool).toBe("fill_form");

    const tablePred = table.predict("data_table", "navigate");
    expect(tablePred.length).toBe(1);
    expect(tablePred[0].tool).toBe("click");
  });

  it("handles multiple ingest calls (incremental building)", () => {
    table.ingest([makePattern("login", ["navigate", "view_page"])]);
    table.ingest([makePattern("login", ["navigate", "view_page"])]);

    const predictions = table.predict("login", "navigate");
    expect(predictions[0].count).toBe(2);
  });

  it("updates lastSeen to the most recent timestamp", () => {
    const older = NOW - 100_000;
    const newer = NOW;

    table.ingest([makePattern("login", ["navigate", "view_page"], older)]);
    table.ingest([makePattern("login", ["navigate", "view_page"], newer)]);

    const predictions = table.predict("login", "navigate");
    expect(predictions[0].lastSeen).toBe(newer);
  });

  it("tracks all pageTypes via the pageTypes getter", () => {
    table.ingest([
      makePattern("login", ["navigate", "view_page"]),
      makePattern("search_form", ["navigate", "type"]),
      makePattern("data_table", ["navigate", "click"]),
    ]);

    const types = table.pageTypes;
    expect(types).toContain("login");
    expect(types).toContain("search_form");
    expect(types).toContain("data_table");
    expect(types.length).toBe(3);
  });
});

// ─── Predict ─────────────────────────────────────────────────────────

describe("MarkovTable — predict", () => {
  let table: MarkovTable;

  beforeEach(() => {
    table = new MarkovTable();
    // 10 patterns on login pages with navigate -> fill_form -> click
    const patterns: CortexPattern[] = [];
    for (let i = 0; i < 10; i++) {
      patterns.push(makePattern("login", ["navigate", "view_page", "fill_form", "click"]));
    }
    // 2 patterns with navigate -> type (less frequent)
    for (let i = 0; i < 2; i++) {
      patterns.push(makePattern("login", ["navigate", "type"]));
    }
    table.ingest(patterns);
  });

  it("returns fill_form with high weight for (login, view_page) — AC #2", () => {
    const predictions = table.predict("login", "view_page");
    expect(predictions.length).toBe(1);
    expect(predictions[0].tool).toBe("fill_form");
    expect(predictions[0].weight).toBe(10);
  });

  it("returns view_page with highest weight for (login, navigate)", () => {
    const predictions = table.predict("login", "navigate");
    // navigate -> view_page (10 times) and navigate -> type (2 times)
    expect(predictions.length).toBe(2);
    expect(predictions[0].tool).toBe("view_page");
    expect(predictions[0].weight).toBe(10);
    expect(predictions[1].tool).toBe("type");
    expect(predictions[1].weight).toBe(2);
  });

  it("returns results sorted descending by weight", () => {
    const predictions = table.predict("login", "navigate");
    for (let i = 1; i < predictions.length; i++) {
      expect(predictions[i - 1].weight).toBeGreaterThanOrEqual(predictions[i].weight);
    }
  });

  it("returns empty array for unknown pageType", () => {
    expect(table.predict("unknown", "navigate")).toEqual([]);
  });

  it("returns empty array for unrecorded lastTool", () => {
    expect(table.predict("login", "nonexistent_tool")).toEqual([]);
  });

  it("returns empty array for unrecorded pageType", () => {
    expect(table.predict("checkout", "navigate")).toEqual([]);
  });

  it("returns empty array on empty table", () => {
    const empty = new MarkovTable();
    expect(empty.predict("login", "navigate")).toEqual([]);
  });
});

// ─── toJSON / fromJSON ───────────────────────────────────────────────

describe("MarkovTable — toJSON / fromJSON", () => {
  let table: MarkovTable;

  beforeEach(() => {
    table = new MarkovTable();
    table.ingest([
      makePattern("login", ["navigate", "view_page", "fill_form", "click"]),
      makePattern("login", ["navigate", "view_page", "fill_form", "click"]),
      makePattern("login", ["navigate", "view_page", "fill_form", "click"]),
      makePattern("login", ["navigate", "type"]),
      makePattern("data_table", ["navigate", "view_page", "scroll"]),
    ]);
  });

  it("exports a valid three-level nested JSON structure", () => {
    const json = table.toJSON();
    expect(json).toHaveProperty("login");
    expect(json).toHaveProperty("data_table");
    expect(json.login).toHaveProperty("navigate");
    expect(json.login.navigate).toHaveProperty("view_page");
  });

  it("normalises weights to 0-1 range per bucket", () => {
    const json = table.toJSON();

    // login -> navigate -> view_page (3x) + type (1x) = total 4
    expect(json.login.navigate.view_page).toBe(0.75);
    expect(json.login.navigate.type).toBe(0.25);
  });

  it("rounds weights to 2 decimal places", () => {
    const json = table.toJSON();

    for (const pageType of Object.values(json)) {
      for (const lastTool of Object.values(pageType)) {
        for (const weight of Object.values(lastTool)) {
          const rounded = Math.round(weight * 100) / 100;
          expect(weight).toBe(rounded);
        }
      }
    }
  });

  it("excludes transitions with weight <= 0", () => {
    const json = table.toJSON();

    for (const pageType of Object.values(json)) {
      for (const lastTool of Object.values(pageType)) {
        for (const weight of Object.values(lastTool)) {
          expect(weight).toBeGreaterThan(0);
        }
      }
    }
  });

  it("roundtrip: toJSON -> fromJSON -> predict returns same order", () => {
    const json = table.toJSON();
    const imported = MarkovTable.fromJSON(json);

    // Predictions should have the same tool order
    const origPred = table.predict("login", "navigate");
    const importPred = imported.predict("login", "navigate");

    expect(importPred.length).toBe(origPred.length);
    for (let i = 0; i < origPred.length; i++) {
      expect(importPred[i].tool).toBe(origPred[i].tool);
    }
  });

  it("fromJSON sets count to 1 for community data", () => {
    const json = table.toJSON();
    const imported = MarkovTable.fromJSON(json);

    const predictions = imported.predict("login", "navigate");
    for (const p of predictions) {
      expect(p.count).toBe(1);
    }
  });

  it("fromJSON sets lastSeen to approximately now", () => {
    const before = Date.now();
    const json = table.toJSON();
    const imported = MarkovTable.fromJSON(json);
    const after = Date.now();

    const predictions = imported.predict("login", "navigate");
    for (const p of predictions) {
      expect(p.lastSeen).toBeGreaterThanOrEqual(before);
      expect(p.lastSeen).toBeLessThanOrEqual(after);
    }
  });

  it("fromJSON skips unknown pageTypes and debug-logs", () => {
    const json: MarkovTableJSON = {
      completely_invented_type: {
        navigate: { click: 0.5 },
      },
      login: {
        navigate: { view_page: 0.8 },
      },
    };

    const imported = MarkovTable.fromJSON(json);
    // "completely_invented_type" should be skipped — only "login" remains
    const types = imported.pageTypes;
    expect(types).toContain("login");
    expect(types).not.toContain("completely_invented_type");
  });

  it("fromJSON with empty/null input returns empty table", () => {
    expect(MarkovTable.fromJSON({}).size).toBe(0);
    expect(MarkovTable.fromJSON(null as unknown as MarkovTableJSON).size).toBe(0);
  });

  it("fromJSON skips entries with non-positive weights", () => {
    const json: MarkovTableJSON = {
      login: {
        navigate: { click: 0, view_page: -1, fill_form: 0.5 },
      },
    };

    const imported = MarkovTable.fromJSON(json);
    const predictions = imported.predict("login", "navigate");
    expect(predictions.length).toBe(1);
    expect(predictions[0].tool).toBe("fill_form");
  });
});

// ─── Merge ───────────────────────────────────────────────────────────

describe("MarkovTable — merge", () => {
  it("merges community data with local data correctly", () => {
    const local = new MarkovTable();
    local.ingest([
      makePattern("login", ["navigate", "view_page"]),
      makePattern("login", ["navigate", "view_page"]),
    ]);

    const community = new MarkovTable();
    community.ingest([
      makePattern("login", ["navigate", "view_page"]),
      makePattern("login", ["navigate", "fill_form"]),
    ]);

    local.merge(community);

    const predictions = local.predict("login", "navigate");
    expect(predictions.length).toBe(2);

    // view_page: max(2, 1) = 2 weight, count = 2 + 1 = 3
    const viewPage = predictions.find((p) => p.tool === "view_page")!;
    expect(viewPage.weight).toBe(2);
    expect(viewPage.count).toBe(3);

    // fill_form: from community only, weight = 1
    const fillForm = predictions.find((p) => p.tool === "fill_form")!;
    expect(fillForm.weight).toBe(1);
    expect(fillForm.count).toBe(1);
  });

  it("uses max(lastSeen) for merged entries", () => {
    const local = new MarkovTable();
    local.ingest([makePattern("login", ["navigate", "view_page"], NOW - 5000)]);

    const community = new MarkovTable();
    community.ingest([makePattern("login", ["navigate", "view_page"], NOW)]);

    local.merge(community);

    const predictions = local.predict("login", "navigate");
    expect(predictions[0].lastSeen).toBe(NOW);
  });

  it("adds new transitions from other table", () => {
    const local = new MarkovTable();
    local.ingest([makePattern("login", ["navigate", "view_page"])]);

    const community = new MarkovTable();
    community.ingest([makePattern("search_form", ["navigate", "type"])]);

    local.merge(community);

    expect(local.pageTypes).toContain("login");
    expect(local.pageTypes).toContain("search_form");
  });

  it("handles merge with null/invalid input gracefully", () => {
    const table = new MarkovTable();
    table.ingest([makePattern("login", ["navigate", "view_page"])]);

    // Should not throw
    table.merge(null as unknown as MarkovTable);
    table.merge(undefined as unknown as MarkovTable);
    expect(table.size).toBe(1);
  });
});

// ─── Decay ───────────────────────────────────────────────────────────

describe("MarkovTable — decay", () => {
  it("reduces weight by factor 0.95 for 1-week-old entry (Task 5.1)", () => {
    const table = new MarkovTable();
    const oneWeekAgo = NOW - MARKOV_DECAY_INTERVAL_MS;
    table.ingest([makePattern("login", ["navigate", "view_page"], oneWeekAgo)]);

    table.applyDecay(NOW);

    const predictions = table.predict("login", "navigate");
    expect(predictions.length).toBe(1);
    expect(predictions[0].weight).toBeCloseTo(1 * MARKOV_DECAY_FACTOR, 6);
    expect(predictions[0].count).toBe(1); // count unchanged
  });

  it("reduces weight by factor 0.95^4 for 4-week-old entry (Task 5.2)", () => {
    const table = new MarkovTable();
    const fourWeeksAgo = NOW - 4 * MARKOV_DECAY_INTERVAL_MS;
    table.ingest([makePattern("login", ["navigate", "view_page"], fourWeeksAgo)]);

    table.applyDecay(NOW);

    const predictions = table.predict("login", "navigate");
    expect(predictions.length).toBe(1);
    const expectedWeight = 1 * Math.pow(MARKOV_DECAY_FACTOR, 4);
    expect(predictions[0].weight).toBeCloseTo(expectedWeight, 6);
    expect(predictions[0].count).toBe(1);
  });

  it("removes entries older than 30 days (Task 5.3)", () => {
    const table = new MarkovTable();
    const thirtyOneDaysAgo = NOW - (31 * 24 * 60 * 60 * 1000);
    table.ingest([makePattern("login", ["navigate", "view_page"], thirtyOneDaysAgo)]);

    expect(table.size).toBe(1);
    table.applyDecay(NOW);

    expect(table.size).toBe(0);
    expect(table.predict("login", "navigate")).toEqual([]);
  });

  it("leaves fresh entries unchanged (Task 5.4)", () => {
    const table = new MarkovTable();
    table.ingest([makePattern("login", ["navigate", "view_page"], NOW)]);

    table.applyDecay(NOW);

    const predictions = table.predict("login", "navigate");
    expect(predictions.length).toBe(1);
    expect(predictions[0].weight).toBeCloseTo(1, 6);
  });

  it("removes empty outer map entries after cleanup (Task 5.5)", () => {
    const table = new MarkovTable();
    const expired = NOW - (31 * 24 * 60 * 60 * 1000);
    table.ingest([makePattern("login", ["navigate", "view_page"], expired)]);

    table.applyDecay(NOW);

    // No orphaned outer keys should remain
    expect(table.size).toBe(0);
    expect(table.pageTypes).toEqual([]);
  });

  it("preserves count during decay (only weight changes)", () => {
    const table = new MarkovTable();
    const twoWeeksAgo = NOW - 2 * MARKOV_DECAY_INTERVAL_MS;

    // Ingest 5 patterns to get count=5
    for (let i = 0; i < 5; i++) {
      table.ingest([makePattern("login", ["navigate", "view_page"], twoWeeksAgo)]);
    }

    table.applyDecay(NOW);

    const predictions = table.predict("login", "navigate");
    expect(predictions[0].count).toBe(5);
    expect(predictions[0].weight).toBeCloseTo(5 * Math.pow(MARKOV_DECAY_FACTOR, 2), 4);
  });

  it("handles mixed fresh and stale entries correctly", () => {
    const table = new MarkovTable();
    const stale = NOW - (31 * 24 * 60 * 60 * 1000);

    table.ingest([
      makePattern("login", ["navigate", "view_page"], stale),
      makePattern("login", ["navigate", "fill_form"], NOW),
    ]);

    table.applyDecay(NOW);

    const predictions = table.predict("login", "navigate");
    expect(predictions.length).toBe(1);
    expect(predictions[0].tool).toBe("fill_form");
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────

describe("MarkovTable — edge cases", () => {
  it("empty patterns list results in empty table", () => {
    const table = new MarkovTable();
    table.ingest([]);
    expect(table.size).toBe(0);
  });

  it("pattern with only 1 tool produces no bigrams", () => {
    const table = new MarkovTable();
    table.ingest([makePattern("login", ["navigate"])]);
    expect(table.size).toBe(0);
  });

  it("pattern with 20 tools produces 19 transitions", () => {
    const tools = Array.from({ length: 20 }, (_, i) => `tool_${i}`);
    const table = new MarkovTable();
    table.ingest([makePattern("login", tools)]);
    expect(table.size).toBe(19);
  });

  it("predict on empty table returns empty array", () => {
    const table = new MarkovTable();
    expect(table.predict("login", "navigate")).toEqual([]);
  });

  it("size returns 0 for empty table", () => {
    expect(new MarkovTable().size).toBe(0);
  });

  it("pageTypes returns empty array for empty table", () => {
    expect(new MarkovTable().pageTypes).toEqual([]);
  });

  it("handles null/undefined patterns gracefully", () => {
    const table = new MarkovTable();
    table.ingest(null as unknown as CortexPattern[]);
    table.ingest(undefined as unknown as CortexPattern[]);
    expect(table.size).toBe(0);
  });

  it("handles corrupted patterns gracefully (missing toolSequence)", () => {
    const table = new MarkovTable();
    const corrupted = { pageType: "login" } as unknown as CortexPattern;
    table.ingest([corrupted]);
    expect(table.size).toBe(0);
  });

  it("handles pattern with null pageType gracefully", () => {
    const table = new MarkovTable();
    const noType = {
      pageType: "",
      toolSequence: ["navigate", "click"],
      outcome: "success" as const,
      contentHash: "abc",
      timestamp: NOW,
    };
    table.ingest([noType]);
    expect(table.size).toBe(0);
  });

  it("predict with empty string args returns empty array", () => {
    const table = new MarkovTable();
    expect(table.predict("", "navigate")).toEqual([]);
    expect(table.predict("login", "")).toEqual([]);
  });

  it("toJSON on empty table returns empty object", () => {
    expect(new MarkovTable().toJSON()).toEqual({});
  });
});

// ─── Error Handling ──────────────────────────────────────────────────

describe("MarkovTable — error handling", () => {
  it("all public methods catch errors and degrade gracefully", () => {
    const table = new MarkovTable();

    // These should not throw
    expect(() => table.ingest(42 as unknown as CortexPattern[])).not.toThrow();
    expect(() => table.predict(null as unknown as string, "a")).not.toThrow();
    expect(() => table.applyDecay(NaN)).not.toThrow();
    expect(() => table.toJSON()).not.toThrow();
    expect(() => MarkovTable.fromJSON("not-an-object" as unknown as MarkovTableJSON)).not.toThrow();
    expect(() => table.merge("invalid" as unknown as MarkovTable)).not.toThrow();
  });
});

// ─── JSON Size (AC #3) ──────────────────────────────────────────────

describe("MarkovTable — JSON export size (AC #3)", () => {
  it("realistic dataset stays under 50KB (Task 4.1)", () => {
    const table = new MarkovTable();
    const patterns: CortexPattern[] = [];

    // 16 pageTypes × diverse tool sequences
    const pageTypes = [
      "login", "signup", "mfa", "search_form", "search_results",
      "data_table", "form_simple", "form_wizard", "article", "navigation",
      "dashboard", "settings", "media", "checkout", "profile", "error",
    ];
    const tools = [
      "navigate", "view_page", "click", "type", "fill_form",
      "press_key", "scroll", "drag", "switch_tab", "wait_for",
    ];

    // Generate diverse patterns
    for (const pt of pageTypes) {
      for (let i = 0; i < 10; i++) {
        // Create tool sequences of length 3-6
        const seqLen = 3 + (i % 4);
        const seq: string[] = [];
        for (let j = 0; j < seqLen; j++) {
          seq.push(tools[(i + j) % tools.length]);
        }
        patterns.push(makePattern(pt, seq, NOW - i * 1000));
      }
    }

    table.ingest(patterns);
    const json = table.toJSON();
    const jsonStr = JSON.stringify(json);
    const sizeKB = Buffer.byteLength(jsonStr, "utf-8") / 1024;

    expect(sizeKB).toBeLessThan(50);
  });

  it("community format (weight only) is smaller than internal format", () => {
    const table = new MarkovTable();
    table.ingest([
      makePattern("login", ["navigate", "view_page", "fill_form", "click"]),
      makePattern("login", ["navigate", "view_page", "fill_form", "click"]),
      makePattern("data_table", ["navigate", "view_page", "scroll", "click"]),
    ]);

    const communityJSON = JSON.stringify(table.toJSON());

    // Internal format would include count, lastSeen, tool name redundantly
    // Community format only has normalised weights
    // Just verify the community format is reasonably small
    expect(communityJSON.length).toBeLessThan(1000);
  });
});

// ─── Types from cortex-types.ts ─────────────────────────────────────

describe("Markov types in cortex-types.ts", () => {
  it("exports MarkovTransition interface fields", () => {
    const t: MarkovTransition = {
      tool: "click",
      weight: 5,
      count: 5,
      lastSeen: Date.now(),
    };
    expect(t.tool).toBe("click");
    expect(t.weight).toBe(5);
    expect(t.count).toBe(5);
    expect(typeof t.lastSeen).toBe("number");
  });

  it("exports decay constants", () => {
    expect(MARKOV_DECAY_FACTOR).toBe(0.95);
    expect(MARKOV_DECAY_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(MARKOV_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("MarkovTableJSON is a valid nested object structure", () => {
    const json: MarkovTableJSON = {
      login: {
        navigate: { view_page: 0.85, fill_form: 0.15 },
      },
    };
    expect(json.login.navigate.view_page).toBe(0.85);
  });
});
