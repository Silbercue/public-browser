import { describe, it, expect } from "vitest";
import { OperatorStateMachine } from "./state-machine.js";
import type { OperatorEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

function makeScanCompleted(hasMatch: boolean): OperatorEvent {
  return {
    type: "ScanCompleted",
    matchResults: [],
    hasMatch,
  };
}

function makePostScanCompleted(hasMatch: boolean): OperatorEvent {
  return {
    type: "PostScanCompleted",
    matchResults: [],
    hasMatch,
  };
}

function makeStepCompleted(stepIndex: number, stepsTotal: number, navigated = false): OperatorEvent {
  return {
    type: "StepCompleted",
    stepIndex,
    stepsTotal,
    navigated,
  };
}

// ---------------------------------------------------------------------------
// Subtask 6.1: Initial state is IDLE
// ---------------------------------------------------------------------------

describe("OperatorStateMachine", () => {
  it("starts in IDLE state", () => {
    const sm = new OperatorStateMachine();
    expect(sm.getState()).toBe("IDLE");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.2: IDLE → SCANNING via ScanStarted
  // -------------------------------------------------------------------------

  it("transitions IDLE → SCANNING via ScanStarted", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    expect(sm.getState()).toBe("SCANNING");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.3: SCANNING → AWAITING_SELECTION via ScanCompleted (hasMatch)
  // -------------------------------------------------------------------------

  it("transitions SCANNING → AWAITING_SELECTION via ScanCompleted with match", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    expect(sm.getState()).toBe("AWAITING_SELECTION");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.4: SCANNING → FALLBACK via ScanCompleted without match
  // -------------------------------------------------------------------------

  it("transitions SCANNING → FALLBACK via FallbackTriggered (no match)", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition({ type: "FallbackTriggered", reason: "No match" });
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.5: AWAITING_SELECTION → EXECUTING via CardSelected
  // -------------------------------------------------------------------------

  it("transitions AWAITING_SELECTION → EXECUTING via CardSelected", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "login-form", params: { username: "test" }, stepsTotal: 3 });
    expect(sm.getState()).toBe("EXECUTING");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.6: EXECUTING stays EXECUTING at partial step
  // -------------------------------------------------------------------------

  it("stays in EXECUTING at StepCompleted 0/3", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "login-form", params: {}, stepsTotal: 3 });
    sm.transition(makeStepCompleted(0, 3));
    expect(sm.getState()).toBe("EXECUTING");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.7: EXECUTING → POST_EXECUTION_SCAN at last step
  // -------------------------------------------------------------------------

  it("transitions EXECUTING → POST_EXECUTION_SCAN at last step (3/3)", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "login-form", params: {}, stepsTotal: 3 });
    sm.transition(makeStepCompleted(0, 3));
    sm.transition(makeStepCompleted(1, 3));
    sm.transition(makeStepCompleted(2, 3)); // last step
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.8: POST_EXECUTION_SCAN → AWAITING_SELECTION via PostScanCompleted
  // -------------------------------------------------------------------------

  it("transitions POST_EXECUTION_SCAN → AWAITING_SELECTION via PostScanCompleted with match", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "login-form", params: {}, stepsTotal: 1 });
    sm.transition(makeStepCompleted(0, 1)); // single-step card
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");
    sm.transition(makePostScanCompleted(true));
    expect(sm.getState()).toBe("AWAITING_SELECTION");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.9: POST_EXECUTION_SCAN → FALLBACK via PostScanCompleted (no match)
  // -------------------------------------------------------------------------

  it("transitions POST_EXECUTION_SCAN → FALLBACK via FallbackTriggered", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "login-form", params: {}, stepsTotal: 1 });
    sm.transition(makeStepCompleted(0, 1));
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");
    sm.transition({ type: "FallbackTriggered", reason: "No match on new page" });
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.10: Invalid transition IDLE → EXECUTING throws Error
  // -------------------------------------------------------------------------

  it("throws on invalid transition IDLE → EXECUTING (CardSelected)", () => {
    const sm = new OperatorStateMachine();
    expect(() =>
      sm.transition({ type: "CardSelected", cardId: "test", params: {}, stepsTotal: 1 }),
    ).toThrow("Invalid transition: IDLE + CardSelected");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.11: Invalid transition AWAITING_SELECTION → POST_EXECUTION_SCAN throws
  // -------------------------------------------------------------------------

  it("throws on invalid transition AWAITING_SELECTION → POST_EXECUTION_SCAN", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    expect(() =>
      sm.transition({ type: "PostScanCompleted", matchResults: [], hasMatch: true }),
    ).toThrow("Invalid transition: AWAITING_SELECTION + PostScanCompleted");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.12: FALLBACK → SCANNING via ScanStarted (return path)
  // -------------------------------------------------------------------------

  it("transitions FALLBACK → SCANNING via ScanStarted", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition({ type: "FallbackTriggered", reason: "No match" });
    expect(sm.getState()).toBe("FALLBACK");
    sm.transition({ type: "ScanStarted" });
    expect(sm.getState()).toBe("SCANNING");
  });

  // -------------------------------------------------------------------------
  // Subtask 6.13: reset() returns to IDLE
  // -------------------------------------------------------------------------

  it("reset() returns to IDLE and clears tracking", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "test", params: {}, stepsTotal: 3 });
    sm.setNavigationPending(true);
    expect(sm.getState()).toBe("EXECUTING");
    expect(sm.getExecutionProgress()).not.toBeNull();
    expect(sm.isNavigationPending()).toBe(true);

    sm.reset();
    expect(sm.getState()).toBe("IDLE");
    expect(sm.getExecutionProgress()).toBeNull();
    expect(sm.isNavigationPending()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Subtask 6.14: getExecutionProgress() returns correct progress in EXECUTING
  // -------------------------------------------------------------------------

  it("getExecutionProgress() returns correct progress during EXECUTING", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "login-form", params: {}, stepsTotal: 3 });

    // stepsTotal is set immediately at CardSelected (C1 fix)
    const initialProgress = sm.getExecutionProgress();
    expect(initialProgress).not.toBeNull();
    expect(initialProgress!.stepsTotal).toBe(3);
    expect(initialProgress!.stepsCompleted).toBe(0);

    sm.transition(makeStepCompleted(0, 3));
    const progress = sm.getExecutionProgress();
    expect(progress).not.toBeNull();
    expect(progress!.cardId).toBe("login-form");
    expect(progress!.stepsCompleted).toBe(1);
    expect(progress!.stepsTotal).toBe(3);

    sm.transition(makeStepCompleted(1, 3));
    expect(sm.getExecutionProgress()!.stepsCompleted).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Subtask 6.15: getExecutionProgress() returns null when not EXECUTING
  // -------------------------------------------------------------------------

  it("getExecutionProgress() returns null when not in EXECUTING state", () => {
    const sm = new OperatorStateMachine();
    expect(sm.getExecutionProgress()).toBeNull();

    sm.transition({ type: "ScanStarted" });
    expect(sm.getExecutionProgress()).toBeNull();

    sm.transition(makeScanCompleted(true));
    expect(sm.getExecutionProgress()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Subtask 6.16: navigationPending flag set on navigated StepCompleted
  // -------------------------------------------------------------------------

  it("manages navigationPending via setNavigationPending (C2/H3 fix)", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "test", params: {}, stepsTotal: 3 });

    expect(sm.isNavigationPending()).toBe(false);
    // Set before waitForSettle (simulating execution-bundling)
    sm.setNavigationPending(true);
    expect(sm.isNavigationPending()).toBe(true);
    // Clear after settle
    sm.setNavigationPending(false);
    expect(sm.isNavigationPending()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Subtask 6.17: Full multi-step login form path
  // -------------------------------------------------------------------------

  it("completes full login form path: IDLE → SCANNING → AWAITING → EXECUTING (3 steps) → POST_SCAN → AWAITING", () => {
    const sm = new OperatorStateMachine();

    // IDLE → SCANNING
    sm.transition({ type: "ScanStarted" });
    expect(sm.getState()).toBe("SCANNING");

    // SCANNING → AWAITING_SELECTION
    sm.transition(makeScanCompleted(true));
    expect(sm.getState()).toBe("AWAITING_SELECTION");

    // AWAITING_SELECTION → EXECUTING
    sm.transition({ type: "CardSelected", cardId: "login-form", params: { username: "admin", password: "secret" }, stepsTotal: 3 });
    expect(sm.getState()).toBe("EXECUTING");

    // stepsTotal is set immediately at CardSelected (C1 fix)
    expect(sm.getExecutionProgress()!.stepsTotal).toBe(3);

    // Step 1/3: fill username (stays EXECUTING)
    sm.transition(makeStepCompleted(0, 3));
    expect(sm.getState()).toBe("EXECUTING");
    expect(sm.getExecutionProgress()!.stepsCompleted).toBe(1);

    // Step 2/3: fill password (stays EXECUTING)
    sm.transition(makeStepCompleted(1, 3));
    expect(sm.getState()).toBe("EXECUTING");
    expect(sm.getExecutionProgress()!.stepsCompleted).toBe(2);

    // Step 3/3: click submit (transitions to POST_EXECUTION_SCAN)
    sm.transition(makeStepCompleted(2, 3));
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");

    // POST_EXECUTION_SCAN → AWAITING_SELECTION (new page scanned)
    sm.transition(makePostScanCompleted(true));
    expect(sm.getState()).toBe("AWAITING_SELECTION");
  });

  // -------------------------------------------------------------------------
  // Additional: ScanCompleted with hasMatch=false throws
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // H1 fix: ScanCompleted with hasMatch=false → FALLBACK (AC-4/AC-5)
  // -------------------------------------------------------------------------

  it("transitions SCANNING → FALLBACK via ScanCompleted with hasMatch=false", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(false));
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // H2 fix: PostScanCompleted with hasMatch=false → FALLBACK (AC-6)
  // -------------------------------------------------------------------------

  it("transitions POST_EXECUTION_SCAN → FALLBACK via PostScanCompleted with hasMatch=false", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "test", params: {}, stepsTotal: 1 });
    sm.transition(makeStepCompleted(0, 1));
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");
    sm.transition(makePostScanCompleted(false));
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // Additional: ExecutionCompleted transitions to POST_EXECUTION_SCAN
  // -------------------------------------------------------------------------

  it("transitions EXECUTING → POST_EXECUTION_SCAN via ExecutionCompleted", () => {
    const sm = new OperatorStateMachine();
    sm.transition({ type: "ScanStarted" });
    sm.transition(makeScanCompleted(true));
    sm.transition({ type: "CardSelected", cardId: "test", params: {}, stepsTotal: 3 });
    sm.transition({ type: "ExecutionCompleted", stepsCompleted: 1, stepsTotal: 3, error: "target not found" });
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");
  });
});
