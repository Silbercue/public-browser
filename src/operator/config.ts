/**
 * Operator Configuration Constants — Invariante 5 (Solo-Pflegbarkeit).
 *
 * All timeout values and safety limits as named constants.
 * No magic numbers in the state machine or execution bundling code.
 *
 * Module Boundaries:
 *   - No imports — pure constants.
 *   - Consumed by: state-machine.ts, execution-bundling.ts
 */

// ---------------------------------------------------------------------------
// Timeouts (Subtasks 2.1 – 2.3)
// ---------------------------------------------------------------------------

/**
 * Maximum time (ms) to wait for a navigation to settle during card execution.
 * Applies after steps that may trigger page navigation (click submit, press Enter).
 * If exceeded, execution continues with a partial result.
 * @unit milliseconds
 */
export const NAVIGATION_TIMEOUT_MS = 10_000;

/**
 * Maximum time (ms) for a single execution step (fill, click, press_key).
 * If a step takes longer, it is treated as failed and execution stops.
 * @unit milliseconds
 */
export const EXECUTION_STEP_TIMEOUT_MS = 5_000;

/**
 * Delay (ms) before running the post-execution scan.
 * Gives the page time to settle after the last execution step.
 * @unit milliseconds
 */
export const POST_EXECUTION_SCAN_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Safety Limits (Subtask 2.4)
// ---------------------------------------------------------------------------

/**
 * Maximum number of steps allowed in a single card's execution_sequence.
 * Prevents runaway execution from malformed or overly complex cards.
 * @unit count
 */
export const MAX_EXECUTION_STEPS = 20;
