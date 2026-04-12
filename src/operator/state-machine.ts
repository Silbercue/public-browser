/**
 * Operator State Machine — orchestrates Scan → Match → Execute → Post-Scan.
 *
 * Five explicit states + FALLBACK. Transitions are event-driven via
 * discriminated unions (events.ts). Invalid transitions throw — no silent failures.
 *
 * Core Design:
 *   - EXECUTING stays put until all steps complete (multi-step cards, Gap 1).
 *   - POST_EXECUTION_SCAN triggers a re-scan without LLM round-trip (FR9 bundling).
 *   - FALLBACK is a state, not an exception (Invariante 4).
 *   - Navigation-pending flag tracks in-flight navigation during execution.
 *
 * Module Boundaries:
 *   - MAY import: ./events.ts, ./config.ts (types + constants only)
 *   - MUST NOT import: src/tools/, src/cdp/, src/scan/, src/cards/
 */

import type { OperatorState, OperatorEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Execution Progress Tracking (Subtask 4.6)
// ---------------------------------------------------------------------------

/** Tracks step-by-step progress during EXECUTING state. */
export interface ExecutionProgress {
  /** Card being executed */
  readonly cardId: string;
  /** Number of steps completed so far */
  stepsCompleted: number;
  /** Total steps in the execution sequence */
  stepsTotal: number;
}

// ---------------------------------------------------------------------------
// Transition Table (Subtask 4.4)
// ---------------------------------------------------------------------------

/**
 * Allowed transitions: Record<CurrentState, Record<EventType, NextState>>.
 *
 * StepCompleted is special-cased in the transition method:
 * it stays in EXECUTING if more steps remain.
 *
 * ExecutionCompleted always transitions to POST_EXECUTION_SCAN.
 */
type TransitionTable = Record<OperatorState, Partial<Record<OperatorEvent["type"], OperatorState>>>;

const TRANSITIONS: TransitionTable = {
  IDLE: {
    ScanStarted: "SCANNING",
  },
  SCANNING: {
    ScanCompleted: "AWAITING_SELECTION",  // hasMatch=true path, checked at runtime
    FallbackTriggered: "FALLBACK",        // hasMatch=false path
  },
  AWAITING_SELECTION: {
    CardSelected: "EXECUTING",
    ScanStarted: "SCANNING",  // Re-scan from awaiting (new operator() call)
  },
  EXECUTING: {
    StepCompleted: "EXECUTING",              // stays in EXECUTING (handled specially)
    ExecutionCompleted: "POST_EXECUTION_SCAN",
  },
  POST_EXECUTION_SCAN: {
    PostScanCompleted: "AWAITING_SELECTION", // hasMatch=true path
    FallbackTriggered: "FALLBACK",           // hasMatch=false path
  },
  FALLBACK: {
    ScanStarted: "SCANNING",  // Return path from fallback
  },
};

// ---------------------------------------------------------------------------
// OperatorStateMachine (Subtasks 4.1 – 4.13)
// ---------------------------------------------------------------------------

export class OperatorStateMachine {
  /** Current state of the machine. (Subtask 4.1) */
  private currentState: OperatorState = "IDLE";

  /** Step-by-step tracking during EXECUTING. (Subtask 4.6) */
  private executionProgress: ExecutionProgress | null = null;

  /** Set when a step triggers navigation, cleared on next step or transition. (Subtask 4.11) */
  private navigationPending = false;

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns the current state. (Subtask 4.2) */
  getState(): OperatorState {
    return this.currentState;
  }

  /**
   * Returns execution progress or null if not in EXECUTING state. (Subtask 4.7)
   */
  getExecutionProgress(): ExecutionProgress | null {
    if (this.currentState !== "EXECUTING") return null;
    return this.executionProgress;
  }

  /** Returns whether a navigation event is pending settlement. (Subtask 4.12) */
  isNavigationPending(): boolean {
    return this.navigationPending;
  }

  /**
   * Set the navigation-pending flag explicitly.
   * Called by execution-bundling BEFORE waitForSettle() (set true)
   * and AFTER settle completes (set false). (C2/H3 fix)
   */
  setNavigationPending(value: boolean): void {
    this.navigationPending = value;
  }

  /**
   * Process an event and transition to the next state. (Subtask 4.3)
   *
   * Validates the transition against the transition table.
   * Throws on invalid transitions — no silent failures. (Subtask 4.5)
   */
  transition(event: OperatorEvent): void {
    const stateTransitions = TRANSITIONS[this.currentState];
    if (!stateTransitions || !(event.type in stateTransitions)) {
      throw new Error(
        `Invalid transition: ${this.currentState} + ${event.type}`,
      );
    }

    // --- Event-specific logic before state change ---

    switch (event.type) {
      case "ScanCompleted": {
        // Route to AWAITING_SELECTION (match) or FALLBACK (no match) — AC-4/AC-5
        if (!event.hasMatch) {
          this.currentState = "FALLBACK";
        } else {
          this.currentState = "AWAITING_SELECTION";
        }
        return;
      }

      case "CardSelected": {
        // Initialize execution tracking. (Subtask 4.10)
        // stepsTotal comes from CardSelected event (= card.executionSequence.length)
        this.executionProgress = {
          cardId: event.cardId,
          stepsCompleted: 0,
          stepsTotal: event.stepsTotal,
        };
        this.navigationPending = false;
        this.currentState = "EXECUTING";
        return;
      }

      case "StepCompleted": {
        if (!this.executionProgress) {
          throw new Error(
            "Invalid transition: EXECUTING + StepCompleted but no executionProgress",
          );
        }
        // Update progress. (Subtask 4.8)
        this.executionProgress.stepsCompleted = event.stepIndex + 1;
        // Store stepsTotal from event (authoritative source)
        this.executionProgress.stepsTotal = event.stepsTotal;

        // Note: navigationPending is managed by execution-bundling via
        // setNavigationPending() — set BEFORE waitForSettle, cleared AFTER.
        // StepCompleted does NOT touch the flag (C2/H3 fix).

        // Auto-transition to POST_EXECUTION_SCAN on last step. (Subtask 4.9)
        if (this.executionProgress.stepsCompleted >= event.stepsTotal) {
          this.currentState = "POST_EXECUTION_SCAN";
          this.navigationPending = false;
        }
        // Otherwise stays in EXECUTING
        return;
      }

      case "ExecutionCompleted": {
        // Update progress with final counts
        if (this.executionProgress) {
          this.executionProgress.stepsCompleted = event.stepsCompleted;
          this.executionProgress.stepsTotal = event.stepsTotal;
        }
        this.navigationPending = false;
        this.currentState = "POST_EXECUTION_SCAN";
        return;
      }

      case "PostScanCompleted": {
        // Route to AWAITING_SELECTION (match) or FALLBACK (no match) — AC-6
        if (!event.hasMatch) {
          this.currentState = "FALLBACK";
        } else {
          this.currentState = "AWAITING_SELECTION";
        }
        return;
      }

      default: {
        // Default path: use the transition table directly
        const nextState = stateTransitions[event.type as keyof typeof stateTransitions];
        if (nextState) {
          this.currentState = nextState;
        }
      }
    }
  }

  /**
   * Reset the machine to IDLE. (Subtask 4.13)
   * Clears all tracking state.
   */
  reset(): void {
    this.currentState = "IDLE";
    this.executionProgress = null;
    this.navigationPending = false;
  }
}
