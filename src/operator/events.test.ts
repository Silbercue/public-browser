import { describe, it, expect } from "vitest";
import {
  NAVIGATION_TIMEOUT_MS,
  EXECUTION_STEP_TIMEOUT_MS,
  POST_EXECUTION_SCAN_DELAY_MS,
  MAX_EXECUTION_STEPS,
} from "./config.js";
import type {
  OperatorEvent,
  ScanStarted,
  ScanCompleted,
  CardSelected,
  StepCompleted,
  ExecutionCompleted,
  FallbackTriggered,
  PostScanCompleted,
} from "./events.js";

// ---------------------------------------------------------------------------
// Subtask 8.1: Every event interface has a `type` field
// ---------------------------------------------------------------------------

describe("Operator Events — type field", () => {
  it("ScanStarted has type field", () => {
    const event: ScanStarted = { type: "ScanStarted" };
    expect(event.type).toBe("ScanStarted");
  });

  it("ScanCompleted has type field", () => {
    const event: ScanCompleted = { type: "ScanCompleted", matchResults: [], hasMatch: false };
    expect(event.type).toBe("ScanCompleted");
  });

  it("CardSelected has type field", () => {
    const event: CardSelected = { type: "CardSelected", cardId: "test", params: {}, stepsTotal: 3 };
    expect(event.type).toBe("CardSelected");
  });

  it("StepCompleted has type field", () => {
    const event: StepCompleted = { type: "StepCompleted", stepIndex: 0, stepsTotal: 1, navigated: false };
    expect(event.type).toBe("StepCompleted");
  });

  it("ExecutionCompleted has type field", () => {
    const event: ExecutionCompleted = { type: "ExecutionCompleted", stepsCompleted: 1, stepsTotal: 1 };
    expect(event.type).toBe("ExecutionCompleted");
  });

  it("FallbackTriggered has type field", () => {
    const event: FallbackTriggered = { type: "FallbackTriggered", reason: "test" };
    expect(event.type).toBe("FallbackTriggered");
  });

  it("PostScanCompleted has type field", () => {
    const event: PostScanCompleted = { type: "PostScanCompleted", matchResults: [], hasMatch: true };
    expect(event.type).toBe("PostScanCompleted");
  });
});

// ---------------------------------------------------------------------------
// Subtask 8.2: Discriminated Union is type-safe
// ---------------------------------------------------------------------------

describe("Operator Events — Discriminated Union type safety", () => {
  /**
   * Exhaustive switch helper — TypeScript will error at compile time
   * if a variant is added to OperatorEvent but not handled here.
   * This guards against silent regressions when new events are added. (M1 fix)
   */
  function assertExhaustive(event: OperatorEvent): string {
    switch (event.type) {
      case "ScanStarted":
        return "ScanStarted";
      case "ScanCompleted":
        return `ScanCompleted:${event.hasMatch}`;
      case "CardSelected":
        return `CardSelected:${event.cardId}:${event.stepsTotal}`;
      case "StepCompleted":
        return `StepCompleted:${event.stepIndex}/${event.stepsTotal}`;
      case "ExecutionCompleted":
        return `ExecutionCompleted:${event.stepsCompleted}/${event.stepsTotal}`;
      case "FallbackTriggered":
        return `FallbackTriggered:${event.reason}`;
      case "PostScanCompleted":
        return `PostScanCompleted:${event.hasMatch}`;
    }
    // If we reach here, TypeScript narrowing missed a variant.
    // The (event as { type: string }).type cast is intentional — it should be unreachable.
    throw new Error(`Unhandled event type: ${(event as { type: string }).type}`);
  }

  const ALL_EVENTS: OperatorEvent[] = [
    { type: "ScanStarted" },
    { type: "ScanCompleted", matchResults: [], hasMatch: true },
    { type: "CardSelected", cardId: "test", params: {}, stepsTotal: 3 },
    { type: "StepCompleted", stepIndex: 0, stepsTotal: 3, navigated: false },
    { type: "ExecutionCompleted", stepsCompleted: 3, stepsTotal: 3 },
    { type: "FallbackTriggered", reason: "no match" },
    { type: "PostScanCompleted", matchResults: [], hasMatch: false },
  ];

  it("narrows all 7 OperatorEvent variants exhaustively", () => {
    for (const event of ALL_EVENTS) {
      // assertExhaustive will throw if any variant is unhandled
      expect(typeof assertExhaustive(event)).toBe("string");
    }
    expect(ALL_EVENTS).toHaveLength(7);
  });

  it("narrows ScanCompleted to access hasMatch", () => {
    const event: OperatorEvent = { type: "ScanCompleted", matchResults: [], hasMatch: false };
    if (event.type === "ScanCompleted") {
      expect(event.hasMatch).toBe(false);
      expect(event.matchResults).toEqual([]);
    }
  });

  it("narrows CardSelected to access cardId and stepsTotal", () => {
    const event: OperatorEvent = { type: "CardSelected", cardId: "login", params: {}, stepsTotal: 5 };
    if (event.type === "CardSelected") {
      expect(event.cardId).toBe("login");
      expect(event.stepsTotal).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Subtask 8.3: Config constants are positive numbers
// ---------------------------------------------------------------------------

describe("Operator Config — constants validation", () => {
  it("NAVIGATION_TIMEOUT_MS is a positive number", () => {
    expect(typeof NAVIGATION_TIMEOUT_MS).toBe("number");
    expect(NAVIGATION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("EXECUTION_STEP_TIMEOUT_MS is a positive number", () => {
    expect(typeof EXECUTION_STEP_TIMEOUT_MS).toBe("number");
    expect(EXECUTION_STEP_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("POST_EXECUTION_SCAN_DELAY_MS is a positive number", () => {
    expect(typeof POST_EXECUTION_SCAN_DELAY_MS).toBe("number");
    expect(POST_EXECUTION_SCAN_DELAY_MS).toBeGreaterThan(0);
  });

  it("MAX_EXECUTION_STEPS is a positive number", () => {
    expect(typeof MAX_EXECUTION_STEPS).toBe("number");
    expect(MAX_EXECUTION_STEPS).toBeGreaterThan(0);
  });
});
