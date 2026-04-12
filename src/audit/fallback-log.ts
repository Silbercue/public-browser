/**
 * Fallback Log — In-Memory-Ringpuffer fuer strukturelle Muster-Signaturen.
 *
 * Protokolliert jeden Fallback-Lauf (kein Karten-Match) mit dem vollstaendigen
 * Signal-Profil und allen MatchResults. Der Phase-2-Harvester (Epic 20) kann
 * ueber harvest()/exportAnonymousPatterns() anonyme Muster-Signaturen abgreifen.
 *
 * Privacy-by-Design (NFR9): Keine URLs, keine Content-Strings, keine PII —
 * nur strukturelle Signale im prefix:value-Format, erzwungen via Zod-Schema.
 *
 * Module Boundaries:
 *   - MAY import: src/scan/signal-types.ts (Signal, ExtractionResult)
 *   - MAY import: src/scan/match-types.ts (MatchResult)
 *   - MAY import: ./fallback-log-types.ts (own types)
 *   - MAY import: zod (via types)
 *   - MAY import: src/cdp/debug.ts (logging)
 *   - MUST NOT import: src/operator/, src/registry.ts, src/cards/
 */

import type { Signal, ExtractionResult } from "../scan/signal-types.js";
import type { MatchResult } from "../scan/match-types.js";
import type {
  FallbackLogEntry,
  FallbackPattern,
  SignalProfile,
  FallbackMatchSummary,
} from "./fallback-log-types.js";
import { FallbackLogEntrySchema } from "./fallback-log-types.js";
import { debug } from "../cdp/debug.js";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// ---------------------------------------------------------------------------

/**
 * Maximum number of Fallback-Log entries kept in memory.
 * Oldest entries are overwritten (FIFO) when the buffer is full.
 * @unit count
 */
export const RING_BUFFER_CAPACITY = 50;

/**
 * Number of top signals (by weight, descending) used for the pattern fingerprint.
 * Higher values → fewer collisions but less grouping. 10 is a pragmatic default.
 * @unit count
 */
export const FINGERPRINT_TOP_N = 10;

// ---------------------------------------------------------------------------
// Pattern Fingerprint (Task 3, AC-3)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic pattern fingerprint from a signal profile.
 *
 * Sorts signals by weight descending (stable), takes the top-N, concatenates
 * the signal strings, and produces a simple numeric hash string.
 * Same signals → same hash, regardless of input order.
 *
 * @param signals - Signal profile entries to fingerprint
 * @returns Deterministic hash string
 */
export function computePatternFingerprint(signals: SignalProfile[]): string {
  // Sort by weight descending, then alphabetically by signal for stability
  const sorted = [...signals].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.signal.localeCompare(b.signal);
  });

  const topN = sorted.slice(0, FINGERPRINT_TOP_N);
  const joined = topN.map(s => s.signal).join("|");

  // Simple string hash (djb2) — no crypto dependency needed for MVP grouping
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
  }

  // Return as hex string for readability
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Entry Builder (Task 4, AC-1, AC-2, AC-4)
// ---------------------------------------------------------------------------

/**
 * Build a FallbackLogEntry from extraction results and match results.
 *
 * Privacy: Maps Signal → SignalProfile, deliberately dropping `nodeId`
 * (which could leak DOM paths).
 *
 * Validates the result against FallbackLogEntrySchema before returning
 * (Privacy-by-Design enforcement).
 *
 * @param extraction - Full extraction result from signal-extractor
 * @param matchResults - All match results (should all be matched: false)
 * @returns Validated FallbackLogEntry
 * @throws ZodError if the entry violates the privacy schema
 */
export function buildFallbackLogEntry(
  extraction: ExtractionResult,
  matchResults: MatchResult[],
): FallbackLogEntry {
  // Map Signal → SignalProfile (drop nodeId for privacy)
  const signals: SignalProfile[] = extraction.signals.map((s: Signal) => ({
    signal: s.signal,
    type: s.type,
    weight: s.weight,
    count: s.count ?? 1,
  }));

  // Map MatchResult → FallbackMatchSummary (drop schema_version/source — those are on log level)
  const fallbackMatchResults: FallbackMatchSummary[] = matchResults.map(mr => ({
    cardId: mr.cardId,
    cardName: mr.cardName,
    score: mr.score,
    threshold: mr.threshold,
    matched: false as const,
    signal_breakdown: mr.signal_breakdown.map(sb => ({
      signal: sb.signal,
      weight: sb.weight,
      matched: sb.matched,
      found_count: sb.found_count,
    })),
    counter_signal_checks: mr.counter_signal_checks.map(cc => ({
      signal: cc.signal,
      level: cc.level,
      found: cc.found,
      action_taken: cc.action_taken,
    })),
  }));

  const patternFingerprint = computePatternFingerprint(signals);

  const entry: FallbackLogEntry = {
    timestamp: Date.now(),
    signals,
    matchResults: fallbackMatchResults,
    extraction: {
      nodeCount: extraction.metadata.nodeCount,
      signalCount: extraction.metadata.signalCount,
      extractionTimeMs: extraction.metadata.extractionTimeMs,
    },
    patternFingerprint,
    schema_version: "1",
    source: "fallback-observation",
  };

  // Privacy-by-Design enforcement — validate before returning
  FallbackLogEntrySchema.parse(entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Ringpuffer (Task 2, AC-1, AC-3, AC-5)
// ---------------------------------------------------------------------------

/**
 * In-Memory Ringpuffer for Fallback-Log entries.
 *
 * Keeps the last RING_BUFFER_CAPACITY entries (FIFO).
 * No persistence — purely in-memory for Phase 1.
 */
export class FallbackLog {
  private _entries: (FallbackLogEntry | null)[];
  private _writeIndex: number = 0;
  private _count: number = 0;

  constructor() {
    this._entries = new Array(RING_BUFFER_CAPACITY).fill(null);
  }

  /**
   * Record a new Fallback-Log entry.
   *
   * Validates via Zod-Schema, then writes at the current ring position.
   * On validation error, logs and swallows (Fallback-Log is an observer,
   * not a control-flow element — Invariante 4).
   */
  record(entry: FallbackLogEntry): void {
    try {
      FallbackLogEntrySchema.parse(entry);
    } catch (err) {
      debug("fallbackLog.record: Zod validation failed: %s", err instanceof Error ? err.message : String(err));
      return;
    }

    // Deep-clone to prevent external mutation of historical ring-buffer data (M3)
    this._entries[this._writeIndex] = JSON.parse(JSON.stringify(entry));
    this._writeIndex = (this._writeIndex + 1) % RING_BUFFER_CAPACITY;
    if (this._count < RING_BUFFER_CAPACITY) {
      this._count++;
    }
  }

  /**
   * Get all entries in chronological order (oldest first).
   */
  getEntries(): readonly FallbackLogEntry[] {
    if (this._count < RING_BUFFER_CAPACITY) {
      // Buffer not full yet — entries are 0..(_count-1) in order
      return this._entries.slice(0, this._count) as FallbackLogEntry[];
    }

    // Buffer full — oldest is at _writeIndex, wrap around
    const tail = this._entries.slice(this._writeIndex) as FallbackLogEntry[];
    const head = this._entries.slice(0, this._writeIndex) as FallbackLogEntry[];
    return [...tail, ...head];
  }

  /**
   * Harvest aggregated FallbackPatterns from the log.
   *
   * Groups entries by patternFingerprint, counts occurrences,
   * and returns deduplicated pattern signatures.
   */
  harvest(): FallbackPattern[] {
    const entries = this.getEntries();
    if (entries.length === 0) return [];

    const groups = new Map<string, FallbackLogEntry[]>();
    for (const entry of entries) {
      const key = entry.patternFingerprint;
      const group = groups.get(key);
      if (group) {
        group.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }

    const patterns: FallbackPattern[] = [];
    for (const [fingerprint, group] of groups) {
      const timestamps = group.map(e => e.timestamp);

      // Aggregate signalProfile: merge signals across all group entries,
      // averaging weights and summing counts for signals with the same key
      const signalMap = new Map<string, { type: SignalProfile["type"]; totalWeight: number; totalCount: number; entries: number }>();
      for (const entry of group) {
        for (const sp of entry.signals) {
          const existing = signalMap.get(sp.signal);
          if (existing) {
            existing.totalWeight += sp.weight;
            existing.totalCount += sp.count;
            existing.entries++;
          } else {
            signalMap.set(sp.signal, { type: sp.type, totalWeight: sp.weight, totalCount: sp.count, entries: 1 });
          }
        }
      }
      const aggregatedSignals: SignalProfile[] = [];
      for (const [signal, agg] of signalMap) {
        aggregatedSignals.push({
          signal,
          type: agg.type,
          weight: agg.totalWeight / agg.entries,
          count: agg.totalCount,
        });
      }
      // Sort by weight descending for consistency
      aggregatedSignals.sort((a, b) => b.weight - a.weight || a.signal.localeCompare(b.signal));

      // Aggregate scoreDistribution: average scores per cardId across all entries
      const scoreMap = new Map<string, { totalScore: number; entries: number }>();
      for (const entry of group) {
        for (const mr of entry.matchResults) {
          const existing = scoreMap.get(mr.cardId);
          if (existing) {
            existing.totalScore += mr.score;
            existing.entries++;
          } else {
            scoreMap.set(mr.cardId, { totalScore: mr.score, entries: 1 });
          }
        }
      }
      const aggregatedScores: { cardId: string; score: number }[] = [];
      for (const [cardId, agg] of scoreMap) {
        aggregatedScores.push({ cardId, score: agg.totalScore / agg.entries });
      }

      patterns.push({
        patternFingerprint: fingerprint,
        signalProfile: aggregatedSignals,
        scoreDistribution: aggregatedScores,
        occurrenceCount: group.length,
        firstSeen: Math.min(...timestamps),
        lastSeen: Math.max(...timestamps),
        schema_version: "1",
        source: "fallback-observation",
      });
    }

    return patterns;
  }

  /**
   * Phase-2-Bridge interface — alias for harvest().
   * Defined as the external contract for the Phase-2-Harvester (Epic 20).
   */
  exportAnonymousPatterns(): FallbackPattern[] {
    return this.harvest();
  }

  /**
   * Current number of entries in the buffer (max RING_BUFFER_CAPACITY).
   */
  size(): number {
    return this._count;
  }

  /**
   * Reset the ring buffer (for tests).
   */
  clear(): void {
    this._entries = new Array(RING_BUFFER_CAPACITY).fill(null);
    this._writeIndex = 0;
    this._count = 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton Instance (Subtask 2.10)
// ---------------------------------------------------------------------------

/**
 * Global FallbackLog instance — used by the operator-tool via dependency injection.
 * Persists across operator calls within the same process.
 */
export const fallbackLog = new FallbackLog();
