import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Stufe 2 H3 — advice at most once per MCP session.
 *
 * The rule (Plancheck P14): advice — tips and hints that suggest another way,
 * a better tool or the next step — shows at most once per MCP session and
 * kind. State — counts, truncation notes ("[!] TRUNCATED", "Note: N elements
 * collapsed …"), statements about exactly this call (the macOS Control hint of
 * press_key, the result notes of drag) — shows in every response and never
 * goes through this ledger. Error responses (evaluate STOP/REFUSED) neither.
 *
 * "Session" is the connection of one MCP client: over stdio that is the
 * lifetime of the server process (Claude Code starts one per conversation).
 * A client that initializes the same server again starts a new session
 * (`resetHintLedgerOnInitialize`). Not meant are CDP sessions (a tab, an
 * iframe) — `toolSequence` counts evaluate streaks per CDP session, but a tab
 * switch, a navigation or configure_session is no new conversation for the
 * model. Every Node-library session (`createSession`, worker or process
 * isolation) has its own module instance and so its own ledger.
 *
 * Known limit: Claude Code's /clear keeps the MCP process running without a
 * new initialize — the ledger stays full, advice shown before /clear does not
 * come back.
 *
 * Why (run3, 23.09.2026): the same two tips came 17× and 15× — after the first
 * one the model still used evaluate the same way 18 more times.
 */

/** Stable names of the advice kinds. Each shows at most once per session. */
export const HINT_KIND = {
  domQuery: "evaluate:dom-query",
  testSource: "evaluate:test-source",
  jsScroll: "evaluate:js-scroll",
  jsClick: "evaluate:js-click",
  dialog: "evaluate:dialog",
  pageScroll: "evaluate:page-scroll",
  authFetch: "evaluate:auth-fetch",
  streakWarning: "evaluate:streak-warning",
  streakNotice: "evaluate:streak-notice",
  fillForm: "type:fill-form",
  viewPageHiddenInteractive: "view_page:hidden-interactive",
  viewPageHiddenContent: "view_page:hidden-content",
  captureImageStop: "capture_image:use-view-page",
  navigateNext: "navigate:next",
  clickNoVisibleChange: "click:no-visible-change",
} as const;

/**
 * Plancheck P15: a hint counts as shown only once it reaches the model in a
 * top-level MCP response. executeTool() serves run_plan steps (the model sees
 * the first line of an OK step, at most 80 chars) and the Script API (Python
 * cuts hints off); it runs every call inside withoutHintDelivery(). Hints may
 * still be appended there, but they are not used up.
 */
const hintDelivery = new AsyncLocalStorage<boolean>();

/** Runs `fn` as a call whose response does not reach the model whole at top level. */
export function withoutHintDelivery<T>(fn: () => Promise<T>): Promise<T> {
  return hintDelivery.run(false, fn);
}

/**
 * false inside withoutHintDelivery(); true otherwise — direct MCP calls through
 * the registry's wrap() closure, and handlers called directly (tests).
 */
export function hintsReachModel(): boolean {
  return hintDelivery.getStore() !== false;
}

export class HintLedger {
  private readonly shown = new Set<string>();

  /**
   * true when the caller may show the hint of this kind: it was not shown in
   * this session yet. Call it only where the hint really goes into the
   * response. Outside withoutHintDelivery() this also marks the kind as shown.
   */
  claim(kind: string): boolean {
    if (this.shown.has(kind)) return false;
    if (hintsReachModel()) this.shown.add(kind);
    return true;
  }

  /** Re-arm every kind (new MCP session, tests). */
  reset(): void {
    this.shown.clear();
  }
}

/** Module singleton, like `toolSequence`. */
export const hintLedger = new HintLedger();

/**
 * Hooks the reset onto the MCP client's `initialized` notification. Takes the
 * shape `{ server?: { oninitialized? } }` on purpose, so test doubles without
 * an inner `Server` pass. A callback that was set before is kept.
 */
export function resetHintLedgerOnInitialize(mcpServer: { server?: { oninitialized?: () => void } }): void {
  const inner = mcpServer.server;
  if (!inner) return;
  const previous = inner.oninitialized;
  inner.oninitialized = () => {
    hintLedger.reset();
    previous?.();
  };
}
