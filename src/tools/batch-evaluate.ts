import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { settle } from "../cdp/settle.js";
import { wrapInIIFE } from "./evaluate.js";

export const batchEvaluateSchema = z.object({
  urls: z.array(z.string()).describe("Array of URLs to visit and evaluate sequentially"),
  evaluate_per_page: z.string().describe("JavaScript expression to evaluate on each page after it loads"),
  settle_ms: z.number().optional().default(2000).describe("Wait time in ms after each page load before evaluating (default: 2000)"),
  timeout_per_page_ms: z.number().optional().default(30000).describe("Timeout per page in ms for the full navigate+settle+evaluate cycle (default: 30000)"),
  continue_on_error: z.boolean().optional().default(true).describe("Continue processing remaining URLs if one fails (default: true)"),
});

export type BatchEvaluateParams = z.infer<typeof batchEvaluateSchema>;

interface PageNavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

interface EvalResult {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

const MAX_RESULT_BYTES = 10_240;

interface BatchResultEntry {
  url: string;
  result?: unknown;
  error?: string;
  truncated?: boolean;
  elapsed_ms: number;
}

export async function batchEvaluateHandler(
  params: BatchEvaluateParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();
  const method = "batch_evaluate";

  if (params.urls.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({ results: [], total: 0, succeeded: 0, failed: 0, elapsed_ms: 0 }) }],
      _meta: { elapsedMs: 0, method },
    };
  }

  const wrappedExpression = wrapInIIFE(params.evaluate_per_page);
  const results: BatchResultEntry[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const url of params.urls) {
    const pageStart = performance.now();

    try {
      const entry = await withTimeout(
        processPage(cdpClient, sessionId, url, wrappedExpression, params.settle_ms, pageStart),
        params.timeout_per_page_ms,
        url,
      );
      results.push(entry);
      if (entry.error) {
        failed++;
        if (!params.continue_on_error) break;
      } else {
        succeeded++;
      }
    } catch (err) {
      const entry: BatchResultEntry = {
        url,
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: Math.round(performance.now() - pageStart),
      };
      results.push(entry);
      failed++;
      if (!params.continue_on_error) break;
    }
  }

  const elapsedMs = Math.round(performance.now() - start);

  return {
    content: [{ type: "text", text: JSON.stringify({
      results,
      total: params.urls.length,
      succeeded,
      failed,
      elapsed_ms: elapsedMs,
    }) }],
    _meta: { elapsedMs, method },
  };
}

async function processPage(
  cdpClient: CdpClient,
  sessionId: string | undefined,
  url: string,
  expression: string,
  settleMs: number,
  pageStart: number,
): Promise<BatchResultEntry> {
  const navResult = await cdpClient.send<PageNavigateResult>(
    "Page.navigate",
    { url },
    sessionId,
  );

  if (navResult.errorText) {
    return {
      url,
      error: `Navigation failed: ${navResult.errorText}`,
      elapsed_ms: Math.round(performance.now() - pageStart),
    };
  }

  const isSpa = !navResult.loaderId;
  await settle({
    cdpClient,
    sessionId: sessionId!,
    frameId: navResult.frameId,
    loaderId: navResult.loaderId,
    spaNavigation: isSpa,
    settleMs,
  });

  const evalResult = await cdpClient.send<EvalResult>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );

  if (evalResult.exceptionDetails) {
    const desc = evalResult.exceptionDetails.exception?.description
      ?? evalResult.exceptionDetails.text;
    return {
      url,
      error: `Evaluation error: ${desc}`,
      elapsed_ms: Math.round(performance.now() - pageStart),
    };
  }

  let result = evalResult.result.value;
  let truncated = false;

  const serialized = JSON.stringify(result);
  if (serialized && serialized.length > MAX_RESULT_BYTES) {
    if (typeof result === "string") {
      result = result.slice(0, MAX_RESULT_BYTES) + "...[truncated]";
    }
    truncated = true;
  }

  return {
    url,
    result,
    truncated: truncated || undefined,
    elapsed_ms: Math.round(performance.now() - pageStart),
  };
}

function withTimeout(
  promise: Promise<BatchResultEntry>,
  timeoutMs: number,
  url: string,
): Promise<BatchResultEntry> {
  return new Promise<BatchResultEntry>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({
        url,
        error: `Timeout after ${timeoutMs}ms`,
        elapsed_ms: timeoutMs,
      });
    }, timeoutMs);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
