/**
 * Operator Fallback Messages — centralized framing text.
 *
 * Invariante 4: Fallback is an explicit state, not an exception.
 * All fallback-related text is defined here as constants, never ad-hoc.
 *
 * Module Boundaries:
 *   - No imports — pure string constants + helper.
 *   - Consumed by: state-machine.ts, operator-tool.ts (Story 19.7)
 */

// ---------------------------------------------------------------------------
// Fallback Message Templates (Subtasks 3.1 – 3.3)
// ---------------------------------------------------------------------------

/** No card reached the match threshold for the current page. (Subtask 3.1) */
export const FALLBACK_NO_MATCH =
  "No card matched the current page structure — switching to direct-primitive mode";

/** Card execution failed partway through. (Subtask 3.2) */
export const FALLBACK_EXECUTION_FAILED =
  "Card execution failed at step {step}/{total} — switching to direct-primitive mode";

/** Navigation timed out during card execution. (Subtask 3.3) */
export const FALLBACK_NAVIGATION_TIMEOUT =
  "Navigation timed out during card execution — switching to direct-primitive mode";

// ---------------------------------------------------------------------------
// Helper (Subtask 3.4, 3.5)
// ---------------------------------------------------------------------------

/**
 * Replace `{key}` placeholders in a fallback message template.
 * Pure string replacement — no template literals at runtime.
 *
 * @param template - Message template with `{key}` placeholders
 * @param vars - Key-value pairs to substitute
 * @returns Message with placeholders replaced
 *
 * @example
 * formatFallbackMessage(FALLBACK_EXECUTION_FAILED, { step: "2", total: "3" })
 * // → "Card execution failed at step 2/3 — switching to direct-primitive mode"
 */
export function formatFallbackMessage(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(`{${key}}`, value);
  }
  return result;
}
