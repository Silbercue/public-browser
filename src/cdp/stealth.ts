/**
 * Stealth toggle — central switch for the `navigator.webdriver` masking.
 *
 * Historically (FR-025) Public Browser masked `navigator.webdriver`
 * unconditionally in three places:
 *   1. on attach            (browser-session.ts)
 *   2. after each navigation (navigate.ts)
 *   3. on tab switch         (switch-tab.ts)
 * plus the `--disable-blink-features=AutomationControlled` launch flag.
 *
 * That is the right default for consumer automation, but it is the WRONG
 * default for integrators that must be transparently identifiable as a bot
 * (compliance-driven crawling, internal agent fleets, sites whose ToS
 * require honest automation signalling). Those callers need
 * `navigator.webdriver === true` AND an untouched native getter — i.e. a
 * getter whose `toString()` still reports `[native code]`, which a
 * re-defined property can never do.
 *
 * Therefore the masking is now opt-out:
 *   - CLI:  `--no-stealth`
 *   - Env:  `SILBERCUE_STEALTH=0` (alias: `PUBLIC_BROWSER_STEALTH=0`)
 *   - API:  `createSession({ stealth: false })` / `startServer({ stealth: false })`
 *
 * When disabled, NO masking script is injected at any of the three sites and
 * the launcher omits `--disable-blink-features=AutomationControlled`, so the
 * property stays exactly as Chrome shipped it — permanently, with no
 * post-correction needed on the client side.
 */

/** The injected masking expression. Kept in one place so all three call sites stay in sync. */
export const WEBDRIVER_MASK_SOURCE =
  "Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});";

/** Env var names checked by `resolveStealth`, in precedence order. */
export const STEALTH_ENV_VARS = ["SILBERCUE_STEALTH", "PUBLIC_BROWSER_STEALTH"] as const;

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

/**
 * Resolve the effective stealth setting.
 * Pure function — no side effects, fully testable.
 *
 * Precedence: explicit option > SILBERCUE_STEALTH > PUBLIC_BROWSER_STEALTH > default (true).
 * An unrecognised env value is ignored (falls through to the next source),
 * so a typo never silently disables the masking.
 */
export function resolveStealth(
  env: Record<string, string | undefined>,
  explicit?: boolean,
): boolean {
  if (typeof explicit === "boolean") return explicit;

  for (const name of STEALTH_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined) continue;
    const val = raw.trim().toLowerCase();
    if (FALSY.has(val)) return false;
    if (TRUTHY.has(val)) return true;
    // Unrecognised value — ignore and try the next source.
  }

  return true;
}

/**
 * Runtime stealth state. Module-global by design: the three call sites
 * (attach / navigate / switch-tab) are spread across tool handlers that
 * receive no session object, mirroring how `emulation.ts` handles the
 * headless flag.
 *
 * Multi-instance safety: each `createSession()` runs in its own worker
 * thread (see `src/lib/create-session.ts`), so every instance gets its own
 * module registry and therefore its own copy of this flag.
 */
let _stealthEnabled = true;

/** Set the runtime stealth state. Called once during session startup. */
export function setStealthEnabled(value: boolean): void {
  _stealthEnabled = value;
}

/** Whether `navigator.webdriver` masking is active. */
export function isStealthEnabled(): boolean {
  return _stealthEnabled;
}

/** Minimal CDP surface needed for masking — keeps this module dependency-free. */
interface MaskCapableClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
}

export interface MaskOptions {
  /**
   * Also register the mask via `Page.addScriptToEvaluateOnNewDocument` so it
   * survives future navigations in this target. Default: true.
   * `navigate` passes `false` because it only needs to patch the document
   * that just finished loading.
   */
  newDocument?: boolean;
  /**
   * Also apply the mask to the CURRENT document via `Runtime.evaluate`.
   * Default: true. `addScriptToEvaluateOnNewDocument` alone does not cover
   * an already-loaded document and does not fire reliably in WebSocket mode.
   */
  currentDocument?: boolean;
}

/**
 * Apply the `navigator.webdriver` mask to a CDP session.
 * No-op when stealth is disabled — this is the single guard that all three
 * historical call sites now funnel through.
 *
 * Never throws: masking is best-effort hardening, not a correctness
 * requirement, and a failure here must not break the surrounding tool call.
 */
export async function applyWebdriverMask(
  cdpClient: MaskCapableClient,
  sessionId: string | undefined,
  options: MaskOptions = {},
): Promise<void> {
  if (!_stealthEnabled) return;

  const { newDocument = true, currentDocument = true } = options;

  if (newDocument) {
    try {
      await cdpClient.send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: WEBDRIVER_MASK_SOURCE },
        sessionId,
      );
    } catch {
      /* non-critical */
    }
  }

  if (currentDocument) {
    try {
      await cdpClient.send(
        "Runtime.evaluate",
        { expression: WEBDRIVER_MASK_SOURCE, awaitPromise: false },
        sessionId,
      );
    } catch {
      /* non-critical */
    }
  }
}
