import { z } from "zod";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { ToolResponse } from "../types.js";
import { settle } from "../cdp/settle.js";
import { a11yTree } from "../cache/a11y-tree.js";
import { isFatalCdpError, wrapCdpError } from "./error-utils.js";

// --- Schema (Task 1) ---

export const waitForSchema = z.object({
  condition: z
    .enum(["element", "text", "url", "network_idle", "js"])
    .describe("element | text | url | network_idle | js"),
  selector: z
    .string()
    .optional()
    .describe("Condition 'element': CSS selector or ref"),
  text: z
    .string()
    .optional()
    .describe("Condition 'text': substring of document.body.innerText, case-sensitive"),
  url: z
    .string()
    .optional()
    .describe("Condition 'url': substring of the page URL"),
  expression: z
    .string()
    .optional()
    .describe("Condition 'js': expression that should become true"),
  assert: z
    .boolean()
    .optional()
    .default(false)
    .describe("Check once, fail if it does not hold; timeout 0, _meta.code 'assertion_failed'"),
  timeout: z
    .number()
    .optional()
    .describe("Max wait in ms (default 10000; 0 when assert is true)"),
});

export type WaitForParams = z.infer<typeof waitForSchema>;

// --- Constants ---

const POLL_INTERVAL_MS = 200;

// --- Delay helper ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Element condition (Task 2) ---

interface WaitResult {
  found: boolean;
  elapsedMs: number;
}

async function waitForElement(
  cdpClient: CdpClient,
  sessionId: string,
  selector: string,
  timeout: number,
): Promise<WaitResult> {
  const start = performance.now();
  const deadline = start + timeout;
  const isRef = /^e\d+$/.test(selector);

  while (performance.now() < deadline) {
    try {
      let found = false;

      if (isRef) {
        // Ref path.
        // BUG-016 follow-up (final review HIGH #2): use resolveRefFull
        // so the DOM.resolveNode call routes to the ref's owner session,
        // not blindly to the handler's current sessionId. Otherwise an
        // OOPIF ref with a colliding backendNodeId would be checked in
        // the wrong frame and silently time out.
        const full = a11yTree.resolveRefFull(selector);
        if (full !== undefined) {
          const targetSessionId = full.sessionId;
          // Resolve backendNodeId → objectId via DOM.resolveNode on the
          // owner session
          const { object } = await cdpClient.send<{ object: { objectId: string } }>(
            "DOM.resolveNode",
            { backendNodeId: full.backendNodeId },
            targetSessionId,
          );
          // Check visibility via callFunctionOn on the same session
          const { result } = await cdpClient.send<{ result: { value: boolean } }>(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              functionDeclaration:
                "function() { const r = this.getBoundingClientRect(); return r.width > 0 && r.height > 0; }",
              returnByValue: true,
            },
            targetSessionId,
          );
          found = result.value === true;
        }
        // If resolveRefFull returns undefined, ref not in cache yet — keep polling
      } else {
        // CSS path
        const checkExpression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`;
        const evalResult = await cdpClient.send<{ result: { value: boolean } }>(
          "Runtime.evaluate",
          { expression: checkExpression, returnByValue: true },
          sessionId,
        );
        found = evalResult.result.value === true;
      }

      if (found) {
        return { found: true, elapsedMs: Math.round(performance.now() - start) };
      }
    } catch (err) {
      // A node that vanished or a context torn down by navigation: retry.
      // A dead session or transport: stop, the handler reports `cdp_error`.
      if (isFatalCdpError(err)) throw err;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return { found: false, elapsedMs: Math.round(performance.now() - start) };
}

// --- Network idle condition (Task 3) ---

interface NetworkIdleResult {
  settled: boolean;
  signal?: string;
  elapsedMs: number;
}

async function waitForNetworkIdle(
  cdpClient: CdpClient,
  sessionId: string,
  timeout: number,
): Promise<NetworkIdleResult> {
  // Get main frame ID
  const frameTree = await cdpClient.send<{ frameTree: { frame: { id: string } } }>(
    "Page.getFrameTree",
    {},
    sessionId,
  );
  const frameId = frameTree.frameTree.frame.id;

  const settleResult = await settle({
    cdpClient,
    sessionId,
    frameId,
    settleMs: 500,
    timeoutMs: timeout,
  });

  return {
    settled: settleResult.settled,
    signal: settleResult.signal,
    elapsedMs: settleResult.elapsedMs,
  };
}

// --- Text condition ---

/**
 * Poll for a substring of the page's visible text.
 *
 * `innerText` rather than the accessibility tree on purpose: this answers
 * "has the page said X yet", and a reader sees rendered text regardless of
 * whether it carries an accessibility role. Text inside a shadow root or a
 * cross-origin iframe is not part of `document.body.innerText` and will not
 * match — use `condition: "element"` for those.
 */
async function waitForText(
  cdpClient: CdpClient,
  sessionId: string,
  needle: string,
  timeout: number,
): Promise<WaitResult> {
  // JSON.stringify escapes quotes, newlines and unicode for us — the needle
  // is caller data and must never be spliced into source unescaped.
  const expression = `(document.body?.innerText ?? "").includes(${JSON.stringify(needle)})`;
  return pollForTruthy(cdpClient, sessionId, expression, timeout);
}

// --- URL condition ---

async function waitForUrl(
  cdpClient: CdpClient,
  sessionId: string,
  needle: string,
  timeout: number,
): Promise<WaitResult> {
  const expression = `location.href.includes(${JSON.stringify(needle)})`;
  return pollForTruthy(cdpClient, sessionId, expression, timeout);
}

/**
 * Shared poll loop for the boolean conditions. Checks once before the first
 * sleep, so `timeout: 0` is a plain "is it true right now" — which is what
 * `assert` needs.
 */
async function pollForTruthy(
  cdpClient: CdpClient,
  sessionId: string,
  expression: string,
  timeout: number,
): Promise<WaitResult> {
  const start = performance.now();
  const deadline = start + timeout;

  for (;;) {
    try {
      const result = await cdpClient.send<{
        result: { value: unknown };
        exceptionDetails?: unknown;
      }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId);

      if (!result.exceptionDetails && result.result.value === true) {
        return { found: true, elapsedMs: Math.round(performance.now() - start) };
      }
    } catch (err) {
      // Navigation can tear the execution context down mid-poll — retry.
      // A dead session or transport is a different outcome, not a "not yet".
      if (isFatalCdpError(err)) throw err;
    }

    if (performance.now() >= deadline) {
      return { found: false, elapsedMs: Math.round(performance.now() - start) };
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - performance.now())));
  }
}

/**
 * On a failed text/url condition, report what the page actually holds.
 * Truncated hard — this is a hint, not a page dump.
 */
async function currentValueDiagnostic(
  cdpClient: CdpClient,
  sessionId: string,
  isText: boolean,
): Promise<string> {
  try {
    const expression = isText
      ? `(document.body?.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 300)`
      : "location.href";
    const result = await cdpClient.send<{ result: { value: unknown } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
    );
    const value = String(result.result.value ?? "");
    if (value === "") return isText ? " The page has no visible text." : "";
    return isText ? `\nPage text starts: ${value}` : `\nCurrent URL: ${value}`;
  } catch {
    return "";
  }
}

// --- JS condition (Task 4) ---

interface JsWaitResult {
  met: boolean;
  elapsedMs: number;
  lastValue: unknown;
}

async function waitForJs(
  cdpClient: CdpClient,
  sessionId: string,
  expression: string,
  timeout: number,
): Promise<JsWaitResult> {
  const start = performance.now();
  const deadline = start + timeout;
  let lastValue: unknown = undefined;

  while (performance.now() < deadline) {
    try {
      const result = await cdpClient.send<{
        result: { value: unknown };
        exceptionDetails?: unknown;
      }>(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: false,
        },
        sessionId,
      );

      if (!result.exceptionDetails) {
        lastValue = result.result.value;
        if (result.result.value === true) {
          return { met: true, elapsedMs: Math.round(performance.now() - start), lastValue };
        }
      }
      // Exception in expression — swallow and keep polling
    } catch (err) {
      // CDP error — keep polling unless the session itself is gone.
      if (isFatalCdpError(err)) throw err;
    }

    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return { met: false, elapsedMs: Math.round(performance.now() - start), lastValue };
}

// --- Element timeout diagnostics (FR-H7) ---

/**
 * After an element wait_for timeout, check if the element exists in DOM.
 * Returns a diagnostic string helping the LLM understand why the wait failed.
 */
async function elementTimeoutDiagnostic(
  cdpClient: CdpClient,
  sessionId: string,
  selector: string,
): Promise<string> {
  const isRef = /^e\d+$/.test(selector);

  if (isRef) {
    // BUG-016 follow-up: resolveRefFull exposes the owning session, so
    // the diagnostic can tell the LLM whether the ref lives in the main
    // frame or in an OOPIF — useful when a wait_for times out because
    // the ref belongs to a frame that was detached.
    const full = a11yTree.resolveRefFull(selector);
    if (full === undefined) {
      return "\nDebug: Ref not found in cache — page may have changed. Call view_page to get fresh refs.";
    }
    return "\nDebug: Ref exists in cache but element has zero size (hidden or not rendered).";
  }

  // CSS selector path
  try {
    const result = await cdpClient.send<{ result: { value: { exists: boolean; hidden: boolean; tag: string } } }>(
      "Runtime.evaluate",
      {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { exists: false, hidden: false, tag: "" }; const r = el.getBoundingClientRect(); return { exists: true, hidden: r.width === 0 || r.height === 0, tag: el.tagName.toLowerCase() }; })()`,
        returnByValue: true,
      },
      sessionId,
    );
    const v = result.result.value;
    if (!v.exists) {
      return `\nDebug: querySelector('${selector}') returned null — element not in DOM.`;
    }
    if (v.hidden) {
      return `\nDebug: <${v.tag}> exists but has zero size (display: none or collapsed). A preceding action may be needed to reveal it.`;
    }
    return `\nDebug: <${v.tag}> exists with size > 0 but visibility check failed.`;
  } catch {
    return "";
  }
}

// --- JS timeout diagnostics (FR-006) ---

/**
 * Extract the first CSS selector from a querySelector/getElementById call in a JS expression.
 * Returns the CSS selector string, or null if none found.
 */
export function extractSelector(expression: string): string | null {
  // Match querySelector('...') or querySelector("...")
  const qsMatch = expression.match(/querySelector\(\s*(['"])(.*?)\1\s*\)/);
  if (qsMatch) return qsMatch[2];

  // Match getElementById('...') or getElementById("...")
  const idMatch = expression.match(/getElementById\(\s*(['"])(.*?)\1\s*\)/);
  if (idMatch) return `#${idMatch[2]}`;

  return null;
}

/**
 * After a JS wait_for timeout, check if the extracted selector's element exists in the DOM.
 * Returns a diagnostic line or empty string if no selector was found.
 */
async function jsTimeoutDiagnostic(
  cdpClient: CdpClient,
  sessionId: string,
  expression: string,
): Promise<string> {
  const selector = extractSelector(expression);
  if (!selector) return "";

  try {
    const result = await cdpClient.send<{ result: { value: boolean } }>(
      "Runtime.evaluate",
      {
        expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
        returnByValue: true,
      },
      sessionId,
    );

    if (result.result.value === true) {
      return `\nDebug: Element exists but condition not met (content may still be loading).`;
    }
    return `\nDebug: querySelector('${selector}') returned null — element not found in DOM.`;
  } catch {
    // If CDP call fails, skip diagnostics
    return "";
  }
}

// --- Main handler (Task 5) ---

export async function waitForHandler(
  params: WaitForParams,
  cdpClient: CdpClient,
  sessionId?: string,
): Promise<ToolResponse> {
  const start = performance.now();
  const asserting = params.assert ?? false;
  // Assertions check the here-and-now; waits get the historical 10 s budget.
  const timeout = params.timeout ?? (asserting ? 0 : 10_000);

  // Validation (Task 1.4)
  const required: Partial<Record<WaitForParams["condition"], [string, string | undefined]>> = {
    element: ["selector", params.selector],
    text: ["text", params.text],
    url: ["url", params.url],
    js: ["expression", params.expression],
  };
  const missing = required[params.condition];
  if (missing && (!missing[1] || missing[1].trim() === "")) {
    const hint = params.condition === "element" ? " (CSS selector or ref like 'e5')" : "";
    const article = /^[aeiou]/.test(missing[0]) ? "an" : "a";
    return {
      content: [
        {
          type: "text",
          text: `wait_for condition '${params.condition}' requires ${article} '${missing[0]}' parameter${hint}`,
        },
      ],
      isError: true,
      _meta: { elapsedMs: 0, method: "wait_for", code: "invalid_params" },
    };
  }

  try {
    switch (params.condition) {
      case "element": {
        const result = await waitForElement(
          cdpClient,
          sessionId!,
          params.selector!,
          timeout,
        );
        if (result.found) {
          return {
            content: [
              {
                type: "text",
                text: `Condition 'element' met after ${result.elapsedMs}ms — selector: ${params.selector}`,
              },
            ],
            _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: "element" },
          };
        }
        // FR-H7: Append diagnostic info on timeout
        const diagnostic = await elementTimeoutDiagnostic(cdpClient, sessionId!, params.selector!);

        return {
          content: [
            {
              type: "text",
              text: asserting
                ? `Assertion failed: element '${params.selector}' is not visible${diagnostic}`
                : `Timeout after ${timeout}ms waiting for element '${params.selector}' to become visible${diagnostic}`,
            },
          ],
          isError: true,
          _meta: {
            elapsedMs: result.elapsedMs,
            method: "wait_for",
            condition: "element",
            code: asserting ? "assertion_failed" : "timeout",
          },
        };
      }

      case "network_idle": {
        const result = await waitForNetworkIdle(cdpClient, sessionId!, timeout);
        if (result.settled) {
          return {
            content: [
              {
                type: "text",
                text: `Condition 'network_idle' met after ${result.elapsedMs}ms`,
              },
            ],
            _meta: {
              elapsedMs: result.elapsedMs,
              method: "wait_for",
              condition: "network_idle",
              settleSignal: result.signal,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Timeout after ${timeout}ms waiting for network idle (signal: ${result.signal})`,
            },
          ],
          isError: true,
          _meta: {
            elapsedMs: result.elapsedMs,
            method: "wait_for",
            condition: "network_idle",
            settleSignal: result.signal,
            code: asserting ? "assertion_failed" : "timeout",
          },
        };
      }

      case "text":
      case "url": {
        const isText = params.condition === "text";
        const needle = (isText ? params.text : params.url)!;
        const result = isText
          ? await waitForText(cdpClient, sessionId!, needle, timeout)
          : await waitForUrl(cdpClient, sessionId!, needle, timeout);

        if (result.found) {
          return {
            content: [
              {
                type: "text",
                text: asserting
                  ? `Assertion held: ${params.condition} contains ${JSON.stringify(needle)}`
                  : `Condition '${params.condition}' met after ${result.elapsedMs}ms — ${JSON.stringify(needle)}`,
              },
            ],
            _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: params.condition },
          };
        }

        // Show what IS there — a caller comparing the expected substring
        // against the actual page can usually see the mismatch immediately.
        const actual = await currentValueDiagnostic(cdpClient, sessionId!, isText);
        return {
          content: [
            {
              type: "text",
              text: asserting
                ? `Assertion failed: ${params.condition} does not contain ${JSON.stringify(needle)}.${actual}`
                : `Timeout after ${timeout}ms waiting for ${params.condition} to contain ${JSON.stringify(needle)}.${actual}`,
            },
          ],
          isError: true,
          _meta: {
            elapsedMs: result.elapsedMs,
            method: "wait_for",
            condition: params.condition,
            code: asserting ? "assertion_failed" : "timeout",
          },
        };
      }

      case "js": {
        const result = await waitForJs(
          cdpClient,
          sessionId!,
          params.expression!,
          timeout,
        );
        if (result.met) {
          return {
            content: [
              {
                type: "text",
                text: `Condition 'js' met after ${result.elapsedMs}ms`,
              },
            ],
            _meta: { elapsedMs: result.elapsedMs, method: "wait_for", condition: "js" },
          };
        }

        // FR-006: Append diagnostic info when a querySelector/getElementById is detected
        const diagnostic = await jsTimeoutDiagnostic(cdpClient, sessionId!, params.expression!);

        return {
          content: [
            {
              type: "text",
              text: asserting
                ? `Assertion failed: JS expression did not return true. Last evaluation returned: ${JSON.stringify(result.lastValue)}${diagnostic}`
                : `Timeout after ${timeout}ms waiting for JS expression to return true. Last evaluation returned: ${JSON.stringify(result.lastValue)}${diagnostic}`,
            },
          ],
          isError: true,
          _meta: {
            elapsedMs: result.elapsedMs,
            method: "wait_for",
            condition: "js",
            code: asserting ? "assertion_failed" : "timeout",
          },
        };
      }
    }
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - start);
    return {
      content: [{ type: "text", text: wrapCdpError(err, "wait_for") }],
      isError: true,
      _meta: { elapsedMs, method: "wait_for", code: "cdp_error" },
    };
  }
}
