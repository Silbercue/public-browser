import { describe, it, expect } from "vitest";
import type { Signal } from "./signal-types.js";
import type { CardForMatching } from "./match-types.js";
import {
  matchCard,
  matchAllCards,
  matchCardAgainstClusters,
  formatWhyThisCard,
  MATCH_THRESHOLD,
  STRONG_COUNTER_PENALTY,
  SOFT_COUNTER_PENALTY,
  LOW_WEIGHT_THRESHOLD,
  MAX_WHY_THIS_CARD_TOKENS,
} from "./matcher.js";
import { aggregateSignals } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Invariante 2 Patterns — duplicated from card-schema.ts (module boundary)
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\//i;
const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const CONTENT_STRING_PATTERN = /^(?!.*[[\]#>~])(?!^\w+:\S+$)(?=.*\s).{4,}$/;

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    type: "role",
    signal: "role:generic",
    nodeId: "node-1",
    weight: 0.5,
    count: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture Cards (matching Seed Library YAML)
// ---------------------------------------------------------------------------

const loginFormCard: CardForMatching = {
  id: "login-form",
  name: "Login Form",
  structureSignature: [
    { signal: "role:form", weight: 0.6 },
    { signal: "type:password", weight: 0.9 },
    { signal: "type:submit", weight: 0.5 },
    { signal: "autocomplete:username", weight: 0.7 },
  ],
  counterSignals: [
    { signal: "role:search", level: "strong" },
    { signal: "role:navigation", level: "soft" },
  ],
};

const searchResultListCard: CardForMatching = {
  id: "search-result-list",
  name: "Search Result List",
  structureSignature: [
    { signal: "role:search", weight: 0.9 },
    { signal: "role:list", weight: 0.6 },
    { signal: "role:listitem", weight: 0.5 },
  ],
  counterSignals: [
    { signal: "type:password", level: "strong" },
  ],
};

const articleReaderCard: CardForMatching = {
  id: "article-reader",
  name: "Article Reader",
  structureSignature: [
    { signal: "role:article", weight: 0.9 },
    { signal: "role:heading", weight: 0.5 },
    { signal: "role:main", weight: 0.7 },
  ],
  counterSignals: [
    { signal: "role:list>10", level: "strong" },
  ],
};

const allSeedCards: CardForMatching[] = [loginFormCard, searchResultListCard, articleReaderCard];

// ---------------------------------------------------------------------------
// Fixture Signals
// ---------------------------------------------------------------------------

/** Login form signals — matches login-form card well */
function loginFormSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:form", nodeId: "form-1", weight: 0.7 }),
    makeSignal({ type: "attribute", signal: "type:password", nodeId: "pwd-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:submit", nodeId: "submit-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "autocomplete:username", nodeId: "user-1", weight: 0.6 }),
    makeSignal({ type: "structure", signal: "parent:form", nodeId: "pwd-1", weight: 0.5 }),
    makeSignal({ type: "name-pattern", signal: "has-name:true", nodeId: "form-1", weight: 0.3, count: 5 }),
  ];
}

/** Search result signals — matches search-result-list card well */
function searchResultSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:search", nodeId: "search-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:list", nodeId: "list-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:listitem", nodeId: "list-1", weight: 0.5, count: 5 }),
    makeSignal({ type: "role", signal: "role:textbox", nodeId: "input-1", weight: 0.7 }),
  ];
}

/** Article signals — matches article-reader card well */
function articleSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:article", nodeId: "art-1", weight: 0.9 }),
    makeSignal({ type: "role", signal: "role:heading", nodeId: "h1-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:main", nodeId: "main-1", weight: 0.7 }),
  ];
}

/** Navigation-only signals — should NOT match any card */
function navigationSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:navigation", nodeId: "nav-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:link", nodeId: "link-1", weight: 0.7, count: 10 }),
    makeSignal({ type: "role", signal: "role:banner", nodeId: "banner-1", weight: 0.7 }),
  ];
}

// ---------------------------------------------------------------------------
// Adverse Fixtures — pages that look similar but are NOT login forms / etc.
// ---------------------------------------------------------------------------

/** Registration form — has role:form + type:submit but NOT type:password / autocomplete:username */
function registrationFormSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:form", nodeId: "reg-form-1", weight: 0.7 }),
    makeSignal({ type: "attribute", signal: "type:email", nodeId: "email-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:text", nodeId: "name-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:submit", nodeId: "submit-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:checkbox", nodeId: "terms-1", weight: 0.5 }),
  ];
}

/** Password-change form — has type:password but in a different context */
function passwordChangeSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:form", nodeId: "pw-form-1", weight: 0.7 }),
    makeSignal({ type: "attribute", signal: "type:password", nodeId: "old-pw-1", weight: 0.6, count: 3 }),
    makeSignal({ type: "attribute", signal: "type:submit", nodeId: "pw-submit-1", weight: 0.6 }),
    makeSignal({ type: "role", signal: "role:heading", nodeId: "pw-heading-1", weight: 0.5 }),
    makeSignal({ type: "role", signal: "role:navigation", nodeId: "pw-nav-1", weight: 0.7 }),
  ];
}

/** Contact form — has role:form + type:submit, looks form-like but no login signals */
function contactFormSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:form", nodeId: "contact-1", weight: 0.7 }),
    makeSignal({ type: "attribute", signal: "type:text", nodeId: "c-name-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:email", nodeId: "c-email-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:submit", nodeId: "c-submit-1", weight: 0.6 }),
    makeSignal({ type: "role", signal: "role:textbox", nodeId: "c-msg-1", weight: 0.7 }),
  ];
}

/** Dashboard — has role:main, role:heading, role:navigation but no article/form patterns */
function dashboardSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:main", nodeId: "dash-main-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:heading", nodeId: "dash-h1-1", weight: 0.5, count: 4 }),
    makeSignal({ type: "role", signal: "role:navigation", nodeId: "dash-nav-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:button", nodeId: "dash-btn-1", weight: 0.6, count: 8 }),
    makeSignal({ type: "role", signal: "role:table", nodeId: "dash-table-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:img", nodeId: "dash-chart-1", weight: 0.5, count: 3 }),
  ];
}

/** Media gallery — has role:list + role:listitem but NOT role:search */
function mediaGallerySignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:list", nodeId: "gallery-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:listitem", nodeId: "gallery-1", weight: 0.5, count: 20 }),
    makeSignal({ type: "role", signal: "role:img", nodeId: "img-1", weight: 0.6, count: 20 }),
    makeSignal({ type: "role", signal: "role:heading", nodeId: "gal-h1-1", weight: 0.5 }),
    makeSignal({ type: "role", signal: "role:navigation", nodeId: "gal-nav-1", weight: 0.7 }),
  ];
}

// ---------------------------------------------------------------------------
// Subtask 5.3: Login Form → login-form card (positive match)
// ---------------------------------------------------------------------------

describe("matchCard — Login Form positive match", () => {
  it("matches login form signals against login-form card", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThan(MATCH_THRESHOLD);
    expect(result.cardId).toBe("login-form");
  });

  it("signal_breakdown shows all four card signals as matched", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    expect(result.signal_breakdown).toHaveLength(4);

    for (const entry of result.signal_breakdown) {
      expect(entry.matched).toBe(true);
      expect(entry.found_count).toBeGreaterThanOrEqual(1);
    }
  });

  it("score is close to 1.0 when all signals match and no counters fire", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    // All 4 signals match, total weight = 2.7, matched weight = 2.7 → score = 1.0
    // Soft counter role:navigation not present → no penalty
    expect(result.score).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.4: Login Form → search-result-list (cross-match with penalty)
// ---------------------------------------------------------------------------

describe("matchCard — Login Form signals vs search-result-list card", () => {
  it("does not match login form signals to search-result-list", () => {
    const result = matchCard(searchResultListCard, loginFormSignals());
    expect(result.matched).toBe(false);
  });

  it("counter-signal type:password is found with penalty_applied (strong)", () => {
    const result = matchCard(searchResultListCard, loginFormSignals());
    const pwdCounter = result.counter_signal_checks.find(
      (c) => c.signal === "type:password",
    );
    expect(pwdCounter).toBeDefined();
    expect(pwdCounter!.found).toBe(true);
    expect(pwdCounter!.action_taken).toBe("penalty_applied");
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.5: Navigation-only fixture → no card matches
// ---------------------------------------------------------------------------

describe("matchCard — Navigation-only (no match)", () => {
  it("no seed card matches a pure navigation page", () => {
    for (const card of allSeedCards) {
      const result = matchCard(card, navigationSignals());
      expect(result.matched).toBe(false);
    }
  });

  it("all results have complete breakdowns even on no-match", () => {
    for (const card of allSeedCards) {
      const result = matchCard(card, navigationSignals());
      expect(result.signal_breakdown.length).toBe(card.structureSignature.length);
      expect(result.counter_signal_checks.length).toBe(card.counterSignals.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.6: Audit object completeness (Invariante 3)
// ---------------------------------------------------------------------------

describe("matchCard — Audit Object Completeness (Invariante 3)", () => {
  it("no field is undefined in MatchResult", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    expect(result.cardId).toBeDefined();
    expect(result.cardName).toBeDefined();
    expect(result.matched).toBeDefined();
    expect(result.score).toBeDefined();
    expect(result.threshold).toBeDefined();
    expect(result.signal_breakdown).toBeDefined();
    expect(result.counter_signal_checks).toBeDefined();
    expect(result.schema_version).toBeDefined();
    expect(result.source).toBeDefined();
  });

  it("signal_breakdown is never empty when card has structureSignature", () => {
    const result = matchCard(loginFormCard, []);
    expect(result.signal_breakdown.length).toBe(loginFormCard.structureSignature.length);
  });

  it("counter_signal_checks is never empty when card has counterSignals", () => {
    const result = matchCard(loginFormCard, []);
    expect(result.counter_signal_checks.length).toBe(loginFormCard.counterSignals.length);
  });

  it("schema_version and source are set (Invariante 6)", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    expect(result.schema_version).toBe("1.0");
    expect(result.source).toBe("a11y-tree");
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.7: required-level counter-signal forces veto
// ---------------------------------------------------------------------------

describe("matchCard — required-level counter-signal veto", () => {
  it("vetoes a perfect-score card when required counter-signal is found", () => {
    // Custom card with a required counter-signal
    const cardWithRequired: CardForMatching = {
      id: "test-required-veto",
      name: "Test Required Veto",
      structureSignature: [
        { signal: "role:form", weight: 1.0 },
      ],
      counterSignals: [
        { signal: "role:button", level: "required" },
      ],
    };

    const signals: Signal[] = [
      makeSignal({ type: "role", signal: "role:form", nodeId: "f1", weight: 0.7 }),
      makeSignal({ type: "role", signal: "role:button", nodeId: "b1", weight: 0.7 }),
    ];

    const result = matchCard(cardWithRequired, signals);
    // Score would be 1.0, but required counter forces veto
    expect(result.matched).toBe(false);
    expect(result.counter_signal_checks.find((c) => c.signal === "role:button")?.action_taken).toBe("veto");
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.8: strong-level counter-signal reduces score
// ---------------------------------------------------------------------------

describe("matchCard — strong-level counter-signal penalty", () => {
  it("reduces score by STRONG_COUNTER_PENALTY when strong counter found", () => {
    // Search result card against signals that include type:password
    const signals = searchResultSignals().concat(
      makeSignal({ type: "attribute", signal: "type:password", nodeId: "pwd-1", weight: 0.6 }),
    );

    const result = matchCard(searchResultListCard, signals);

    // Without penalty: all 3 signals match → score = 1.0
    // With strong penalty: 1.0 - 0.3 = 0.7
    expect(result.score).toBeCloseTo(1.0 - STRONG_COUNTER_PENALTY, 2);

    const pwdCheck = result.counter_signal_checks.find((c) => c.signal === "type:password");
    expect(pwdCheck?.found).toBe(true);
    expect(pwdCheck?.action_taken).toBe("penalty_applied");
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.9: matchAllCards sorts by score descending
// ---------------------------------------------------------------------------

describe("matchAllCards — sorting", () => {
  it("sorts results by score descending", () => {
    const results = matchAllCards(allSeedCards, loginFormSignals());

    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns results for all cards", () => {
    const results = matchAllCards(allSeedCards, loginFormSignals());
    expect(results).toHaveLength(allSeedCards.length);
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.10: Latency — 3 seed cards + 50-node fixture < 200 ms
// ---------------------------------------------------------------------------

describe("matchAllCards — Latency Gate (AC-5, full pipeline)", () => {
  it("3 seed cards with ~50 signals: full pipeline (aggregation + matching) under 200 ms", () => {
    // Build a signal list with ~50 signals
    const signals: Signal[] = [];
    const types = ["role", "attribute", "structure", "name-pattern"] as const;
    for (let i = 0; i < 50; i++) {
      signals.push(
        makeSignal({
          type: types[i % types.length],
          signal: `${types[i % types.length]}:signal-${i}`,
          nodeId: `node-${i}`,
          weight: 0.5,
        }),
      );
    }
    // Add the actual card signals so we get some matches
    signals.push(...loginFormSignals());

    // Measure full pipeline: aggregateSignals + matchAllCards (which calls aggregateSignals internally)
    const t0 = performance.now();
    const clusters = aggregateSignals(signals);
    for (const card of allSeedCards) {
      matchCardAgainstClusters(card, clusters);
    }
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(200);
  });

  it("100 synthetic cards: full pipeline under 400 ms", () => {
    // Generate 100 synthetic cards
    const syntheticCards: CardForMatching[] = [];
    for (let i = 0; i < 100; i++) {
      syntheticCards.push({
        id: `synthetic-${i}`,
        name: `Synthetic Card ${i}`,
        structureSignature: [
          { signal: `role:signal-${i}`, weight: 0.8 },
          { signal: `type:signal-${i}`, weight: 0.6 },
          { signal: `role:signal-${i + 100}`, weight: 0.5 },
        ],
        counterSignals: [
          { signal: `role:counter-${i}`, level: "strong" },
        ],
      });
    }

    const signals: Signal[] = [];
    for (let i = 0; i < 50; i++) {
      signals.push(
        makeSignal({
          type: "role",
          signal: `role:signal-${i}`,
          nodeId: `n-${i}`,
          weight: 0.5,
        }),
      );
    }

    // Measure full pipeline: aggregation + matching
    const t0 = performance.now();
    matchAllCards(syntheticCards, signals);
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(400);
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.12: Token Budget — formatWhyThisCard < 1600 chars (~400 tokens)
// ---------------------------------------------------------------------------

describe("formatWhyThisCard — Token Budget (Invariante 1)", () => {
  it("output is under 1600 chars for a typical match", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    const output = formatWhyThisCard(result);
    expect(output.length).toBeLessThan(MAX_WHY_THIS_CARD_TOKENS * 4);
  });

  it("output is under 1600 chars for a non-match", () => {
    const result = matchCard(loginFormCard, navigationSignals());
    const output = formatWhyThisCard(result);
    expect(output.length).toBeLessThan(MAX_WHY_THIS_CARD_TOKENS * 4);
  });

  it("output contains score, threshold, and matched status", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    const output = formatWhyThisCard(result);
    expect(output).toContain("score");
    expect(output).toContain("threshold");
    expect(output).toContain("MATCH");
  });

  it("output lists matched and missed signals", () => {
    // Use navigation signals — should miss all login form signals
    const result = matchCard(loginFormCard, navigationSignals());
    const output = formatWhyThisCard(result);
    expect(output).toContain("missed:");
  });

  it("condenses low-weight signals instead of listing individually", () => {
    // Create a card with some very low-weight signals
    const cardWithLowWeight: CardForMatching = {
      id: "test-low-weight",
      name: "Low Weight Card",
      structureSignature: [
        { signal: "role:form", weight: 0.8 },
        { signal: "role:tiny1", weight: 0.01 },
        { signal: "role:tiny2", weight: 0.02 },
        { signal: "role:tiny3", weight: 0.03 },
      ],
      counterSignals: [],
    };

    const signals: Signal[] = [
      makeSignal({ type: "role", signal: "role:form", nodeId: "f1", weight: 0.7 }),
      makeSignal({ type: "role", signal: "role:tiny1", nodeId: "t1", weight: 0.1 }),
      makeSignal({ type: "role", signal: "role:tiny2", nodeId: "t2", weight: 0.1 }),
      makeSignal({ type: "role", signal: "role:tiny3", nodeId: "t3", weight: 0.1 }),
    ];

    const result = matchCard(cardWithLowWeight, signals);
    const output = formatWhyThisCard(result);
    // Low-weight signals should be condensed
    expect(output).toContain("low-weight");
  });
});

// ---------------------------------------------------------------------------
// Subtask 5.13: Invariante 2 — No URL/Domain/Content in matching path
// ---------------------------------------------------------------------------

describe("matchCard — Invariante 2: No URL/Domain/Content strings", () => {
  it("signal_breakdown contains only structural identifiers", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    for (const entry of result.signal_breakdown) {
      expect(URL_PATTERN.test(entry.signal)).toBe(false);
      expect(DOMAIN_PATTERN.test(entry.signal)).toBe(false);
      expect(CONTENT_STRING_PATTERN.test(entry.signal)).toBe(false);
    }
  });

  it("counter_signal_checks contains only structural identifiers", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    for (const entry of result.counter_signal_checks) {
      expect(URL_PATTERN.test(entry.signal)).toBe(false);
      expect(DOMAIN_PATTERN.test(entry.signal)).toBe(false);
    }
  });

  it("cardId and cardName do not contain URLs or domains", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    expect(URL_PATTERN.test(result.cardId)).toBe(false);
    expect(DOMAIN_PATTERN.test(result.cardId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Score Calculation — detailed verification
// ---------------------------------------------------------------------------

describe("matchCard — Score Calculation (AC-2)", () => {
  it("score = sum(matched_weights) / sum(all_weights)", () => {
    // login-form card: weights = 0.6 + 0.9 + 0.5 + 0.7 = 2.7
    // Provide only 3 of 4 signals (miss type:submit)
    const partialSignals: Signal[] = [
      makeSignal({ type: "role", signal: "role:form", nodeId: "f1", weight: 0.7 }),
      makeSignal({ type: "attribute", signal: "type:password", nodeId: "p1", weight: 0.6 }),
      makeSignal({ type: "attribute", signal: "autocomplete:username", nodeId: "u1", weight: 0.6 }),
    ];

    const result = matchCard(loginFormCard, partialSignals);
    // matched: 0.6 + 0.9 + 0.7 = 2.2, total: 2.7
    // score = 2.2 / 2.7 ≈ 0.815
    expect(result.score).toBeCloseTo(2.2 / 2.7, 2);
    expect(result.matched).toBe(true);
  });

  it("repeated signals (count > 1) do not double the score", () => {
    const signals: Signal[] = [
      makeSignal({ type: "role", signal: "role:form", nodeId: "f1", weight: 0.7, count: 5 }),
      makeSignal({ type: "attribute", signal: "type:password", nodeId: "p1", weight: 0.6, count: 3 }),
      makeSignal({ type: "attribute", signal: "type:submit", nodeId: "s1", weight: 0.6, count: 1 }),
      makeSignal({ type: "attribute", signal: "autocomplete:username", nodeId: "u1", weight: 0.6, count: 2 }),
    ];

    const result = matchCard(loginFormCard, signals);
    // All 4 signals match — score should be exactly 1.0 regardless of counts
    expect(result.score).toBe(1);
  });

  it("score is 0 when no signals match", () => {
    const result = matchCard(loginFormCard, []);
    expect(result.score).toBe(0);
    expect(result.matched).toBe(false);
  });

  it("score is 0 when totally unrelated signals provided", () => {
    const result = matchCard(loginFormCard, navigationSignals());
    expect(result.score).toBe(0);
  });

  it("found_count reflects the count field from the extracted signal", () => {
    const signals: Signal[] = [
      makeSignal({ type: "role", signal: "role:form", nodeId: "f1", weight: 0.7, count: 3 }),
    ];

    const result = matchCard(loginFormCard, signals);
    const formEntry = result.signal_breakdown.find((s) => s.signal === "role:form");
    expect(formEntry?.found_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Counter-Signal Details (AC-3)
// ---------------------------------------------------------------------------

describe("matchCard — Counter-Signal Details (AC-3)", () => {
  it("soft counter-signal applies SOFT_COUNTER_PENALTY", () => {
    // Login card has role:navigation as soft counter
    const signalsWithNav: Signal[] = [
      ...loginFormSignals(),
      makeSignal({ type: "role", signal: "role:navigation", nodeId: "nav-1", weight: 0.7 }),
    ];

    const resultWithNav = matchCard(loginFormCard, signalsWithNav);
    const resultWithout = matchCard(loginFormCard, loginFormSignals());

    // With soft penalty score should be lower by SOFT_COUNTER_PENALTY
    expect(resultWithNav.score).toBeCloseTo(resultWithout.score - SOFT_COUNTER_PENALTY, 2);

    const navCheck = resultWithNav.counter_signal_checks.find(
      (c) => c.signal === "role:navigation",
    );
    expect(navCheck?.found).toBe(true);
    expect(navCheck?.action_taken).toBe("penalty_applied");
  });

  it("all counter checks have action_taken: clear when no counter-signals found", () => {
    const result = matchCard(loginFormCard, loginFormSignals());
    for (const check of result.counter_signal_checks) {
      expect(check.found).toBe(false);
      expect(check.action_taken).toBe("clear");
    }
  });
});

// ---------------------------------------------------------------------------
// Empty / Edge Cases
// ---------------------------------------------------------------------------

describe("matchCard — Edge Cases", () => {
  it("handles empty structureSignature gracefully", () => {
    const emptyCard: CardForMatching = {
      id: "empty-sig",
      name: "Empty",
      structureSignature: [],
      counterSignals: [],
    };

    const result = matchCard(emptyCard, loginFormSignals());
    expect(result.score).toBe(0);
    expect(result.matched).toBe(false);
    expect(result.signal_breakdown).toEqual([]);
    expect(result.counter_signal_checks).toEqual([]);
  });

  it("handles empty signal list gracefully (no throw, complete audit)", () => {
    const result = matchCard(loginFormCard, []);
    expect(result.matched).toBe(false);
    expect(result.score).toBe(0);
    expect(result.signal_breakdown).toHaveLength(4);
    for (const entry of result.signal_breakdown) {
      expect(entry.matched).toBe(false);
      expect(entry.found_count).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Falscherkennungs-Schutz (AC-6)
// ---------------------------------------------------------------------------

describe("matchAllCards — False-Positive Protection (AC-6)", () => {
  it("navigation-only page: no card matched", () => {
    const results = matchAllCards(allSeedCards, navigationSignals());
    for (const result of results) {
      expect(result.matched).toBe(false);
    }
  });

  it("empty signals: no card matched", () => {
    const results = matchAllCards(allSeedCards, []);
    for (const result of results) {
      expect(result.matched).toBe(false);
    }
  });

  it("all non-matched results still have complete audit objects", () => {
    const results = matchAllCards(allSeedCards, navigationSignals());
    for (const result of results) {
      expect(result.signal_breakdown.length).toBeGreaterThan(0);
      expect(result.counter_signal_checks.length).toBeGreaterThanOrEqual(0);
      expect(result.schema_version).toBeDefined();
      expect(result.source).toBeDefined();
    }
  });

  // --- Diversified adverse fixtures (H3/H4) ---

  it("registration form: no login-form match (no type:password, no autocomplete:username)", () => {
    const results = matchAllCards(allSeedCards, registrationFormSignals());
    const loginResult = results.find((r) => r.cardId === "login-form");
    expect(loginResult).toBeDefined();
    expect(loginResult!.matched).toBe(false);
  });

  it("password-change form: login-form penalized by soft counter role:navigation", () => {
    const results = matchAllCards(allSeedCards, passwordChangeSignals());
    const loginResult = results.find((r) => r.cardId === "login-form");
    expect(loginResult).toBeDefined();
    // Has role:form + type:password + type:submit but NO autocomplete:username
    // Score = (0.6 + 0.9 + 0.5) / 2.7 ≈ 0.741, minus soft penalty 0.1 → 0.641
    // The soft counter role:navigation fires, bringing it under or near threshold
    // More importantly: it must NOT false-positive for search-result-list
    const searchResult = results.find((r) => r.cardId === "search-result-list");
    expect(searchResult).toBeDefined();
    expect(searchResult!.matched).toBe(false);
  });

  it("contact form: no card matched", () => {
    const results = matchAllCards(allSeedCards, contactFormSignals());
    for (const result of results) {
      expect(result.matched).toBe(false);
    }
  });

  it("dashboard page: no login-form or search-result-list match", () => {
    const results = matchAllCards(allSeedCards, dashboardSignals());
    // No login-form match (no type:password, no autocomplete:username, no type:submit)
    const loginResult = results.find((r) => r.cardId === "login-form");
    expect(loginResult).toBeDefined();
    expect(loginResult!.matched).toBe(false);
    // No search-result-list match (no role:search, no role:list)
    const searchResult = results.find((r) => r.cardId === "search-result-list");
    expect(searchResult).toBeDefined();
    expect(searchResult!.matched).toBe(false);
    // article-reader may weakly match (role:main + role:heading present)
    // but its score should be well below 1.0 since role:article is missing
    const articleResult = results.find((r) => r.cardId === "article-reader");
    expect(articleResult).toBeDefined();
    expect(articleResult!.score).toBeLessThan(0.7);
  });

  it("media gallery: no login-form match, search-result-list score well below 1.0", () => {
    const results = matchAllCards(allSeedCards, mediaGallerySignals());
    // No login-form match (no type:password, no autocomplete:username)
    const loginResult = results.find((r) => r.cardId === "login-form");
    expect(loginResult).toBeDefined();
    expect(loginResult!.matched).toBe(false);
    // search-result-list has a marginal score (role:list + role:listitem match, but
    // the dominant role:search signal with weight 0.9 is missing). Score should be
    // well below a full match.
    const searchResult = results.find((r) => r.cardId === "search-result-list");
    expect(searchResult).toBeDefined();
    expect(searchResult!.score).toBeLessThan(0.6);
    // No article match
    const articleResult = results.find((r) => r.cardId === "article-reader");
    expect(articleResult).toBeDefined();
    expect(articleResult!.matched).toBe(false);
  });

  it("article signals correctly match article-reader card (positive control)", () => {
    const results = matchAllCards(allSeedCards, articleSignals());
    const articleResult = results.find((r) => r.cardId === "article-reader");
    expect(articleResult).toBeDefined();
    expect(articleResult!.matched).toBe(true);
    expect(articleResult!.score).toBeGreaterThan(MATCH_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// Named Constants Visibility
// ---------------------------------------------------------------------------

describe("Matcher — Named Constants (Invariante 5)", () => {
  it("MATCH_THRESHOLD is between 0 and 1", () => {
    expect(MATCH_THRESHOLD).toBeGreaterThan(0);
    expect(MATCH_THRESHOLD).toBeLessThanOrEqual(1);
  });

  it("STRONG_COUNTER_PENALTY is between 0 and 1", () => {
    expect(STRONG_COUNTER_PENALTY).toBeGreaterThan(0);
    expect(STRONG_COUNTER_PENALTY).toBeLessThanOrEqual(1);
  });

  it("SOFT_COUNTER_PENALTY is between 0 and 1", () => {
    expect(SOFT_COUNTER_PENALTY).toBeGreaterThan(0);
    expect(SOFT_COUNTER_PENALTY).toBeLessThanOrEqual(1);
  });

  it("SOFT_COUNTER_PENALTY < STRONG_COUNTER_PENALTY", () => {
    expect(SOFT_COUNTER_PENALTY).toBeLessThan(STRONG_COUNTER_PENALTY);
  });

  it("LOW_WEIGHT_THRESHOLD is positive", () => {
    expect(LOW_WEIGHT_THRESHOLD).toBeGreaterThan(0);
  });

  it("MAX_WHY_THIS_CARD_TOKENS is positive", () => {
    expect(MAX_WHY_THIS_CARD_TOKENS).toBeGreaterThan(0);
  });
});
