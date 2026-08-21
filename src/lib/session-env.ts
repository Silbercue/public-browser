/**
 * Environment construction for library sessions.
 *
 * Two rules, both of them things an integrator running several agents in one
 * host process needs to be able to rely on:
 *
 * 1. **No Public Browser variable leaks in.** Every `SILBERCUE_*` /
 *    `PUBLIC_BROWSER_*` config variable has an explicit `createSession()`
 *    option, so a host-level variable — typically set for the host's *own*
 *    Chrome — must not reconfigure a session behind the caller's back. The
 *    concrete failure this prevents: `SILBERCUE_CHROME_HOST=10.9.9.9` in the
 *    orchestrator's environment silently redirecting a session that was
 *    created with `cdpPort: 9450`. Set one back deliberately via `env`.
 *
 * 2. **The rest of the environment is opt-in.** A session starts from
 *    `ESSENTIAL_ENV_VARS` only — what Node needs to resolve a binary and what
 *    Chrome needs to find a home directory, a temp dir and a display. A host
 *    process orchestrating agents typically holds cloud credentials, API keys
 *    and tokens, and none of that belongs in a browser session by default.
 *    `inheritEnv: ["HTTPS_PROXY", "AWS_REGION", ...]` adds what a session
 *    genuinely needs, `inheritEnv: true` restores full inheritance for hosts
 *    that want it.
 *
 *    Note for proxy setups: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` are NOT
 *    essential — a proxy URL can carry credentials, so it is allowlisted
 *    deliberately rather than inherited by accident.
 */

import { PUBLIC_BROWSER_ENV_VARS } from "../config.js";

/**
 * The variables a session always gets. Without these Node cannot resolve a
 * binary, Chrome cannot find a home directory or a writable temp dir, and on
 * Windows process creation itself fails.
 *
 * Deliberately excluded: anything that can carry a secret (proxy URLs, cloud
 * credentials, tokens) and anything Public Browser reads as configuration —
 * see `PUBLIC_BROWSER_ENV_VARS`.
 */
export const ESSENTIAL_ENV_VARS: readonly string[] = [
  // POSIX
  "PATH",
  "HOME",
  "TMPDIR",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TZ",
  // Linux desktop — Chrome needs these to talk to an X/Wayland session
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XAUTHORITY",
  // Windows
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  // Public Browser's own Chrome lookup — a path, not a secret. Without it an
  // isolated session cannot find a Chrome installed outside the default
  // locations, and the failure looks like "Chrome not found" rather than
  // "your environment was filtered".
  "CHROME_PATH",
];

/** Inheritance policy for a session's environment. */
export type InheritEnv = boolean | readonly string[];

export interface SessionEnvOptions {
  /**
   * `false` (default) starts from `ESSENTIAL_ENV_VARS` only, an array adds the
   * names you list, `true` inherits the whole host environment.
   */
  inheritEnv?: InheritEnv;
  /** Cortex pattern store for this session (`PUBLIC_BROWSER_CORTEX_DIR`). */
  cortexDir?: string;
  /** Explicit overrides, applied last. `undefined` unsets a variable. */
  env?: Record<string, string | undefined>;
}

/**
 * Build the environment a session thread or child process runs with.
 *
 * Order: inheritance policy → strip every Public Browser variable →
 * `cortexDir` → caller `env` (which can re-add anything, including a
 * stripped variable).
 */
export function buildSessionEnv(
  hostEnv: Record<string, string | undefined>,
  options: SessionEnvOptions = {},
): Record<string, string> {
  const inherit = options.inheritEnv ?? false;

  let base: Record<string, string | undefined>;
  if (inherit === true) {
    base = { ...hostEnv };
  } else {
    const keep = new Set<string>(ESSENTIAL_ENV_VARS);
    if (Array.isArray(inherit)) for (const name of inherit) keep.add(name);
    base = {};
    // Case-insensitive on Windows, where `Path` and `PATH` are the same key.
    const wanted = new Map<string, string>();
    for (const name of keep) wanted.set(name.toLowerCase(), name);
    for (const [key, value] of Object.entries(hostEnv)) {
      if (wanted.has(key.toLowerCase())) base[key] = value;
    }
  }

  // Rule 1 — no Public Browser configuration travels in implicitly.
  for (const name of PUBLIC_BROWSER_ENV_VARS) delete base[name];

  if (options.cortexDir) base.PUBLIC_BROWSER_CORTEX_DIR = options.cortexDir;

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) delete base[key];
      else base[key] = value;
    }
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
