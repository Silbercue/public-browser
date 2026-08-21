/**
 * Environment configuration resolvers.
 *
 * Multi-instance operation (one Public Browser per Chrome, several Chromes
 * per machine) is driven entirely by environment variables and CLI flags.
 * The names below are part of the PUBLIC contract — integrators pin them in
 * process supervisors and container manifests, so they must stay stable.
 *
 * Canonical names keep the historical `SILBERCUE_` prefix; the
 * `PUBLIC_BROWSER_` names are supported aliases introduced with the rename
 * and take lower precedence.
 *
 * | Setting        | CLI                 | Canonical env            | Alias                        |
 * |----------------|---------------------|--------------------------|------------------------------|
 * | CDP port       | `--port`            | `SILBERCUE_CHROME_PORT`  | `PUBLIC_BROWSER_CHROME_PORT` |
 * | CDP host       | `--host`            | `SILBERCUE_CHROME_HOST`  | `PUBLIC_BROWSER_CHROME_HOST` |
 * | Script API port| `--script-port`     | `SILBERCUE_SCRIPT_PORT`  | `PUBLIC_BROWSER_SCRIPT_PORT` |
 * | Download dir   | `--download-dir`    | `PUBLIC_BROWSER_DOWNLOAD_DIR` | —                       |
 * | Download hash  | `--download-hash`   | `PUBLIC_BROWSER_DOWNLOAD_HASH` | —                      |
 * | Download naming| `--download-naming` | `PUBLIC_BROWSER_DOWNLOAD_NAMING` | —                    |
 * | Cortex store   | —                   | `PUBLIC_BROWSER_CORTEX_DIR` | —                         |
 * | Stealth        | `--no-stealth`      | `SILBERCUE_STEALTH`      | `PUBLIC_BROWSER_STEALTH`     |
 * | Headless       | —                   | `SILBERCUE_CHROME_HEADLESS` | —                         |
 * | Profile        | `--profile <name>`  | `PUBLIC_BROWSER_PROFILE` | `SILBERCUE_CHROME_PROFILE`   |
 * | User data dir  | `--user-data-dir`   | —                        | —                            |
 */

export type Env = Record<string, string | undefined>;

/** How files are named inside the download directory. */
export type DownloadNaming = "guid" | "suggested";

export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_SCRIPT_PORT = 9223;
export const DEFAULT_CDP_HOST = "127.0.0.1";

export const CDP_PORT_ENV_VARS = [
  "SILBERCUE_CHROME_PORT",
  "PUBLIC_BROWSER_CHROME_PORT",
] as const;

export const CDP_HOST_ENV_VARS = [
  "SILBERCUE_CHROME_HOST",
  "PUBLIC_BROWSER_CHROME_HOST",
] as const;

export const SCRIPT_PORT_ENV_VARS = [
  "SILBERCUE_SCRIPT_PORT",
  "PUBLIC_BROWSER_SCRIPT_PORT",
] as const;

export const DOWNLOAD_DIR_ENV_VARS = ["PUBLIC_BROWSER_DOWNLOAD_DIR"] as const;
export const DOWNLOAD_HASH_ENV_VARS = ["PUBLIC_BROWSER_DOWNLOAD_HASH"] as const;
export const DOWNLOAD_NAMING_ENV_VARS = ["PUBLIC_BROWSER_DOWNLOAD_NAMING"] as const;
export const CORTEX_DIR_ENV_VARS = ["PUBLIC_BROWSER_CORTEX_DIR"] as const;
export const PROFILE_ENV_VARS = [
  "PUBLIC_BROWSER_PROFILE",
  "SILBERCUE_CHROME_PROFILE",
] as const;
export const HEADLESS_ENV_VARS = ["SILBERCUE_CHROME_HEADLESS"] as const;
export const STEALTH_ENV_VARS = ["SILBERCUE_STEALTH", "PUBLIC_BROWSER_STEALTH"] as const;

/**
 * Every environment variable Public Browser itself reads as configuration.
 *
 * The library API (`createSession`) strips these from a session's environment
 * because each of them has an explicit option: a host-level `SILBERCUE_*`
 * intended for the host's own Chrome must never silently reconfigure a
 * session the integrator configured through options. Pass `env` to set one
 * back deliberately.
 */
export const PUBLIC_BROWSER_ENV_VARS: readonly string[] = [
  ...CDP_PORT_ENV_VARS,
  ...CDP_HOST_ENV_VARS,
  ...SCRIPT_PORT_ENV_VARS,
  ...DOWNLOAD_DIR_ENV_VARS,
  ...DOWNLOAD_HASH_ENV_VARS,
  ...DOWNLOAD_NAMING_ENV_VARS,
  ...CORTEX_DIR_ENV_VARS,
  ...PROFILE_ENV_VARS,
  ...HEADLESS_ENV_VARS,
  ...STEALTH_ENV_VARS,
];

/** Thrown when an env var or flag holds a value we refuse to guess about. */
export class ConfigError extends Error {}

function firstDefined(env: Env, names: readonly string[]): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      return { name, value: value.trim() };
    }
  }
  return null;
}

function parsePort(name: string, raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name}="${raw}" is not a valid port (1-65535).`);
  }
  return port;
}

/**
 * Resolve the CDP port. Precedence: explicit (CLI/API) > canonical env >
 * alias env > 9222. Throws `ConfigError` on an unparseable value — a wrong
 * port must fail loudly, otherwise the instance silently attaches to
 * whichever Chrome happens to own 9222.
 */
export function resolveCdpPort(env: Env, explicit?: number): number {
  if (explicit !== undefined) return parsePort("--port", String(explicit));
  const hit = firstDefined(env, CDP_PORT_ENV_VARS);
  return hit ? parsePort(hit.name, hit.value) : DEFAULT_CDP_PORT;
}

/** Resolve the Script API port. Same precedence rules as `resolveCdpPort`. */
export function resolveScriptPort(env: Env, explicit?: number): number {
  if (explicit !== undefined) return parsePort("--script-port", String(explicit));
  const hit = firstDefined(env, SCRIPT_PORT_ENV_VARS);
  return hit ? parsePort(hit.name, hit.value) : DEFAULT_SCRIPT_PORT;
}

/** Resolve the CDP host. Defaults to loopback. */
export function resolveCdpHost(env: Env, explicit?: string): string {
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const hit = firstDefined(env, CDP_HOST_ENV_VARS);
  return hit ? hit.value : DEFAULT_CDP_HOST;
}

/** Resolve the download directory. `undefined` means "use a temp dir". */
export function resolveDownloadDir(env: Env, explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const hit = firstDefined(env, DOWNLOAD_DIR_ENV_VARS);
  return hit?.value;
}

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);

/** Resolve whether completed downloads should be SHA-256 hashed. */
export function resolveDownloadHash(env: Env, explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  const hit = firstDefined(env, DOWNLOAD_HASH_ENV_VARS);
  return hit ? TRUTHY.has(hit.value.toLowerCase()) : false;
}

/**
 * Naming scheme for files Chrome writes into the download directory.
 *
 * `"guid"` (default, historical) keeps Chrome's `allowAndName` behaviour: the
 * file on disk is the download GUID and the real name only appears in
 * `DownloadInfo.filename`. `"suggested"` renames the finished file to the
 * server-suggested filename (sanitised, with a `-1`, `-2`, ... suffix on
 * collision), which is what an integrator quarantining files on disk wants.
 */
export function resolveDownloadNaming(env: Env, explicit?: string): DownloadNaming {
  const raw = explicit ?? firstDefined(env, DOWNLOAD_NAMING_ENV_VARS)?.value;
  if (raw === undefined) return "guid";
  const value = raw.trim().toLowerCase();
  if (value === "guid" || value === "suggested") return value;
  const source = explicit !== undefined ? "--download-naming" : DOWNLOAD_NAMING_ENV_VARS[0];
  throw new ConfigError(`${source}="${raw}" is not a valid naming mode (guid|suggested).`);
}

/** Resolve headless mode from `SILBERCUE_CHROME_HEADLESS`. */
export function resolveHeadless(env: Env, explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  const raw = env.SILBERCUE_CHROME_HEADLESS;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}
