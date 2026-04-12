/**
 * Fallback Log Types — type definitions and Zod schemas for the Fallback-Logbuch.
 *
 * Privacy-by-Design (NFR9): The `signal` field is restricted to the prefix:value
 * format via Zod regex — no URLs, no content strings, no PII can be stored.
 *
 * Module Boundaries:
 *   - MAY import: src/scan/signal-types.ts (SignalType)
 *   - MAY import: zod
 *   - MUST NOT import: src/operator/, src/registry.ts, src/cdp/, src/cards/
 */

import { z } from "zod";
import type { SignalType } from "../scan/signal-types.js";

// ---------------------------------------------------------------------------
// Privacy-Enforcement Regex (NFR9, AC-2)
// ---------------------------------------------------------------------------

/**
 * Regex for the signal field: enforces prefix:value format.
 * Allows: role:form, type:password, autocomplete:username, has-name:true,
 *         siblings:listitem:5, name-pattern:label
 * Blocks: https://example.com, user@email.com, free-text content strings
 */
export const SIGNAL_FORMAT_REGEX = /^[a-z][a-z0-9-]*:[a-z0-9._:-]+$/i;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * A structural signal profile entry — privacy-safe (no nodeId, no content).
 * Only structural identifiers in prefix:value format.
 */
export interface SignalProfile {
  /** Structural identifier in prefix:value format (e.g. "role:form") */
  signal: string;
  /** Signal category */
  type: SignalType;
  /** Base confidence weight 0-1 */
  weight: number;
  /** Number of occurrences after deduplication (default: 1) */
  count: number;
}

/**
 * Summary of a match attempt against a single card — always fully populated
 * (Invariante 3: Audit-First), even for non-matches.
 */
export interface FallbackMatchSummary {
  /** Card id */
  cardId: string;
  /** Human-readable card name */
  cardName: string;
  /** Computed score 0-1 */
  score: number;
  /** The threshold used for the match decision */
  threshold: number;
  /** Always false in Fallback context */
  matched: false;
  /** Per-signal breakdown showing which card signals were found */
  signal_breakdown: { signal: string; weight: number; matched: boolean; found_count: number }[];
  /** Per-counter-signal audit showing veto/penalty/clear actions */
  counter_signal_checks: { signal: string; level: "required" | "strong" | "soft"; found: boolean; action_taken: "veto" | "penalty_applied" | "clear" }[];
}

/**
 * Extraction metadata — node and signal counts plus timing.
 */
export interface ExtractionSummary {
  /** Total number of AXNodes processed */
  nodeCount: number;
  /** Number of signals after deduplication */
  signalCount: number;
  /** Wall-clock extraction time in milliseconds */
  extractionTimeMs: number;
}

/**
 * A single Fallback-Log entry — structural record of a no-match scan.
 * Contains the complete signal profile and all match results for audit
 * (Invariante 3, Invariante 6).
 */
export interface FallbackLogEntry {
  /** Unix timestamp (ms) when the fallback was recorded */
  timestamp: number;
  /** Structural signal profile of the page (privacy-safe, no nodeId) */
  signals: SignalProfile[];
  /** Match results against all cards (all matched: false) */
  matchResults: FallbackMatchSummary[];
  /** Extraction metadata */
  extraction: ExtractionSummary;
  /** Deterministic hash over the top-N signals for pattern grouping */
  patternFingerprint: string;
  /** Schema version for forward-compatibility (Invariante 6) */
  schema_version: "1";
  /** Signal source identifier (Invariante 6) */
  source: "fallback-observation";
}

/**
 * Aggregated Fallback pattern — deduplicated by patternFingerprint.
 * Returned by harvest()/exportAnonymousPatterns() for Phase-2 consumption.
 */
export interface FallbackPattern {
  /** Deterministic hash over the top-N signals */
  patternFingerprint: string;
  /** Aggregated signal profile */
  signalProfile: SignalProfile[];
  /** Score distribution against all cards */
  scoreDistribution: { cardId: string; score: number }[];
  /** Number of times this pattern was observed */
  occurrenceCount: number;
  /** First observation timestamp (ms) */
  firstSeen: number;
  /** Last observation timestamp (ms) */
  lastSeen: number;
  /** Schema version for forward-compatibility (Invariante 6) */
  schema_version: "1";
  /** Signal source identifier (Invariante 6) */
  source: "fallback-observation";
}

// ---------------------------------------------------------------------------
// Zod Schemas — Privacy-by-Design Enforcement (AC-2)
// ---------------------------------------------------------------------------

const SignalProfileSchema = z.object({
  signal: z.string().regex(SIGNAL_FORMAT_REGEX, "Signal must be in prefix:value format — no URLs, no content strings"),
  type: z.enum(["role", "attribute", "structure", "name-pattern"]),
  weight: z.number().min(0).max(1),
  count: z.number().int().min(1),
});

const FallbackMatchSummarySchema = z.object({
  cardId: z.string().min(1),
  cardName: z.string().min(1),
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  matched: z.literal(false),
  signal_breakdown: z.array(z.object({
    signal: z.string().regex(SIGNAL_FORMAT_REGEX, "Signal must be in prefix:value format — no URLs, no content strings"),
    weight: z.number(),
    matched: z.boolean(),
    found_count: z.number().int().min(0),
  })),
  counter_signal_checks: z.array(z.object({
    signal: z.string().regex(SIGNAL_FORMAT_REGEX, "Signal must be in prefix:value format — no URLs, no content strings"),
    level: z.enum(["required", "strong", "soft"]),
    found: z.boolean(),
    action_taken: z.enum(["veto", "penalty_applied", "clear"]),
  })),
});

const ExtractionSummarySchema = z.object({
  nodeCount: z.number().int().min(0),
  signalCount: z.number().int().min(0),
  extractionTimeMs: z.number().min(0),
});

/**
 * Zod schema for FallbackLogEntry — enforces Privacy-by-Design structurally.
 * The signal regex prevents URLs, content strings, and PII from entering the log.
 */
export const FallbackLogEntrySchema = z.object({
  timestamp: z.number().int().min(0),
  signals: z.array(SignalProfileSchema),
  matchResults: z.array(FallbackMatchSummarySchema),
  extraction: ExtractionSummarySchema,
  patternFingerprint: z.string().min(1),
  schema_version: z.literal("1"),
  source: z.literal("fallback-observation"),
});
