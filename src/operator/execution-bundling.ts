/**
 * Execution Bundling — mechanically executes card steps via ToolDispatcher.
 *
 * This module bridges the Operator state machine and the actual tool handlers.
 * It does NOT import from src/tools/ — instead it uses the ToolDispatcher
 * interface, which the caller (Story 19.7) fulfills with a concrete adapter.
 *
 * Design Principles:
 *   - Invariante 4: No try/catch as control flow. Step failures produce
 *     partial results, not exceptions.
 *   - FR9: Multi-step cards execute server-side without LLM round-trips.
 *   - FR11: Navigation-aware — calls waitForSettle after potentially
 *     navigating steps (click, press_key Enter/Return).
 *
 * Module Boundaries:
 *   - MAY import: ./events.ts, ./config.ts, ./state-machine.ts
 *   - MUST NOT import: src/tools/, src/cdp/ (uses ToolDispatcher interface)
 */

import type { OperatorStateMachine } from "./state-machine.js";
import { MAX_EXECUTION_STEPS, NAVIGATION_TIMEOUT_MS, EXECUTION_STEP_TIMEOUT_MS } from "./config.js";

// ---------------------------------------------------------------------------
// Interfaces (Subtasks 5.1, 5.3, 5.4)
// ---------------------------------------------------------------------------

/**
 * One step in a card's execution sequence.
 * Mirrors Card.executionSequence[n] from src/cards/card-schema.ts
 * without importing it (module boundary).
 */
export interface ExecutionStep {
  action: string;
  target: string;
  value?: string;
  paramRef?: string;
}

/**
 * Abstraction over the tool handlers (clickHandler, fillFormHandler, etc.).
 * The caller creates a concrete implementation that delegates to the real
 * tool handlers. This keeps src/operator/ free from src/tools/ imports.
 * (Subtask 5.3)
 */
export interface ToolDispatcher {
  click(target: string): Promise<void>;
  fill(target: string, value: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(target: string, direction: string): Promise<void>;
  waitForSettle(): Promise<boolean>;
}

/**
 * Input context for card execution. (Subtask 5.1)
 */
export interface ExecutionContext {
  /** The card's execution steps */
  steps: ExecutionStep[];
  /** Card ID for tracking */
  cardId: string;
  /** User-provided parameter values */
  params: Record<string, string>;
  /** The state machine instance for event dispatch */
  stateMachine: OperatorStateMachine;
}

/**
 * Result of card execution. (Subtask 5.4)
 */
export interface ExecutionResult {
  /** Number of steps successfully completed */
  stepsCompleted: number;
  /** Total number of steps in the execution sequence */
  stepsTotal: number;
  /** Error description if execution stopped early */
  error?: string;
  /** Whether any step triggered navigation */
  navigated: boolean;
}

// ---------------------------------------------------------------------------
// Navigation Heuristic (Subtask 5.6)
// ---------------------------------------------------------------------------

/** Keys that can trigger form submission / navigation. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "Enter", "Return",
]);

/**
 * Returns true if a step might trigger navigation.
 * Heuristic: click actions and press_key with Enter/Return.
 */
function mightNavigate(step: ExecutionStep): boolean {
  if (step.action === "click") return true;
  if (step.action === "press_key" && NAVIGATION_KEYS.has(step.value ?? step.target)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Parameter Substitution (Subtask 5.5)
// ---------------------------------------------------------------------------

/**
 * Substitute paramRef with actual parameter value.
 * If step has a paramRef, the value is looked up in params.
 * If step has a static value and no paramRef, the static value is used.
 */
function resolveStepValue(
  step: ExecutionStep,
  params: Record<string, string>,
): string | undefined {
  if (step.paramRef) {
    return params[step.paramRef];
  }
  return step.value;
}

// ---------------------------------------------------------------------------
// Step Dispatcher (Subtask 5.5)
// ---------------------------------------------------------------------------

/**
 * Dispatch a single execution step to the appropriate ToolDispatcher method.
 * Returns { success: true } or { success: false, error: string }.
 */
async function dispatchStep(
  step: ExecutionStep,
  params: Record<string, string>,
  dispatcher: ToolDispatcher,
): Promise<{ success: true } | { success: false; error: string }> {
  const value = resolveStepValue(step, params);

  switch (step.action) {
    case "fill": {
      if (value === undefined) {
        return { success: false, error: `Missing value for fill target "${step.target}" (paramRef: ${step.paramRef ?? "none"})` };
      }
      await dispatcher.fill(step.target, value);
      return { success: true };
    }

    case "click": {
      await dispatcher.click(step.target);
      return { success: true };
    }

    case "press_key": {
      const key = value ?? step.target;
      await dispatcher.pressKey(key);
      return { success: true };
    }

    case "scroll": {
      const direction = value ?? "down";
      await dispatcher.scroll(step.target, direction);
      return { success: true };
    }

    case "wait": {
      await dispatcher.waitForSettle();
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown action "${step.action}"` };
  }
}

// ---------------------------------------------------------------------------
// Public API — executeCard (Subtask 5.2)
// ---------------------------------------------------------------------------

/**
 * Execute a card's steps sequentially, dispatching each to the ToolDispatcher.
 *
 * - Sends StepCompleted events to the state machine after each step.
 * - Calls waitForSettle() after potentially navigating steps.
 * - Stops on error, returning a partial result.
 * - Enforces MAX_EXECUTION_STEPS guard. (Subtask 5.7)
 *
 * @param context - Card execution context (steps, params, state machine)
 * @param dispatcher - ToolDispatcher for executing actions
 * @returns ExecutionResult with completion status
 */
export async function executeCard(
  context: ExecutionContext,
  dispatcher: ToolDispatcher,
): Promise<ExecutionResult> {
  const { steps, params, stateMachine } = context;
  const stepsTotal = steps.length;
  let navigated = false;

  // Guard: MAX_EXECUTION_STEPS (Subtask 5.7)
  if (stepsTotal > MAX_EXECUTION_STEPS) {
    return {
      stepsCompleted: 0,
      stepsTotal,
      error: `Execution sequence has ${stepsTotal} steps, exceeding limit of ${MAX_EXECUTION_STEPS}`,
      navigated: false,
    };
  }

  for (let i = 0; i < stepsTotal; i++) {
    const step = steps[i];

    // Dispatch the step action with timeout (Subtask 5.5, M2 fix)
    // try/catch is allowed here: wrapping CDP/system-level errors from the
    // dispatcher, NOT used as control-flow for fallback (Invariante 4).
    let result: { success: true } | { success: false; error: string };
    try {
      result = await Promise.race([
        dispatchStep(step, params, dispatcher),
        new Promise<{ success: false; error: string }>((resolve) =>
          setTimeout(
            () => resolve({ success: false, error: `Step timed out after ${EXECUTION_STEP_TIMEOUT_MS}ms` }),
            EXECUTION_STEP_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = { success: false, error: errorMsg };
    }

    if (!result.success) {
      // Step failed — transition to FALLBACK via FallbackTriggered (C3 fix).
      // Step errors are a legitimate fallback trigger, not just POST_EXECUTION_SCAN.
      stateMachine.transition({
        type: "ExecutionCompleted",
        stepsCompleted: i,
        stepsTotal,
        error: result.error,
      });
      stateMachine.transition({
        type: "FallbackTriggered",
        reason: result.error,
      });
      return {
        stepsCompleted: i,
        stepsTotal,
        error: result.error,
        navigated,
      };
    }

    // Navigation handling (Subtask 5.6, C2/H3 fix)
    const stepNavigated = mightNavigate(step);
    if (stepNavigated) {
      navigated = true;
      // Set navigationPending BEFORE waitForSettle (C2 fix)
      stateMachine.setNavigationPending(true);
      let settled: boolean;
      try {
        settled = await Promise.race([
          dispatcher.waitForSettle(),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), NAVIGATION_TIMEOUT_MS),
          ),
        ]);
      } catch {
        settled = false;
      }
      // Clear navigationPending AFTER settle completes (H3 fix)
      stateMachine.setNavigationPending(false);
      if (!settled) {
        // Navigation timeout — partial result, route to FALLBACK
        stateMachine.transition({
          type: "ExecutionCompleted",
          stepsCompleted: i + 1,
          stepsTotal,
          error: "Navigation timed out after step",
        });
        stateMachine.transition({
          type: "FallbackTriggered",
          reason: "Navigation timed out after step",
        });
        return {
          stepsCompleted: i + 1,
          stepsTotal,
          error: "Navigation timed out after step",
          navigated: true,
        };
      }
    }

    // Send StepCompleted event to state machine (Subtask 5.5)
    stateMachine.transition({
      type: "StepCompleted",
      stepIndex: i,
      stepsTotal,
      navigated: stepNavigated,
    });
  }

  // All steps completed — the state machine auto-transitioned to POST_EXECUTION_SCAN
  // on the last StepCompleted event. No need for an explicit ExecutionCompleted here.
  return {
    stepsCompleted: stepsTotal,
    stepsTotal,
    navigated,
  };
}
