import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { wrapCdpError } from "./error-utils.js";

/**
 * Detects top-level const/let/class declarations and wraps the expression in
 * an IIFE to avoid "Identifier has already been declared" errors across
 * repeated Runtime.evaluate calls (which share the global scope).
 *
 * The last ExpressionStatement is automatically returned so callers still
 * get the evaluation result.
 */
export function wrapInIIFE(expression: string): string {
  // Quick check: does the code contain any top-level const/let/class?
  // We match at the beginning of a line (after optional whitespace) to avoid
  // matching inside strings/comments in most practical cases.
  const needsWrap = /^[ \t]*(const|let|class)\s/m.test(expression);
  if (!needsWrap) return expression;

  // Already wrapped in an IIFE? Don't double-wrap.
  const trimmed = expression.trim();
  if (/^\([\s\S]*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed)) return expression;

  return `(() => {\n${expression}\n})()`;
}

export const evaluateSchema = z.object({
  expression: z.string().describe("JavaScript code to execute in the page context"),
  await_promise: z
    .boolean()
    .optional()
    .default(true)
    .describe("Whether to await Promise results"),
});

export type EvaluateParams = z.infer<typeof evaluateSchema>;

interface RuntimeEvaluateResult {
  result: {
    type: string;
    subtype?: string;
    value?: unknown;
    description?: string;
    className?: string;
  };
  exceptionDetails?: {
    exceptionId: number;
    text: string;
    exception?: {
      type: string;
      subtype?: string;
      className?: string;
      description?: string;
    };
  };
}

export async function evaluateHandler(
  params: EvaluateParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();

  try {
    const wrappedExpression = wrapInIIFE(params.expression);

    const cdpResult = await cdpClient.send<RuntimeEvaluateResult>(
      "Runtime.evaluate",
      {
        expression: wrappedExpression,
        returnByValue: true,
        awaitPromise: params.await_promise,
      },
      sessionId,
    );

    const elapsedMs = Math.round(performance.now() - start);

    // Check for JS exception
    if (cdpResult.exceptionDetails) {
      const details = cdpResult.exceptionDetails;
      const message =
        details.exception?.description || details.text || "Unknown JavaScript error";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
        _meta: { elapsedMs, method: "evaluate" },
      };
    }

    // Extract result value
    const resultValue = cdpResult.result;
    let text: string;
    if (resultValue.type === "undefined") {
      text = "undefined";
    } else if (resultValue.value === undefined) {
      // Non-serializable result (e.g. DOM nodes) — returnByValue couldn't serialize
      const desc = resultValue.description || resultValue.className || resultValue.subtype || resultValue.type;
      return {
        content: [{ type: "text", text: `Result not serializable: ${desc}` }],
        isError: true,
        _meta: { elapsedMs, method: "evaluate" },
      };
    } else {
      text = JSON.stringify(resultValue.value);
    }

    return {
      content: [{ type: "text", text }],
      _meta: { elapsedMs, method: "evaluate" },
    };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "evaluate") }],
      isError: true,
      _meta: { elapsedMs, method: "evaluate" },
    };
  }
}
