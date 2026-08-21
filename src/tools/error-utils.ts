/**
 * Wrap CDP connection errors into user-friendly error messages.
 * Used across all tools to provide consistent error messages during reconnect scenarios.
 *
 * @param elementHint - Optional identifier for the element involved (e.g. ref "e5" or selector "#btn").
 *   Used to enrich "not visible" errors so the LLM knows which element failed.
 */
export function wrapCdpError(err: unknown, toolName: string, elementHint?: string): string {
  const message = err instanceof Error ? err.message : String(err);

  if (isTransportError(message)) {
    return "CDP connection lost. The server is attempting to reconnect. Retry your request in a few seconds.";
  }

  if (isSessionGoneError(message)) {
    return `${toolName} failed: ${message}. Use virtual_desk to discover available tabs and reconnect.`;
  }

  // FR-003: Element exists in DOM but has no visual layout (display:none, hidden tab, etc.)
  if (
    message.includes("Node does not have a layout object") ||
    message.includes("Could not compute content quads")
  ) {
    const elem = elementHint ?? "target element";
    return `${toolName} failed: Element ${elem} exists in the DOM but is not visible (no layout — likely display:none, hidden, or inside an inactive tab/panel). Use a CSS selector targeting the visible instance, or check if the element needs to be revealed first (e.g. switch tab, expand section).`;
  }

  return `${toolName} failed: ${message}`;
}

function isTransportError(message: string): boolean {
  return (
    message.includes("CdpClient is closed") ||
    message.includes("CdpClient closed") ||
    message.includes("Transport is not connected") ||
    message.includes("Transport closed unexpectedly") ||
    message.includes("Transport error:")
  );
}

function isSessionGoneError(message: string): boolean {
  return (
    message.includes("Session with given id not found") ||
    message.includes("No target with given id found")
  );
}

/**
 * Whether a CDP failure means the session or its transport is gone — as
 * opposed to a check that merely could not run right now because the page
 * navigated, the execution context was torn down, or a node disappeared.
 *
 * Poll loops use this to decide between "retry on the next tick" and "stop,
 * the browser is not there any more". A script driving the browser without
 * an LLM needs that distinction: a condition that never became true and a
 * dead session call for different recoveries, and `_meta.code` is where it
 * learns which one it got.
 */
export function isFatalCdpError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    isTransportError(message) ||
    isSessionGoneError(message) ||
    // The CDP client's own timeout — Chrome stopped answering this session.
    /^CDP call ".*" timed out after \d+ms$/.test(message)
  );
}
