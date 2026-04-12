/**
 * Match Types — shared type definitions for the Aggregator and Matcher.
 *
 * Used by: aggregator.ts, matcher.ts, and downstream consumers (Story 19.5+).
 *
 * Module Boundary: This file imports from ./signal-types.ts only.
 * It does NOT import from src/cards/ — instead it defines a slim
 * `CardForMatching` interface that mirrors the Card fields the Matcher needs.
 * The caller passes Card objects that satisfy this interface.
 */

import type { Signal, SignalType } from "./signal-types.js";

// ---------------------------------------------------------------------------
// Card Interface for Matching (Module-Boundary-safe)
// ---------------------------------------------------------------------------

/**
 * Slim interface covering only the Card fields the Matcher needs.
 * Avoids importing from src/cards/ (Architecture boundary).
 * The caller (src/operator/) passes full Card objects that satisfy this shape.
 */
export interface CardForMatching {
  id: string;
  name: string;
  structureSignature: { signal: string; weight: number }[];
  counterSignals: { signal: string; level: "required" | "strong" | "soft" }[];
}

// ---------------------------------------------------------------------------
// Signal Breakdown (AC-1, AC-2)
// ---------------------------------------------------------------------------

/**
 * One entry per card structure_signature signal — documents whether
 * it was found in the extracted signals and how often.
 */
export interface SignalBreakdownEntry {
  /** The signal string from the card's structureSignature (e.g. "role:form") */
  signal: string;
  /** Weight assigned to this signal in the card definition */
  weight: number;
  /** Whether this signal was found in the extracted signal list */
  matched: boolean;
  /** Number of times this signal appeared in the extraction (from Signal.count, default 1) */
  found_count: number;
}

// ---------------------------------------------------------------------------
// Counter-Signal Check (AC-3)
// ---------------------------------------------------------------------------

/**
 * One entry per card counter_signal — documents whether it was found
 * and what action the Matcher took.
 */
export interface CounterSignalCheck {
  /** The counter-signal string (e.g. "role:search") */
  signal: string;
  /** Severity level from the card definition */
  level: "required" | "strong" | "soft";
  /** Whether this counter-signal was found in the extracted signal list */
  found: boolean;
  /** Action the Matcher took: "veto" (required match), "penalty_applied" (strong/soft), "clear" (not found) */
  action_taken: "veto" | "penalty_applied" | "clear";
}

// ---------------------------------------------------------------------------
// Match Result (AC-1, Invariante 3, Invariante 6)
// ---------------------------------------------------------------------------

/**
 * Complete audit object returned by matchCard() — always fully populated,
 * even for non-matches (Invariante 3: Audit-First).
 */
export interface MatchResult {
  /** Card id from the matched card */
  cardId: string;
  /** Human-readable card name */
  cardName: string;
  /** Whether the card matched (score >= threshold AND no required-veto) */
  matched: boolean;
  /** Computed score 0–1 (weighted sum of matched signals / total weight) */
  score: number;
  /** The threshold used for the match decision */
  threshold: number;
  /** Per-signal breakdown showing which card signals were found */
  signal_breakdown: SignalBreakdownEntry[];
  /** Per-counter-signal audit showing veto/penalty/clear actions */
  counter_signal_checks: CounterSignalCheck[];
  /** Schema version for forward-compatibility (Invariante 6) */
  schema_version: string;
  /** Signal source identifier for forward-compatibility (Invariante 6) */
  source: string;
}

// ---------------------------------------------------------------------------
// Aggregated Cluster (AC-4)
// ---------------------------------------------------------------------------

/**
 * A group of signals clustered by DOM proximity (same nodeId or parent-child).
 * The Matcher can match cards against individual clusters to detect
 * multiple card instances on a single page (FR6).
 */
export interface AggregatedCluster {
  /** Set of nodeIds that belong to this cluster */
  nodeIds: string[];
  /** All signals assigned to this cluster (no duplicates, no losses) */
  signals: Signal[];
  /** The most frequently occurring signal types in this cluster */
  dominantTypes: SignalType[];
}
