/**
 * Fallback Log Unit Tests (Story 19.9, Task 7)
 *
 * Tests the Fallback-Logbuch: Zod-Schema privacy enforcement, Ringpuffer
 * FIFO semantics, harvest/exportAnonymousPatterns aggregation, entry builder,
 * and pattern fingerprint determinism.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FallbackLog,
  RING_BUFFER_CAPACITY,
  FINGERPRINT_TOP_N,
  computePatternFingerprint,
  buildFallbackLogEntry,
  fallbackLog,
} from "./fallback-log.js";
import { FallbackLogEntrySchema, SIGNAL_FORMAT_REGEX } from "./fallback-log-types.js";
import type {
  FallbackLogEntry,
  SignalProfile,
} from "./fallback-log-types.js";
import type { ExtractionResult, Signal } from "../scan/signal-types.js";
import type { MatchResult } from "../scan/match-types.js";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeSignalProfile(overrides: Partial<SignalProfile> = {}): SignalProfile {
  return {
    signal: "role:form",
    type: "role",
    weight: 0.9,
    count: 1,
    ...overrides,
  };
}

function makeValidEntry(overrides: Partial<FallbackLogEntry> = {}): FallbackLogEntry {
  return {
    timestamp: Date.now(),
    signals: [
      makeSignalProfile(),
      makeSignalProfile({ signal: "type:password", type: "attribute", weight: 0.8 }),
    ],
    matchResults: [
      {
        cardId: "login-form",
        cardName: "Login Form",
        score: 0.3,
        threshold: 0.6,
        matched: false,
        signal_breakdown: [
          { signal: "role:form", weight: 0.9, matched: true, found_count: 1 },
          { signal: "autocomplete:username", weight: 0.8, matched: false, found_count: 0 },
        ],
        counter_signal_checks: [
          { signal: "role:search", level: "required", found: false, action_taken: "clear" },
        ],
      },
    ],
    extraction: {
      nodeCount: 10,
      signalCount: 5,
      extractionTimeMs: 12.5,
    },
    patternFingerprint: "abc123",
    schema_version: "1",
    source: "fallback-observation",
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    signals: [
      { type: "role", signal: "role:form", nodeId: "n-1", weight: 0.9, count: 1 },
      { type: "attribute", signal: "type:password", nodeId: "n-2", weight: 0.8, count: 1 },
      { type: "attribute", signal: "autocomplete:username", nodeId: "n-3", weight: 0.7 },
    ] as Signal[],
    metadata: {
      nodeCount: 10,
      signalCount: 3,
      extractionTimeMs: 15.2,
    },
    ...overrides,
  };
}

function makeMatchResults(): MatchResult[] {
  return [
    {
      cardId: "login-form",
      cardName: "Login Form",
      matched: false,
      score: 0.35,
      threshold: 0.6,
      signal_breakdown: [
        { signal: "role:form", weight: 0.9, matched: true, found_count: 1 },
        { signal: "autocomplete:username", weight: 0.8, matched: true, found_count: 1 },
      ],
      counter_signal_checks: [
        { signal: "role:search", level: "required" as const, found: false, action_taken: "clear" as const },
      ],
      schema_version: "1",
      source: "scan",
    },
  ];
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("fallback-log", () => {
  let log: FallbackLog;

  beforeEach(() => {
    log = new FallbackLog();
    fallbackLog.clear();
  });

  // -----------------------------------------------------------------------
  // Zod Schema Validation (Task 7, Subtask 7.1 – 7.4)
  // -----------------------------------------------------------------------

  // Subtask 7.1: Schema validates correct entry
  it("FallbackLogEntrySchema validates a correct entry", () => {
    const entry = makeValidEntry();
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // Subtask 7.2: Schema rejects URL in signal field (Privacy NFR9)
  it("FallbackLogEntrySchema rejects entry with URL in signal field", () => {
    const entry = makeValidEntry({
      signals: [makeSignalProfile({ signal: "https://example.com" })],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // Subtask 7.3: Schema rejects content string in signal field
  it("FallbackLogEntrySchema rejects entry with content string in signal field", () => {
    const entry = makeValidEntry({
      signals: [makeSignalProfile({ signal: "Willkommen bei unserem Portal" })],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // Additional: Schema rejects email in signal field (PII)
  it("FallbackLogEntrySchema rejects entry with email in signal field", () => {
    const entry = makeValidEntry({
      signals: [makeSignalProfile({ signal: "user@email.com" })],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // Subtask 7.4: Schema rejects entry without schema_version
  it("FallbackLogEntrySchema rejects entry without schema_version", () => {
    const entry = makeValidEntry();
    const broken = { ...entry } as Record<string, unknown>;
    delete broken.schema_version;
    const result = FallbackLogEntrySchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  // Subtask 7.4: Schema rejects entry without source
  it("FallbackLogEntrySchema rejects entry without source", () => {
    const entry = makeValidEntry();
    const broken = { ...entry } as Record<string, unknown>;
    delete broken.source;
    const result = FallbackLogEntrySchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  // Schema rejects wrong schema_version value
  it("FallbackLogEntrySchema rejects wrong schema_version", () => {
    const entry = makeValidEntry();
    const broken = { ...entry, schema_version: "2" };
    const result = FallbackLogEntrySchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  // Schema rejects wrong source value
  it("FallbackLogEntrySchema rejects wrong source", () => {
    const entry = makeValidEntry();
    const broken = { ...entry, source: "manual" };
    const result = FallbackLogEntrySchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  // H1/M1: Schema rejects URL in signal_breakdown[].signal (Privacy NFR9)
  it("FallbackLogEntrySchema rejects URL in signal_breakdown[].signal", () => {
    const entry = makeValidEntry({
      matchResults: [
        {
          cardId: "login-form",
          cardName: "Login Form",
          score: 0.3,
          threshold: 0.6,
          matched: false,
          signal_breakdown: [
            { signal: "https://example.com/login", weight: 0.9, matched: true, found_count: 1 },
          ],
          counter_signal_checks: [],
        },
      ],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // H1/M1: Schema rejects content string in signal_breakdown[].signal
  it("FallbackLogEntrySchema rejects content string in signal_breakdown[].signal", () => {
    const entry = makeValidEntry({
      matchResults: [
        {
          cardId: "login-form",
          cardName: "Login Form",
          score: 0.3,
          threshold: 0.6,
          matched: false,
          signal_breakdown: [
            { signal: "Welcome to our portal", weight: 0.9, matched: true, found_count: 1 },
          ],
          counter_signal_checks: [],
        },
      ],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // H1/M1: Schema rejects URL in counter_signal_checks[].signal
  it("FallbackLogEntrySchema rejects URL in counter_signal_checks[].signal", () => {
    const entry = makeValidEntry({
      matchResults: [
        {
          cardId: "login-form",
          cardName: "Login Form",
          score: 0.3,
          threshold: 0.6,
          matched: false,
          signal_breakdown: [
            { signal: "role:form", weight: 0.9, matched: true, found_count: 1 },
          ],
          counter_signal_checks: [
            { signal: "https://malicious.com", level: "required", found: false, action_taken: "clear" },
          ],
        },
      ],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // H1/M1: Schema rejects PII in counter_signal_checks[].signal
  it("FallbackLogEntrySchema rejects PII in counter_signal_checks[].signal", () => {
    const entry = makeValidEntry({
      matchResults: [
        {
          cardId: "login-form",
          cardName: "Login Form",
          score: 0.3,
          threshold: 0.6,
          matched: false,
          signal_breakdown: [
            { signal: "role:form", weight: 0.9, matched: true, found_count: 1 },
          ],
          counter_signal_checks: [
            { signal: "user@email.com", level: "required", found: false, action_taken: "clear" },
          ],
        },
      ],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(false);
  });

  // H1/M1: Schema accepts valid prefix:value signals in signal_breakdown and counter_signal_checks
  it("FallbackLogEntrySchema accepts valid prefix:value signals in signal_breakdown and counter_signal_checks", () => {
    const entry = makeValidEntry({
      matchResults: [
        {
          cardId: "login-form",
          cardName: "Login Form",
          score: 0.3,
          threshold: 0.6,
          matched: false,
          signal_breakdown: [
            { signal: "role:form", weight: 0.9, matched: true, found_count: 1 },
            { signal: "autocomplete:username", weight: 0.8, matched: false, found_count: 0 },
          ],
          counter_signal_checks: [
            { signal: "role:search", level: "required", found: false, action_taken: "clear" },
          ],
        },
      ],
    });
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // SIGNAL_FORMAT_REGEX is exported for external consumers
  it("SIGNAL_FORMAT_REGEX is exported and functional", () => {
    expect(SIGNAL_FORMAT_REGEX.test("role:form")).toBe(true);
    expect(SIGNAL_FORMAT_REGEX.test("https://example.com")).toBe(false);
    expect(SIGNAL_FORMAT_REGEX.test("user@email.com")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Ringpuffer (Task 7, Subtask 7.5 – 7.7, 7.15)
  // -----------------------------------------------------------------------

  // Subtask 7.5: record() adds entry, getEntries() returns it
  it("record() adds entry, getEntries() returns it", () => {
    const entry = makeValidEntry();
    log.record(entry);
    const entries = log.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  // Subtask 7.6: After 50 entries, size() === 50
  it("after 50 entries, size() === 50", () => {
    for (let i = 0; i < 50; i++) {
      log.record(makeValidEntry({ timestamp: 1000 + i }));
    }
    expect(log.size()).toBe(50);
  });

  // Subtask 7.7: After 51 entries, size() is still 50 and oldest is overwritten
  it("after 51 entries, size() is still 50 and oldest entry is overwritten", () => {
    for (let i = 0; i < 51; i++) {
      log.record(makeValidEntry({ timestamp: 1000 + i }));
    }
    expect(log.size()).toBe(50);

    const entries = log.getEntries();
    expect(entries).toHaveLength(50);
    // Oldest (timestamp 1000) should be overwritten — first entry should be 1001
    expect(entries[0]!.timestamp).toBe(1001);
    // Last entry should be 1050
    expect(entries[entries.length - 1]!.timestamp).toBe(1050);
  });

  // Subtask 7.15: clear() resets buffer to 0
  it("clear() resets ringpuffer to 0 entries", () => {
    log.record(makeValidEntry());
    log.record(makeValidEntry({ timestamp: Date.now() + 1 }));
    expect(log.size()).toBe(2);

    log.clear();
    expect(log.size()).toBe(0);
    expect(log.getEntries()).toHaveLength(0);
  });

  // getEntries() returns entries in chronological order
  it("getEntries() returns entries in chronological order", () => {
    for (let i = 0; i < 5; i++) {
      log.record(makeValidEntry({ timestamp: 1000 + i }));
    }
    const entries = log.getEntries();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.timestamp).toBeGreaterThan(entries[i - 1]!.timestamp);
    }
  });

  // getEntries() returns correct order after wraparound
  it("getEntries() returns correct order after ring-buffer wraparound", () => {
    for (let i = 0; i < 53; i++) {
      log.record(makeValidEntry({ timestamp: 1000 + i }));
    }
    const entries = log.getEntries();
    expect(entries).toHaveLength(50);
    // Should be entries 3..52 (timestamps 1003..1052)
    expect(entries[0]!.timestamp).toBe(1003);
    expect(entries[49]!.timestamp).toBe(1052);
  });

  // record() silently rejects invalid entry (no throw)
  it("record() silently rejects invalid entry (does not throw)", () => {
    const invalid = { ...makeValidEntry(), schema_version: "BAD" } as unknown as FallbackLogEntry;
    expect(() => log.record(invalid)).not.toThrow();
    expect(log.size()).toBe(0);
  });

  // M3: record() deep-clones entry to prevent external mutation
  it("record() deep-clones entry — external mutation does not affect stored data", () => {
    const entry = makeValidEntry({ timestamp: 42000 });
    log.record(entry);

    // Mutate the original entry after recording
    entry.timestamp = 99999;
    entry.signals[0]!.signal = "mutated:value";

    const stored = log.getEntries();
    expect(stored).toHaveLength(1);
    // Stored entry should retain original values
    expect(stored[0]!.timestamp).toBe(42000);
    expect(stored[0]!.signals[0]!.signal).toBe("role:form");
  });

  // -----------------------------------------------------------------------
  // harvest() / exportAnonymousPatterns() (Task 7, Subtask 7.8 – 7.10)
  // -----------------------------------------------------------------------

  // Subtask 7.8: harvest() aggregates entries with same fingerprint
  it("harvest() aggregates two entries with same patternFingerprint", () => {
    const fp = "samefp";
    log.record(makeValidEntry({ patternFingerprint: fp, timestamp: 1000 }));
    log.record(makeValidEntry({ patternFingerprint: fp, timestamp: 2000 }));

    const patterns = log.harvest();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.occurrenceCount).toBe(2);
    expect(patterns[0]!.firstSeen).toBe(1000);
    expect(patterns[0]!.lastSeen).toBe(2000);
    expect(patterns[0]!.schema_version).toBe("1");
    expect(patterns[0]!.source).toBe("fallback-observation");
  });

  // Subtask 7.9: harvest() returns different patterns for different fingerprints
  it("harvest() returns different patterns for different fingerprints", () => {
    log.record(makeValidEntry({ patternFingerprint: "fp-a", timestamp: 1000 }));
    log.record(makeValidEntry({ patternFingerprint: "fp-b", timestamp: 2000 }));

    const patterns = log.harvest();
    expect(patterns).toHaveLength(2);
    const fps = patterns.map(p => p.patternFingerprint).sort();
    expect(fps).toEqual(["fp-a", "fp-b"]);
  });

  // Subtask 7.10: exportAnonymousPatterns() returns same as harvest()
  it("exportAnonymousPatterns() returns same result as harvest()", () => {
    log.record(makeValidEntry({ patternFingerprint: "fp-x", timestamp: 1000 }));
    log.record(makeValidEntry({ patternFingerprint: "fp-x", timestamp: 2000 }));
    log.record(makeValidEntry({ patternFingerprint: "fp-y", timestamp: 3000 }));

    const harvest = log.harvest();
    const exported = log.exportAnonymousPatterns();
    expect(exported).toEqual(harvest);
  });

  // harvest() on empty log returns empty array
  it("harvest() on empty log returns empty array", () => {
    expect(log.harvest()).toEqual([]);
  });

  // harvest() includes scoreDistribution
  it("harvest() pattern includes scoreDistribution from representative entry", () => {
    log.record(makeValidEntry());
    const patterns = log.harvest();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.scoreDistribution).toBeDefined();
    expect(patterns[0]!.scoreDistribution.length).toBeGreaterThan(0);
    expect(patterns[0]!.scoreDistribution[0]!.cardId).toBe("login-form");
  });

  // M2: harvest() correctly averages scoreDistribution across group entries
  it("harvest() averages scoreDistribution across entries with same fingerprint", () => {
    const fp = "same-fp";
    // Entry 1: login-form score 0.2
    log.record(makeValidEntry({
      patternFingerprint: fp,
      timestamp: 1000,
      matchResults: [{
        cardId: "login-form",
        cardName: "Login Form",
        score: 0.2,
        threshold: 0.6,
        matched: false,
        signal_breakdown: [{ signal: "role:form", weight: 0.9, matched: true, found_count: 1 }],
        counter_signal_checks: [],
      }],
    }));
    // Entry 2: login-form score 0.4
    log.record(makeValidEntry({
      patternFingerprint: fp,
      timestamp: 2000,
      matchResults: [{
        cardId: "login-form",
        cardName: "Login Form",
        score: 0.4,
        threshold: 0.6,
        matched: false,
        signal_breakdown: [{ signal: "role:form", weight: 0.9, matched: true, found_count: 1 }],
        counter_signal_checks: [],
      }],
    }));

    const patterns = log.harvest();
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.scoreDistribution).toHaveLength(1);
    // Average of 0.2 and 0.4 = 0.3
    expect(patterns[0]!.scoreDistribution[0]!.cardId).toBe("login-form");
    expect(patterns[0]!.scoreDistribution[0]!.score).toBeCloseTo(0.3);
  });

  // M2: harvest() aggregates signalProfile across group entries (averages weights, sums counts)
  it("harvest() aggregates signalProfile across entries with same fingerprint", () => {
    const fp = "same-fp";
    log.record(makeValidEntry({
      patternFingerprint: fp,
      timestamp: 1000,
      signals: [
        makeSignalProfile({ signal: "role:form", weight: 0.8, count: 1 }),
        makeSignalProfile({ signal: "type:password", type: "attribute", weight: 0.6, count: 2 }),
      ],
    }));
    log.record(makeValidEntry({
      patternFingerprint: fp,
      timestamp: 2000,
      signals: [
        makeSignalProfile({ signal: "role:form", weight: 1.0, count: 3 }),
        makeSignalProfile({ signal: "type:password", type: "attribute", weight: 0.4, count: 1 }),
      ],
    }));

    const patterns = log.harvest();
    expect(patterns).toHaveLength(1);

    const roleForm = patterns[0]!.signalProfile.find(s => s.signal === "role:form");
    expect(roleForm).toBeDefined();
    // Average of 0.8 and 1.0 = 0.9
    expect(roleForm!.weight).toBeCloseTo(0.9);
    // Sum of 1 and 3 = 4
    expect(roleForm!.count).toBe(4);

    const typePassword = patterns[0]!.signalProfile.find(s => s.signal === "type:password");
    expect(typePassword).toBeDefined();
    // Average of 0.6 and 0.4 = 0.5
    expect(typePassword!.weight).toBeCloseTo(0.5);
    // Sum of 2 and 1 = 3
    expect(typePassword!.count).toBe(3);
  });

  // -----------------------------------------------------------------------
  // buildFallbackLogEntry() (Task 7, Subtask 7.11 – 7.12)
  // -----------------------------------------------------------------------

  // Subtask 7.11: buildFallbackLogEntry sets schema_version and source
  it("buildFallbackLogEntry() sets schema_version: '1' and source: 'fallback-observation'", () => {
    const entry = buildFallbackLogEntry(makeExtraction(), makeMatchResults());
    expect(entry.schema_version).toBe("1");
    expect(entry.source).toBe("fallback-observation");
  });

  // Subtask 7.12: buildFallbackLogEntry does not include nodeId in SignalProfile
  it("buildFallbackLogEntry() does not include nodeId in SignalProfile (privacy)", () => {
    const extraction = makeExtraction();
    // Verify source signals have nodeId
    expect(extraction.signals[0]!.nodeId).toBeDefined();

    const entry = buildFallbackLogEntry(extraction, makeMatchResults());

    // Verify output signals do NOT have nodeId
    for (const sp of entry.signals) {
      expect(sp).not.toHaveProperty("nodeId");
    }
  });

  // buildFallbackLogEntry maps extraction metadata correctly
  it("buildFallbackLogEntry() maps extraction metadata correctly", () => {
    const extraction = makeExtraction();
    const entry = buildFallbackLogEntry(extraction, makeMatchResults());

    expect(entry.extraction.nodeCount).toBe(extraction.metadata.nodeCount);
    expect(entry.extraction.signalCount).toBe(extraction.metadata.signalCount);
    expect(entry.extraction.extractionTimeMs).toBe(extraction.metadata.extractionTimeMs);
  });

  // buildFallbackLogEntry maps matchResults to FallbackMatchSummary
  it("buildFallbackLogEntry() maps matchResults to FallbackMatchSummary", () => {
    const entry = buildFallbackLogEntry(makeExtraction(), makeMatchResults());

    expect(entry.matchResults).toHaveLength(1);
    expect(entry.matchResults[0]!.cardId).toBe("login-form");
    expect(entry.matchResults[0]!.matched).toBe(false);
    expect(entry.matchResults[0]!.signal_breakdown.length).toBeGreaterThan(0);
    expect(entry.matchResults[0]!.counter_signal_checks.length).toBeGreaterThan(0);
  });

  // buildFallbackLogEntry produces a valid entry (passes Zod)
  it("buildFallbackLogEntry() produces a Zod-valid entry", () => {
    const entry = buildFallbackLogEntry(makeExtraction(), makeMatchResults());
    const result = FallbackLogEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // buildFallbackLogEntry sets timestamp
  it("buildFallbackLogEntry() sets timestamp near Date.now()", () => {
    const before = Date.now();
    const entry = buildFallbackLogEntry(makeExtraction(), makeMatchResults());
    const after = Date.now();
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
  });

  // buildFallbackLogEntry handles signal without count (default to 1)
  it("buildFallbackLogEntry() defaults signal count to 1 when not provided", () => {
    const extraction = makeExtraction({
      signals: [
        { type: "role", signal: "role:form", nodeId: "n-1", weight: 0.9 } as Signal,
      ],
    });
    const entry = buildFallbackLogEntry(extraction, makeMatchResults());
    expect(entry.signals[0]!.count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // computePatternFingerprint() (Task 7, Subtask 7.13 – 7.14)
  // -----------------------------------------------------------------------

  // Subtask 7.13: Deterministic — same signals → same hash
  it("computePatternFingerprint() is deterministic", () => {
    const signals = [
      makeSignalProfile({ signal: "role:form", weight: 0.9 }),
      makeSignalProfile({ signal: "type:password", weight: 0.8 }),
    ];
    const fp1 = computePatternFingerprint(signals);
    const fp2 = computePatternFingerprint(signals);
    expect(fp1).toBe(fp2);
  });

  // Subtask 7.14: Stable with different input order (sorts internally)
  it("computePatternFingerprint() is stable with different input order", () => {
    const signals1 = [
      makeSignalProfile({ signal: "role:form", weight: 0.9 }),
      makeSignalProfile({ signal: "type:password", weight: 0.8 }),
    ];
    const signals2 = [
      makeSignalProfile({ signal: "type:password", weight: 0.8 }),
      makeSignalProfile({ signal: "role:form", weight: 0.9 }),
    ];
    expect(computePatternFingerprint(signals1)).toBe(computePatternFingerprint(signals2));
  });

  // Different signals → different hash
  it("computePatternFingerprint() produces different hashes for different signals", () => {
    const signals1 = [makeSignalProfile({ signal: "role:form", weight: 0.9 })];
    const signals2 = [makeSignalProfile({ signal: "role:search", weight: 0.9 })];
    expect(computePatternFingerprint(signals1)).not.toBe(computePatternFingerprint(signals2));
  });

  // Fingerprint returns non-empty string
  it("computePatternFingerprint() returns non-empty string", () => {
    const fp = computePatternFingerprint([makeSignalProfile()]);
    expect(fp.length).toBeGreaterThan(0);
  });

  // Fingerprint uses top-N only
  it("computePatternFingerprint() only considers top-N signals", () => {
    // Create N+5 signals
    const base: SignalProfile[] = [];
    for (let i = 0; i < FINGERPRINT_TOP_N + 5; i++) {
      base.push(makeSignalProfile({
        signal: `type:sig-${String(i).padStart(3, "0")}`,
        weight: 1 - i * 0.01,
      }));
    }

    // Same top-N with different low-weight signals should produce same hash
    const withExtra = [...base];
    withExtra.push(makeSignalProfile({ signal: "type:extra-low", weight: 0.001 }));

    expect(computePatternFingerprint(base)).toBe(computePatternFingerprint(withExtra));
  });

  // -----------------------------------------------------------------------
  // Constants (AC-5, Invariante 5)
  // -----------------------------------------------------------------------

  it("RING_BUFFER_CAPACITY is 50", () => {
    expect(RING_BUFFER_CAPACITY).toBe(50);
  });

  it("FINGERPRINT_TOP_N is 10", () => {
    expect(FINGERPRINT_TOP_N).toBe(10);
  });

  // -----------------------------------------------------------------------
  // Singleton Instance
  // -----------------------------------------------------------------------

  it("fallbackLog singleton is a FallbackLog instance", () => {
    expect(fallbackLog).toBeInstanceOf(FallbackLog);
  });
});
