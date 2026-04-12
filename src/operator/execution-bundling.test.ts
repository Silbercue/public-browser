import { describe, it, expect, vi } from "vitest";
import { executeCard } from "./execution-bundling.js";
import type { ToolDispatcher, ExecutionContext, ExecutionStep } from "./execution-bundling.js";
import { OperatorStateMachine } from "./state-machine.js";

// ---------------------------------------------------------------------------
// Mock ToolDispatcher (Subtask 7.1)
// ---------------------------------------------------------------------------

function makeMockDispatcher(overrides?: Partial<ToolDispatcher>): ToolDispatcher {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    pressKey: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    waitForSettle: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeLoginFormSteps(): ExecutionStep[] {
  return [
    { action: "fill", target: "[autocomplete=username]", paramRef: "username" },
    { action: "fill", target: "[type=password]", paramRef: "password" },
    { action: "click", target: "button[type=submit]" },
  ];
}

function makeStateMachineInExecuting(cardId = "login-form", stepsTotal = 3): OperatorStateMachine {
  const sm = new OperatorStateMachine();
  sm.transition({ type: "ScanStarted" });
  sm.transition({ type: "ScanCompleted", matchResults: [], hasMatch: true });
  sm.transition({ type: "CardSelected", cardId, params: {}, stepsTotal });
  return sm;
}

// ---------------------------------------------------------------------------
// Subtask 7.2: Login form card (3 steps) completes fully
// ---------------------------------------------------------------------------

describe("executeCard", () => {
  it("executes 3-step login form card completely", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher();
    const context: ExecutionContext = {
      steps: makeLoginFormSteps(),
      cardId: "login-form",
      params: { username: "admin", password: "secret" },
      stateMachine: sm,
    };

    const result = await executeCard(context, dispatcher);

    expect(result.stepsCompleted).toBe(3);
    expect(result.stepsTotal).toBe(3);
    expect(result.error).toBeUndefined();
    expect(dispatcher.fill).toHaveBeenCalledTimes(2);
    expect(dispatcher.click).toHaveBeenCalledTimes(1);
    // State machine should have auto-transitioned to POST_EXECUTION_SCAN
    expect(sm.getState()).toBe("POST_EXECUTION_SCAN");
  });

  // -------------------------------------------------------------------------
  // Subtask 7.3: Parameter substitution via paramRef
  // -------------------------------------------------------------------------

  it("substitutes paramRef values correctly", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher();
    const context: ExecutionContext = {
      steps: makeLoginFormSteps(),
      cardId: "login-form",
      params: { username: "julian@test.com", password: "p4ssw0rd" },
      stateMachine: sm,
    };

    await executeCard(context, dispatcher);

    expect(dispatcher.fill).toHaveBeenCalledWith("[autocomplete=username]", "julian@test.com");
    expect(dispatcher.fill).toHaveBeenCalledWith("[type=password]", "p4ssw0rd");
  });

  // -------------------------------------------------------------------------
  // Subtask 7.4: Click step triggers waitForSettle
  // -------------------------------------------------------------------------

  it("calls waitForSettle after click step", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher();
    const context: ExecutionContext = {
      steps: [{ action: "click", target: "button[type=submit]" }],
      cardId: "single-click",
      params: {},
      stateMachine: sm,
    };

    await executeCard(context, dispatcher);

    expect(dispatcher.click).toHaveBeenCalledWith("button[type=submit]");
    expect(dispatcher.waitForSettle).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Subtask 7.5: Step error at step 2/3 → partial result
  // -------------------------------------------------------------------------

  it("returns partial result on step error at step 2/3", async () => {
    const sm = makeStateMachineInExecuting();
    const fillMock = vi.fn()
      .mockResolvedValueOnce(undefined) // step 1 succeeds
      .mockRejectedValueOnce(new Error("Element not found")); // step 2 fails
    const dispatcher = makeMockDispatcher({ fill: fillMock });

    const context: ExecutionContext = {
      steps: makeLoginFormSteps(),
      cardId: "login-form",
      params: { username: "admin", password: "secret" },
      stateMachine: sm,
    };

    const result = await executeCard(context, dispatcher);

    expect(result.stepsCompleted).toBe(1);
    expect(result.stepsTotal).toBe(3);
    expect(result.error).toContain("Element not found");
    // C3 fix: step errors route to FALLBACK (via ExecutionCompleted → FallbackTriggered)
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // Subtask 7.6: Navigation timeout → partial result
  // -------------------------------------------------------------------------

  it("returns partial result on navigation timeout", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher({
      waitForSettle: vi.fn().mockResolvedValue(false), // timeout
    });

    const context: ExecutionContext = {
      steps: [
        { action: "fill", target: "[type=text]", value: "test" },
        { action: "click", target: "button[type=submit]" },
        { action: "fill", target: "[type=text]", value: "next" },
      ],
      cardId: "nav-test",
      params: {},
      stateMachine: sm,
    };

    const result = await executeCard(context, dispatcher);

    expect(result.stepsCompleted).toBe(2);
    expect(result.stepsTotal).toBe(3);
    expect(result.error).toContain("Navigation timed out");
    expect(result.navigated).toBe(true);
    // C3 fix: nav timeout routes to FALLBACK (via ExecutionCompleted → FallbackTriggered)
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // Subtask 7.7: MAX_EXECUTION_STEPS guard
  // -------------------------------------------------------------------------

  it("rejects execution sequence exceeding MAX_EXECUTION_STEPS", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher();

    // Create 21 steps (limit is 20)
    const steps: ExecutionStep[] = Array.from({ length: 21 }, (_, i) => ({
      action: "click",
      target: `button-${i}`,
    }));

    const context: ExecutionContext = {
      steps,
      cardId: "overlong",
      params: {},
      stateMachine: sm,
    };

    const result = await executeCard(context, dispatcher);

    expect(result.stepsCompleted).toBe(0);
    expect(result.stepsTotal).toBe(21);
    expect(result.error).toContain("exceeding limit");
    expect(dispatcher.click).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Additional: fill with missing paramRef returns error
  // -------------------------------------------------------------------------

  it("returns error when paramRef value is missing", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher();

    const context: ExecutionContext = {
      steps: [{ action: "fill", target: "[type=text]", paramRef: "missing_param" }],
      cardId: "missing-param-test",
      params: {}, // no "missing_param" key
      stateMachine: sm,
    };

    const result = await executeCard(context, dispatcher);

    expect(result.stepsCompleted).toBe(0);
    expect(result.error).toContain("Missing value");
    // C3 fix: step errors route to FALLBACK
    expect(sm.getState()).toBe("FALLBACK");
  });

  // -------------------------------------------------------------------------
  // Additional: press_key with Enter triggers waitForSettle
  // -------------------------------------------------------------------------

  it("calls waitForSettle after press_key Enter", async () => {
    const sm = makeStateMachineInExecuting();
    const dispatcher = makeMockDispatcher();

    const context: ExecutionContext = {
      steps: [{ action: "press_key", target: "Enter" }],
      cardId: "enter-test",
      params: {},
      stateMachine: sm,
    };

    await executeCard(context, dispatcher);

    expect(dispatcher.pressKey).toHaveBeenCalledWith("Enter");
    expect(dispatcher.waitForSettle).toHaveBeenCalledTimes(1);
  });
});
