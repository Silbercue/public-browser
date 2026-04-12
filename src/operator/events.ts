/**
 * Operator State-Machine Events — Discriminated Union.
 *
 * All state transitions in the Operator loop are triggered by typed events.
 * The `type` field serves as the discriminator for TypeScript narrowing.
 *
 * Module Boundaries:
 *   - MAY import: src/scan/ (MatchResult type only)
 *   - MUST NOT import: src/tools/, src/cdp/, src/operator/ (no circular)
 */

import type { MatchResult } from "../scan/match-types.js";

// ---------------------------------------------------------------------------
// Operator States (Subtask 1.1)
// ---------------------------------------------------------------------------

/**
 * The six explicit states of the Operator State Machine.
 *
 * - IDLE: No active operator call.
 * - SCANNING: Signal-Extractor + Aggregator + Matcher running.
 * - AWAITING_SELECTION: Return sent to LLM, waiting for card selection.
 * - EXECUTING: Selected card being mechanically executed (multi-step).
 * - POST_EXECUTION_SCAN: Follow-up page scanned, new return being prepared.
 * - FALLBACK: No card matched — direct-primitive mode.
 */
export type OperatorState =
  | "IDLE"
  | "SCANNING"
  | "AWAITING_SELECTION"
  | "EXECUTING"
  | "POST_EXECUTION_SCAN"
  | "FALLBACK";

// ---------------------------------------------------------------------------
// Event Interfaces (Subtasks 1.2 – 1.8)
// ---------------------------------------------------------------------------

/** Triggers transition from IDLE or FALLBACK to SCANNING. (Subtask 1.2) */
export interface ScanStarted {
  readonly type: "ScanStarted";
}

/** Scan completed — carries match results and a flag whether any card matched. (Subtask 1.3) */
export interface ScanCompleted {
  readonly type: "ScanCompleted";
  readonly matchResults: MatchResult[];
  readonly hasMatch: boolean;
}

/** LLM selected a card — carries cardId, params, and stepsTotal. (Subtask 1.4) */
export interface CardSelected {
  readonly type: "CardSelected";
  readonly cardId: string;
  readonly params: Record<string, string>;
  /** Total steps in the card's execution sequence (card.executionSequence.length). */
  readonly stepsTotal: number;
}

/**
 * One execution step finished — carries progress and navigation info. (Subtask 1.5)
 * The state machine stays in EXECUTING until stepsCompleted === stepsTotal.
 */
export interface StepCompleted {
  readonly type: "StepCompleted";
  readonly stepIndex: number;
  readonly stepsTotal: number;
  readonly navigated: boolean;
}

/**
 * All execution steps done (or aborted with error). (Subtask 1.6)
 * Triggers transition from EXECUTING to POST_EXECUTION_SCAN.
 */
export interface ExecutionCompleted {
  readonly type: "ExecutionCompleted";
  readonly stepsCompleted: number;
  readonly stepsTotal: number;
  readonly error?: string;
}

/** Fallback triggered — no card match or execution failure. (Subtask 1.7) */
export interface FallbackTriggered {
  readonly type: "FallbackTriggered";
  readonly reason: string;
}

/** Post-execution scan completed — new page scanned after card execution. (Subtask 1.8) */
export interface PostScanCompleted {
  readonly type: "PostScanCompleted";
  readonly matchResults: MatchResult[];
  readonly hasMatch: boolean;
}

// ---------------------------------------------------------------------------
// Discriminated Union (Subtask 1.9)
// ---------------------------------------------------------------------------

/**
 * Union of all Operator events. The `type` field is the discriminator.
 * Use `event.type` in a switch/if to narrow to the specific event interface.
 */
export type OperatorEvent =
  | ScanStarted
  | ScanCompleted
  | CardSelected
  | StepCompleted
  | ExecutionCompleted
  | FallbackTriggered
  | PostScanCompleted;

// Subtask 1.10: All types and interfaces are exported above.
