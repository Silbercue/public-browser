/**
 * Card Matcher — third layer of the Scan-Match-Pipeline.
 *
 * Compares extracted signals against card structure signatures,
 * applies counter-signal checks, and produces a complete audit
 * object (MatchResult) for every card — even non-matches (Invariante 3).
 *
 * The why_this_card formatter is co-located here because "the audit
 * originates exactly where the decision is made" (Architecture).
 *
 * Module Boundaries:
 *   - MAY import: ./signal-types.ts, ./match-types.ts
 *   - MUST NOT import: src/operator/, src/cards/, src/audit/, src/tools/
 */

import type { Signal } from "./signal-types.js";
import type {
  CardForMatching,
  AggregatedCluster,
  MatchResult,
  SignalBreakdownEntry,
  CounterSignalCheck,
} from "./match-types.js";
import { aggregateSignals } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// ---------------------------------------------------------------------------

/**
 * Score threshold for a positive match.
 * Cards with score >= MATCH_THRESHOLD (and no required-veto) are matched.
 * @calibration Start value 0.5, to be tuned via benchmark.
 */
export const MATCH_THRESHOLD = 0.5;

/**
 * Score penalty applied when a `strong`-level counter-signal is found.
 */
export const STRONG_COUNTER_PENALTY = 0.3;

/**
 * Score penalty applied when a `soft`-level counter-signal is found.
 */
export const SOFT_COUNTER_PENALTY = 0.1;

/**
 * Signals with weight below this threshold are condensed into a
 * summary line in formatWhyThisCard() output (not listed individually).
 */
export const LOW_WEIGHT_THRESHOLD = 0.05;

/**
 * Maximum token budget for the why_this_card output (~4 chars/token).
 * Test asserts: formatWhyThisCard() output < MAX_WHY_THIS_CARD_TOKENS * 4 chars.
 */
export const MAX_WHY_THIS_CARD_TOKENS = 400;

/**
 * Schema version for forward-compatibility (Invariante 6).
 */
const RESULT_SCHEMA_VERSION = "1.0";

/**
 * Signal source identifier for forward-compatibility (Invariante 6).
 */
const RESULT_SOURCE = "a11y-tree";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Match a single card against an extracted signal list.
 *
 * ALWAYS returns a complete MatchResult — never null, never throws
 * (Invariante 3: Audit-First).
 *
 * @param card - Card to match (only structureSignature + counterSignals needed)
 * @param signals - Flat signal list from extractSignals()
 * @returns Complete audit object with score, breakdown, and counter checks
 */
export function matchCard(card: CardForMatching, signals: Signal[]): MatchResult {
  // Build a lookup map: signal string → Signal (for O(1) lookups)
  const signalMap = new Map<string, Signal>();
  for (const sig of signals) {
    // Keep the first occurrence (highest weight due to sort order)
    if (!signalMap.has(sig.signal)) {
      signalMap.set(sig.signal, sig);
    }
  }

  // --- Score Calculation (AC-2) ---
  const signalBreakdown: SignalBreakdownEntry[] = [];
  let matchedWeight = 0;
  let totalWeight = 0;

  for (const cardSig of card.structureSignature) {
    totalWeight += cardSig.weight;
    const found = signalMap.get(cardSig.signal);

    signalBreakdown.push({
      signal: cardSig.signal,
      weight: cardSig.weight,
      matched: found !== undefined,
      found_count: found !== undefined ? (found.count ?? 1) : 0,
    });

    if (found !== undefined) {
      matchedWeight += cardSig.weight;
    }
  }

  // Normalize score to 0–1 (guard against zero total weight)
  let score = totalWeight > 0 ? matchedWeight / totalWeight : 0;

  // --- Counter-Signal Checks (AC-3) ---
  const counterChecks: CounterSignalCheck[] = [];
  let vetoed = false;

  for (const counter of card.counterSignals) {
    const found = signalMap.has(counter.signal);

    if (!found) {
      counterChecks.push({
        signal: counter.signal,
        level: counter.level,
        found: false,
        action_taken: "clear",
      });
      continue;
    }

    // Counter-signal found — apply action based on level
    if (counter.level === "required") {
      vetoed = true;
      counterChecks.push({
        signal: counter.signal,
        level: counter.level,
        found: true,
        action_taken: "veto",
      });
    } else if (counter.level === "strong") {
      score = Math.max(0, score - STRONG_COUNTER_PENALTY);
      counterChecks.push({
        signal: counter.signal,
        level: counter.level,
        found: true,
        action_taken: "penalty_applied",
      });
    } else {
      // soft
      score = Math.max(0, score - SOFT_COUNTER_PENALTY);
      counterChecks.push({
        signal: counter.signal,
        level: counter.level,
        found: true,
        action_taken: "penalty_applied",
      });
    }
  }

  // --- Round before decision so visible score matches the decision (M3) ---
  score = Math.round(score * 1000) / 1000; // 3 decimal precision

  // --- Match Decision ---
  const matched = !vetoed && score >= MATCH_THRESHOLD;

  return {
    cardId: card.id,
    cardName: card.name,
    matched,
    score,
    threshold: MATCH_THRESHOLD,
    signal_breakdown: signalBreakdown,
    counter_signal_checks: counterChecks,
    schema_version: RESULT_SCHEMA_VERSION,
    source: RESULT_SOURCE,
  };
}

/**
 * Match a single card against aggregated clusters.
 *
 * Tests each cluster independently and returns the best-scoring result.
 * This enables detecting multiple card instances on a single page (FR6):
 * a login form cluster and a search-result cluster each get their own
 * match attempt, and counter-signals only fire within the relevant cluster.
 *
 * Falls back to flat matching when no clusters are provided (empty array).
 *
 * @param card - Card to match
 * @param clusters - Aggregated clusters from aggregateSignals()
 * @returns Best-scoring MatchResult across all clusters
 */
export function matchCardAgainstClusters(
  card: CardForMatching,
  clusters: AggregatedCluster[],
): MatchResult {
  if (clusters.length === 0) {
    return matchCard(card, []);
  }

  let bestResult: MatchResult | undefined;
  for (const cluster of clusters) {
    const result = matchCard(card, cluster.signals);
    if (!bestResult || result.score > bestResult.score) {
      bestResult = result;
    }
  }

  return bestResult!;
}

/**
 * Match all cards against an extracted signal list.
 *
 * Internally aggregates signals into DOM-proximity clusters (AC-4),
 * then matches each card against each cluster AND against the full
 * signal list (page-level matching). The best-scoring result per card
 * wins. This dual strategy supports both form-like cards (per-cluster,
 * FR6) and page-level cards like article-reader (full page).
 *
 * Returns results sorted by score descending. Every card gets a
 * complete MatchResult regardless of match/no-match.
 *
 * @param cards - Array of cards to match
 * @param signals - Flat signal list from extractSignals()
 * @returns Array of MatchResults sorted by score descending
 */
export function matchAllCards(cards: CardForMatching[], signals: Signal[]): MatchResult[] {
  const clusters = aggregateSignals(signals);
  const results: MatchResult[] = [];
  for (const card of cards) {
    // Try per-cluster matching (for form-like, localised patterns)
    const clusterResult = matchCardAgainstClusters(card, clusters);
    // Try page-level matching (for page-wide patterns like article-reader)
    const pageResult = matchCard(card, signals);
    // Pick the best-scoring result
    results.push(clusterResult.score >= pageResult.score ? clusterResult : pageResult);
  }
  // Sort by score descending (stable sort: equal scores keep insertion order)
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Format a MatchResult as a compact, LLM-readable string.
 *
 * Signals with weight < LOW_WEIGHT_THRESHOLD are condensed into a
 * summary line instead of being listed individually.
 *
 * @tokens max 400
 * @param result - A MatchResult from matchCard()
 * @returns Compact string representation of the match audit
 */
export function formatWhyThisCard(result: MatchResult): string {
  const lines: string[] = [];

  // Header: score and threshold
  lines.push(`${result.cardName} (${result.cardId}): score ${result.score.toFixed(2)} (threshold: ${result.threshold.toFixed(2)}) → ${result.matched ? "MATCH" : "NO MATCH"}`);

  // Matched signals (above low-weight threshold)
  const matchedHigh = result.signal_breakdown.filter(
    (s) => s.matched && s.weight >= LOW_WEIGHT_THRESHOLD,
  );
  const matchedLow = result.signal_breakdown.filter(
    (s) => s.matched && s.weight < LOW_WEIGHT_THRESHOLD,
  );
  const missed = result.signal_breakdown.filter((s) => !s.matched);

  if (matchedHigh.length > 0) {
    const parts = matchedHigh.map((s) => `${s.signal} (${s.weight})`);
    lines.push(`matched: ${parts.join(", ")}`);
  }

  if (matchedLow.length > 0) {
    lines.push(`+ ${matchedLow.length} low-weight signals matched`);
  }

  if (missed.length > 0) {
    const missedHigh = missed.filter((s) => s.weight >= LOW_WEIGHT_THRESHOLD);
    const missedLow = missed.filter((s) => s.weight < LOW_WEIGHT_THRESHOLD);

    if (missedHigh.length > 0) {
      const parts = missedHigh.map((s) => `${s.signal} (${s.weight})`);
      lines.push(`missed: ${parts.join(", ")}`);
    }
    if (missedLow.length > 0) {
      lines.push(`+ ${missedLow.length} low-weight signals missed`);
    }
  }

  // Counter-signal checks
  if (result.counter_signal_checks.length > 0) {
    const parts = result.counter_signal_checks.map(
      (c) => `${c.signal} — ${c.action_taken}`,
    );
    lines.push(`counters: ${parts.join(", ")}`);
  }

  return lines.join("\n");
}
