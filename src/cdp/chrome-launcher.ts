import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { CdpClient } from "./cdp-client.js";
import type { CdpTransport } from "../transport/transport.js";
import { PipeTransport } from "../transport/pipe-transport.js";
import { WebSocketTransport } from "../transport/websocket-transport.js";
import { debug } from "./debug.js";
import { findChromeUsingProfile, removeOrphanedWrappers } from "./profile-in-use.js";
import type { ConnectionStatus, TransportType } from "../types.js";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * How Public Browser reaches the Chrome it launches itself.
 *
 * `"port"` (default, historical) passes `--remote-debugging-port`. Convenient
 * — `--attach`, the Script API and reconnect-after-crash all need it — but the
 * endpoint is reachable by every other process on the machine. For a browser
 * holding real logins that is a way around any permission check the
 * integrator performs.
 *
 * `"pipe"` omits the flag: CDP travels over the child's stdio pipe, which
 * only the parent process holds. Nothing listens, so nothing else can attach.
 * The cost is everything that needed the port: no reconnect after a Chrome
 * crash, no second client, no `attach`. A real user profile always runs over
 * the pipe (S2, see `launchChrome`); `"pipe"` there only rules out the port
 * fallback.
 */
export type CdpTransportMode = "port" | "pipe";

export interface ChromeConnectionOptions {
  /** Port for WebSocket discovery (default: 9222) */
  port?: number;
  /**
   * Host for CDP discovery (default: "127.0.0.1"). Set this (or `cdpUrl`)
   * when attaching to a Chrome that is not on the loopback interface, e.g. a
   * container. Auto-launch always spawns on localhost regardless.
   */
  host?: string;
  /** Auto-launch Chrome if no running instance found (default: true) */
  autoLaunch?: boolean;
  /** Launch Chrome in headless mode (default: false — browser is visible by default) */
  headless?: boolean;
  /** Chrome user-data-dir (root). When set with profileDirectory, launches with a real profile. */
  profilePath?: string;
  /** Chrome --profile-directory value (e.g. "Profile 1"). Requires profilePath. */
  profileDirectory?: string;
  /** Whether this is a real user profile (preserves extensions, sync, etc.) */
  isRealProfile?: boolean;
  /**
   * Whether ChromeConnection should attempt a background reconnect loop
   * when the CDP transport closes or the Chrome child process exits.
   *
   * - `true` (default) — legacy behaviour: 5 retry attempts with exponential
   *   backoff, fired automatically from the onClose handler.
   * - `false` — no background retries. Disconnect only flips `status` to
   *   `"disconnected"` and the next caller (typically `BrowserSession.
   *   ensureReady()`) is responsible for recovery. This is the mode used
   *   by the lazy-launch architecture to avoid racing with its own
   *   smart-retry policy.
   */
  autoReconnect?: boolean;
  /**
   * Stealth mode (default: true). When false, the launcher omits
   * `--disable-blink-features=AutomationControlled` so `navigator.webdriver`
   * keeps its native getter and stays `true`. See `cdp/stealth.ts`.
   */
  stealth?: boolean;
  /** CDP transport for a self-launched Chrome. See `CdpTransportMode`. */
  transport?: CdpTransportMode;
}

export interface LaunchOptions {
  headless?: boolean;
  /** Wenn gesetzt: Chrome nutzt dieses Verzeichnis als user-data-dir statt eines Temp-Verzeichnisses */
  profilePath?: string;
  /** Chrome --profile-directory value (e.g. "Profile 1"). Requires profilePath. */
  profileDirectory?: string;
  /** Real user profile: don't disable extensions/sync. */
  isRealProfile?: boolean;
  /** CDP debugging port for --remote-debugging-port flag (default: 9222) */
  port?: number;
  /**
   * Stealth mode (default: true). When false, the
   * `--disable-blink-features=AutomationControlled` flag is omitted.
   */
  stealth?: boolean;
  /**
   * `"port"` (default) opens a CDP endpoint on `--remote-debugging-port`.
   * `"pipe"` omits that flag entirely and speaks CDP only over the stdio
   * pipe — see `CdpTransportMode`.
   */
  transport?: CdpTransportMode;
  /**
   * Startup budget in ms: for the answer over the pipe and, in the real-profile
   * fallback, for DevToolsActivePort. Default 5000 for temp/raw profiles,
   * `REAL_PROFILE_STARTUP_TIMEOUT_MS` for a real profile. Exposed for tests.
   */
  startupTimeoutMs?: number;
}

interface LaunchResult {
  cdpClient: CdpClient;
  transport: CdpTransport;
  process: ChildProcess;
  transportType: TransportType;
  /** Wrapper user-data-dir of a real profile; the owner removes it after Chrome exits. */
  wrapperDir?: string;
  /** Port Chrome actually listens on for CDP; `null`: pipe only, nothing listens. */
  debugPort: number | null;
  /** One-time warning for the model (real-profile port fallback). Already printed to stderr. */
  warning?: string;
}

// ── AutoLaunch Resolution (Story 10.2) ────────────────────────────────

/**
 * Resolve the autoLaunch setting from environment variables.
 * Pure function — no side effects, fully testable.
 *
 * - SILBERCUE_CHROME_AUTO_LAUNCH=true  → always auto-launch
 * - SILBERCUE_CHROME_AUTO_LAUNCH=false → never auto-launch
 * - unset → default: auto-launch (zero-config UX for new users)
 *
 * The `_headless` parameter is kept for backwards-compat with call-sites,
 * but no longer influences the default — auto-launch is the standard path.
 */
export function resolveAutoLaunch(
  env: Record<string, string | undefined>,
  _headless: boolean,
): boolean {
  const val = env.SILBERCUE_CHROME_AUTO_LAUNCH;
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  if (val === undefined) {
    // Default: always auto-launch — user gets zero-config UX
    return true;
  }
  // Invalid env value (e.g. "foo", "bar") → safe default: no auto-launch
  return false;
}

// ── CDP URL parsing ───────────────────────────────────────────────────

export interface CdpEndpoint {
  host: string;
  port: number;
}

export const DEFAULT_CDP_HOST = "127.0.0.1";
export const DEFAULT_CDP_PORT = 9222;

/**
 * Parse a CDP endpoint string into host + port.
 * Pure function — no side effects, fully testable.
 *
 * Accepts `http://host:port`, `ws://host:port`, `host:port` and a bare port
 * (`"9333"`). Throws on anything that yields no usable port, so a typo in a
 * `createSession({ cdpUrl })` call fails loudly instead of silently
 * attaching to the default browser on 9222.
 */
export function parseCdpUrl(input: string): CdpEndpoint {
  const raw = input.trim();
  if (raw === "") throw new Error("cdpUrl is empty");

  // Bare port: "9333"
  if (/^\d+$/.test(raw)) {
    const port = Number(raw);
    if (port < 1 || port > 65535) throw new Error(`Invalid CDP port: ${raw}`);
    return { host: DEFAULT_CDP_HOST, port };
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid cdpUrl: ${input}`);
  }

  const port = url.port ? Number(url.port) : DEFAULT_CDP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CDP port in cdpUrl: ${input}`);
  }
  // `URL` wraps IPv6 literals in brackets; node:http wants them bare.
  const host = url.hostname.replace(/^\[|\]$/g, "") || DEFAULT_CDP_HOST;
  return { host, port };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Chrome reports `webSocketDebuggerUrl` with the host it was told to bind to
 * — usually `localhost`. When we discovered it through a different host
 * (container IP, LAN address), rewrite the URL so the WebSocket actually
 * reaches the same Chrome instead of our own loopback.
 */
function rewriteWsHost(wsUrl: string, host: string): string {
  if (isLoopback(host)) return wsUrl;
  try {
    const parsed = new URL(wsUrl);
    if (!isLoopback(parsed.hostname)) return wsUrl;
    parsed.hostname = host.includes(":") ? `[${host}]` : host;
    return parsed.toString();
  } catch {
    return wsUrl;
  }
}

// ── Chrome Path Detection (Task 1) ────────────────────────────────────

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
  ],
  win32: [
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

export function findChromePath(): string | null {
  // CHROME_PATH env override
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    return null;
  }

  const platform = process.platform;
  const candidates = CHROME_PATHS[platform];
  if (!candidates) return null;

  if (platform === "linux") {
    // Linux: executable names — resolve via `which`
    for (const name of candidates) {
      try {
        const resolved = execFileSync("which", [name], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (resolved) return resolved;
      } catch {
        // not found, try next
      }
    }
    return null;
  }

  // macOS / Windows: absolute paths — check existence
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Chrome Spawn (Task 2) ────────────────────────────────────────────

const CHROME_FLAGS_CORE = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--enable-features=CDPScreenshotNewSurface",
  "--mute-audio",
];

/**
 * Stealth-only flag. Hides the `AutomationControlled` blink feature, which is
 * what makes `navigator.webdriver` report `true` in a CDP-driven Chrome.
 * Omitted when stealth is disabled so the browser stays honestly identifiable.
 */
const CHROME_FLAG_STEALTH = "--disable-blink-features=AutomationControlled";

const CHROME_FLAGS_ISOLATED = [
  "--disable-extensions",
  "--disable-sync",
];

/** Temp or raw profile: how long Chrome gets to answer over the pipe. */
const PIPE_STARTUP_TIMEOUT_MS = 5_000;
/**
 * Real profile: startup budget for the answer over the pipe and, in the
 * fallback, for DevToolsActivePort. Opening a big profile can take long; a
 * refusal is recognised on stderr, so a slow start never opens a port.
 */
export const REAL_PROFILE_STARTUP_TIMEOUT_MS = 15_000;
const PIPE_STDIO: ("ignore" | "pipe")[] = ["ignore", "ignore", "pipe", "pipe", "pipe"];
const PORT_STDIO: ("ignore" | "pipe")[] = ["ignore", "ignore", "pipe"];

/**
 * What Chrome prints to stderr when it refuses remote debugging — pipe and
 * port alike — on its default user-data-dir, then keeps running without CDP
 * (chrome/browser/browser_process_impl.cc, CreateDevToolsProtocolHandler).
 */
const PIPE_REFUSAL_PATTERN = /DevTools remote debugging requires a non-default data directory/;

/** Chrome refused remote debugging — the only failure the port fallback handles. */
class PipeRefusedError extends Error {}

/**
 * CDP over the child's fds 3/4. Fails fast when Chrome exits or prints its
 * refusal on stderr, and after `timeoutMs` when it keeps running silently.
 */
async function connectOverPipe(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ cdpClient: CdpClient; transport: CdpTransport }> {
  const transport = new PipeTransport(child.stdio[4] as Readable, child.stdio[3] as Writable);
  const cdpClient = new CdpClient(transport);
  const stderr = (child.stdio[2] ?? null) as Readable | null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExit: (() => void) | undefined;
  let onStderr: ((chunk: Buffer | string) => void) | undefined;
  try {
    await Promise.race([
      cdpClient.send("Browser.getVersion"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Chrome startup timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
      new Promise<never>((_, reject) => {
        onExit = () => reject(new Error("Chrome exited before CDP was ready"));
        child.once("exit", onExit);
      }),
      new Promise<never>((_, reject) => {
        if (!stderr) return;
        let seen = "";
        onStderr = (chunk) => {
          // Keep a tail so a line split across chunks still matches.
          seen = (seen + chunk.toString()).slice(-4096);
          if (PIPE_REFUSAL_PATTERN.test(seen)) {
            reject(new PipeRefusedError("Chrome requires a non-default data directory for remote debugging"));
          }
        };
        stderr.on("data", onStderr);
      }),
    ]);
  } catch (err) {
    await cdpClient.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    if (onExit) child.off("exit", onExit);
    if (onStderr && stderr) stderr.off("data", onStderr);
  }
  return { cdpClient, transport };
}

/**
 * S2 fallback: Chrome started with `--remote-debugging-port=0` picks a free
 * port and writes `<port>\n/devtools/browser/<id>` to DevToolsActivePort in
 * its user-data-dir (content/browser/devtools/devtools_http_handler.cc).
 * Reading it from OUR wrapper dir is what guarantees we reach our own Chrome —
 * a well-known port may belong to somebody else's browser.
 */
async function waitForDevToolsActivePort(
  userDataDir: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ port: number; browserPath: string }> {
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Chrome exited before reporting its debugging port");
    }
    try {
      const [portLine, pathLine] = readFileSync(file, "utf-8").split("\n");
      const port = Number(portLine);
      const browserPath = (pathLine ?? "").trim();
      if (Number.isInteger(port) && port > 0 && port < 65536 && browserPath.startsWith("/devtools/browser/")) {
        return { port, browserPath };
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Chrome did not report its debugging port within ${timeoutMs} ms (no usable DevToolsActivePort in `
    + `${userDataDir}). Refusing to guess a port — 9222 may belong to another browser.`,
  );
}

export async function launchChrome(
  options?: LaunchOptions,
): Promise<LaunchResult> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error(
      "Chrome not found. Install Chrome or set CHROME_PATH environment variable.",
    );
  }

  let userDataDir: string;
  let tmpDir: string | undefined;
  const isRealProfile = options?.isRealProfile ?? false;
  const transport: CdpTransportMode = options?.transport ?? "port";

  if (isRealProfile && options?.profilePath && options?.profileDirectory) {
    // Real profile: Chrome ignores both remote-debugging switches on its
    // default user-data-dir (Chrome 136+). Workaround: a wrapper dir that
    // symlinks the profile folder — Chrome sees a "non-default" dir but uses
    // the real data. Chrome compares only the user-data-dir itself with its
    // default (IsRemoteDebuggingAllowed), so this works for the pipe exactly
    // as for the port.
    if (!existsSync(options.profilePath)) {
      throw new Error(
        `Chrome profile path does not exist: ${options.profilePath}`,
      );
    }
    const profileSubdir = join(options.profilePath, options.profileDirectory);
    if (!existsSync(profileSubdir)) {
      throw new Error(
        `Chrome profile directory does not exist: ${profileSubdir}`,
      );
    }
    // S2: over the pipe a second Public Browser can no longer find this Chrome
    // and share it — it would open the same profile directory a second time,
    // and Chrome's own lock lives in the (different) wrapper dirs.
    const holderPid = findChromeUsingProfile(profileSubdir, options.profileDirectory);
    if (holderPid !== null) {
      throw new Error(
        `Chrome profile "${options.profileDirectory}" is already open in a Chrome started by `
        + `Public Browser (PID ${holderPid}). Two Chrome processes on one profile directory can `
        + "corrupt it — close the other Public Browser session first.",
      );
    }
    // Wrappers of a Chrome killed by SIGKILL were never removed, and each one
    // still links to a real profile.
    const orphans = removeOrphanedWrappers();
    if (orphans.length > 0) {
      debug("Removed orphaned profile wrappers: %s", orphans.join(", "));
    }
    tmpDir = join(
      tmpdir(),
      `public-browser-profile-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tmpDir, { recursive: true });

    // Copy Local State (profile metadata) and create First Run marker
    const localStatePath = join(options.profilePath, "Local State");
    if (existsSync(localStatePath)) {
      copyFileSync(localStatePath, join(tmpDir, "Local State"));
    }
    writeFileSync(join(tmpDir, "First Run"), "");

    // Symlink the actual profile directory into the wrapper
    symlinkSync(profileSubdir, join(tmpDir, options.profileDirectory));

    userDataDir = tmpDir;
  } else if (options?.profilePath) {
    // Raw path mode (backward compat)
    if (!existsSync(options.profilePath)) {
      throw new Error(
        `Chrome profile path does not exist: ${options.profilePath}`,
      );
    }
    userDataDir = options.profilePath;
  } else {
    // Default: isolated temp profile
    tmpDir = join(
      tmpdir(),
      `public-browser-${randomBytes(4).toString("hex")}`,
    );
    await mkdir(tmpDir, { recursive: true });
    userDataDir = tmpDir;
  }

  const port = options?.port ?? 9222;
  const stealth = options?.stealth ?? true;
  const coreFlags = stealth
    ? [...CHROME_FLAGS_CORE, CHROME_FLAG_STEALTH]
    : [...CHROME_FLAGS_CORE];
  const baseFlags = isRealProfile
    ? coreFlags
    : [...coreFlags, ...CHROME_FLAGS_ISOLATED];

  const flagsFor = (pipe: boolean, portFlag: number | null): string[] => {
    const flags = [
      ...(pipe ? ["--remote-debugging-pipe"] : []),
      ...baseFlags,
      ...(portFlag !== null ? [`--remote-debugging-port=${portFlag}`] : []),
      `--user-data-dir=${userDataDir}`,
    ];
    if (options?.profileDirectory) {
      flags.push(`--profile-directory=${options.profileDirectory}`);
    }
    if (options?.headless !== false) {
      flags.unshift("--headless=new");
    }
    return flags;
  };

  const spawnChrome = (flags: string[], stdio: ("ignore" | "pipe")[]): ChildProcess => {
    debug("Spawning Chrome: %s %s", chromePath, flags.join(" "));
    return spawn(chromePath, flags, { stdio });
  };

  try {
    if (!isRealProfile) {
      // Temp/raw profile: CDP always over the pipe; the port is only the
      // additional door for reconnect, --attach and the Script API.
      const portFlag = transport === "pipe" ? null : port;
      const child = spawnChrome(flagsFor(true, portFlag), PIPE_STDIO);
      try {
        const { cdpClient, transport: pipe } = await connectOverPipe(
          child,
          options?.startupTimeoutMs ?? PIPE_STARTUP_TIMEOUT_MS,
        );
        return { cdpClient, transport: pipe, process: child, transportType: "pipe", debugPort: portFlag };
      } catch (err) {
        child.kill();
        throw err;
      }
    }

    const startupTimeoutMs = options?.startupTimeoutMs ?? REAL_PROFILE_STARTUP_TIMEOUT_MS;

    // S2: real profile — pipe only, nothing listens for other local programs.
    const pipeChild = spawnChrome(flagsFor(true, null), PIPE_STDIO);
    try {
      const { cdpClient, transport: pipe } = await connectOverPipe(pipeChild, startupTimeoutMs);
      return {
        cdpClient,
        transport: pipe,
        process: pipeChild,
        transportType: "pipe",
        wrapperDir: tmpDir,
        debugPort: null,
      };
    } catch (err) {
      // This Chrome has to go either way — and before a fallback opens the
      // same profile a second time.
      await terminateAndWait(pipeChild, KILL_GRACE_MS);
      // A slow or crashed start is no refusal: a port would not help there.
      if (!(err instanceof PipeRefusedError)) throw err;
      if (transport === "pipe" || !tmpDir) {
        throw new Error(
          `Chrome refused --remote-debugging-pipe for profile "${options?.profileDirectory}" (${err.message}); `
          + (transport === "pipe"
            ? 'transport "pipe" rules out the port fallback.'
            : "without a wrapper dir there is no port fallback."),
        );
      }
    }

    // Fallback: a random port, read back from OUR wrapper dir. Never a
    // well-known port — 9222 may belong to another browser, and probing it
    // would silently attach us there.
    const wrapper = tmpDir ?? userDataDir; // tmpDir is set here (checked above)
    rmSync(join(wrapper, "DevToolsActivePort"), { force: true });
    const portChild = spawnChrome(flagsFor(false, 0), PORT_STDIO);
    try {
      const active = await waitForDevToolsActivePort(wrapper, portChild, startupTimeoutMs);
      const wsTransport = await WebSocketTransport.connect(
        `ws://127.0.0.1:${active.port}${active.browserPath}`,
        { timeoutMs: 5000 },
      );
      const cdpClient = new CdpClient(wsTransport);
      await cdpClient.send("Browser.getVersion");
      const warning =
        `Public Browser: Chrome refused --remote-debugging-pipe for profile "${options?.profileDirectory}" `
        + "and was restarted with a random debugging port. While this Chrome runs, any local program "
        + `can control the logged-in profile via 127.0.0.1:${active.port}.`;
      console.error(warning);
      return {
        cdpClient,
        transport: wsTransport,
        process: portChild,
        transportType: "websocket" as TransportType,
        wrapperDir: tmpDir,
        debugPort: active.port,
        warning,
      };
    } catch (err) {
      await terminateAndWait(portChild, KILL_GRACE_MS);
      throw err;
    }
  } catch (err) {
    // Cleanup on failure — only delete temp/wrapper directories, NEVER profile directories
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }
}

// ── WebSocket Discovery (Task 3) ──────────────────────────────────────

interface VersionResponse {
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

async function fetchJsonVersion(
  port: number,
  timeoutMs = 500,
  host: string = DEFAULT_CDP_HOST,
): Promise<VersionResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`/json/version request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = httpRequest(
      {
        hostname: host,
        port,
        path: "/json/version",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        if (settled) return;

        if (res.statusCode !== 200) {
          clearTimeout(timer);
          settled = true;
          reject(
            new Error(
              `/json/version returned HTTP ${res.statusCode}`,
            ),
          );
          res.resume();
          return;
        }

        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          try {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed !== "object" || parsed === null) {
              reject(new Error("/json/version returned invalid JSON"));
              return;
            }
            resolve(parsed as VersionResponse);
          } catch {
            reject(new Error("/json/version returned invalid JSON"));
          }
        });
      },
    );

    req.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(err);
    });

    req.end();
  });
}

// ── ChromeConnection (Task 4 + Task 6) ────────────────────────────────

/** SIGTERM → SIGKILL grace period for a Chrome we launched ourselves. */
export const KILL_GRACE_MS = 5000;
/** Extra budget after SIGKILL before `close()` stops waiting for the reap. */
export const KILL_HARD_TIMEOUT_MS = 2000;

/**
 * SIGTERM, escalate to SIGKILL after `graceMs`, resolve once the process is
 * reaped — or after `graceMs + KILL_HARD_TIMEOUT_MS`, because a process stuck
 * in uninterruptible sleep cannot be reaped at all. The timers exist before
 * the kill, so an exit that fires synchronously still clears them.
 */
function terminateAndWait(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(hardTimer);
      child.off("exit", finish);
      resolve();
    };
    const forceTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, graceMs);
    forceTimer.unref();
    const hardTimer = setTimeout(() => {
      debug("ChromeConnection: child did not exit, giving up on the wait");
      finish();
    }, graceMs + KILL_HARD_TIMEOUT_MS);
    hardTimer.unref();

    child.once("exit", finish);
    if (globalThis.process.platform === "win32") {
      // H3 fix: On Windows, kill() sends taskkill — no SIGTERM/SIGKILL distinction
      child.kill();
    } else {
      child.kill("SIGTERM");
    }
  });
}

export class ChromeConnection {
  public status: ConnectionStatus = "connected";
  /**
   * How long Chrome gets between SIGTERM and SIGKILL. Writable so tests can
   * shorten it; nothing in production changes it.
   */
  public killGraceMs = KILL_GRACE_MS;
  /**
   * Port this Chrome listens on for CDP, `null` when it runs over the pipe
   * only (S2). ChromeLauncher sets it after a launch; otherwise it is the port
   * the connection was made on.
   */
  public debugPort: number | null;
  /** One-time warning for the model from the launch (S2 port fallback). */
  public launchWarning: string | undefined;

  private _exitHandler: (() => void) | null = null;
  private _closed = false;

  // Reconnect fields (Story 5.2)
  private _cdpClient: CdpClient;
  private _transport: CdpTransport;
  private _childProcess: ChildProcess | undefined;
  private _tmpDir: string | undefined;
  private _reconnecting = false;
  private _onReconnect: ((connection: ChromeConnection) => Promise<void>) | null = null;
  private readonly _headless: boolean;
  private readonly _port: number;
  private readonly _profilePath: string | undefined;
  private readonly _autoReconnect: boolean;
  private readonly _stealth: boolean;
  private readonly _host: string;

  constructor(
    cdpClient: CdpClient,
    transport: CdpTransport,
    public readonly transportType: TransportType,
    childProcess: ChildProcess | undefined,
    tmpDir: string | undefined,
    _launcher?: ChromeLauncher,
    port?: number,
    headless?: boolean,
    profilePath?: string,
    autoReconnect?: boolean,
    stealth?: boolean,
    host?: string,
  ) {
    this._cdpClient = cdpClient;
    this._transport = transport;
    this._childProcess = childProcess;
    this._tmpDir = tmpDir;
    this._port = port ?? 9222;
    this._headless = headless ?? false;
    this._profilePath = profilePath;
    // Default to true for legacy callers (chrome-launcher.test.ts still
    // exercises the background-retry path). BrowserSession passes `false`.
    this._autoReconnect = autoReconnect ?? true;
    this._stealth = stealth ?? true;
    this._host = host ?? DEFAULT_CDP_HOST;
    this.debugPort = this._port;

    // C1 fix: Passive status tracking via CdpClient.onClose —
    // detects unexpected transport close (WebSocket drop, pipe break)
    this._setupOnClose(cdpClient);

    if (this._childProcess) {
      this._setupChildProcessHandlers(this._childProcess);
    }
  }

  get cdpClient(): CdpClient {
    return this._cdpClient;
  }

  get transport(): CdpTransport {
    return this._transport;
  }

  get childProcess(): ChildProcess | undefined {
    return this._childProcess;
  }

  get headless(): boolean {
    return this._headless;
  }

  /** Register a callback to be invoked after successful reconnect for re-wiring */
  onReconnect(callback: (connection: ChromeConnection) => Promise<void>): void {
    this._onReconnect = callback;
  }

  /**
   * Attempt to reconnect to Chrome with exponential backoff.
   * BUG-004 fix: No race window (_reconnecting stays true during entire loop),
   * failed transports are cleaned up, and onReconnect errors don't short-circuit.
   * Returns true if reconnect succeeded, false otherwise.
   */
  async reconnect(): Promise<boolean> {
    if (this._reconnecting || this._closed) return false;
    this._reconnecting = true;
    this.status = "reconnecting";

    // Best-effort close old client/transport
    try {
      await this._cdpClient.close();
    } catch {
      /* best-effort */
    }

    const maxAttempts = 5;
    const baseDelay = 500; // Exponential backoff: 500, 1000, 2000, 4000ms

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // B2: Check _closed inside the loop so close() during reconnect aborts immediately
      if (this._closed) {
        this._reconnecting = false;
        return false;
      }

      if (attempt > 1) {
        const delay = baseDelay * Math.pow(2, attempt - 2);
        await new Promise((r) => setTimeout(r, delay));
        // B2: Re-check after the pause — close() may have been called while waiting
        if (this._closed) {
          this._reconnecting = false;
          return false;
        }
        // BUG-004: Clean up transport from previous failed attempt to prevent leaks
        try {
          await this._cdpClient.close();
        } catch {
          /* best-effort */
        }
      }

      try {
        if (this.transportType === "websocket") {
          // WebSocket reconnect: Chrome is still running, reconnect to same port
          // B1: fetchJsonVersion uses 500ms default, WebSocket connect 2s
          const versionInfo = await fetchJsonVersion(this._port, 500, this._host);
          if (!versionInfo.webSocketDebuggerUrl) {
            throw new Error("Missing webSocketDebuggerUrl");
          }
          const wsUrl = rewriteWsHost(versionInfo.webSocketDebuggerUrl as string, this._host);
          const newTransport = await WebSocketTransport.connect(wsUrl, { timeoutMs: 2000 });
          const newClient = new CdpClient(newTransport);
          await newClient.send("Browser.getVersion");

          this._transport = newTransport;
          this._cdpClient = newClient;
        } else {
          // Pipe reconnect: Chrome process is dead, relaunch
          const result = await launchChrome({ headless: this._headless, profilePath: this._profilePath, port: this._port, stealth: this._stealth });
          this._transport = result.transport;
          this._cdpClient = result.cdpClient;

          // Clean up old child process handlers
          if (this._exitHandler) {
            globalThis.process.removeListener("exit", this._exitHandler);
            this._exitHandler = null;
          }

          this._childProcess = result.process;

          if (this._profilePath) {
            // Profile path: no tmpDir — profile directory must NEVER be deleted
            this._tmpDir = undefined;
          } else {
            const tmpDirFlag = result.process.spawnargs.find((a) =>
              a.startsWith("--user-data-dir="),
            );
            this._tmpDir = tmpDirFlag?.split("=")[1];
          }

          // Setup handlers for new child process
          this._setupChildProcessHandlers(this._childProcess);
        }

        // Setup onClose for the new CdpClient to detect future disconnects
        this._setupOnClose(this._cdpClient);

        // Invoke onReconnect callback BEFORE setting status to connected.
        // BUG-004 fix: If callback fails, DON'T throw — let the loop continue
        // to the next attempt. _reconnecting stays true (no race window).
        if (this._onReconnect) {
          await this._onReconnect(this);
        }

        this.status = "connected";
        this._reconnecting = false;

        debug("Reconnect succeeded on attempt %d", attempt);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug("Reconnect attempt %d/%d failed: %s", attempt, maxAttempts, msg);
      }
    }

    this.status = "disconnected";
    this._reconnecting = false;
    debug("All %d reconnect attempts failed", maxAttempts);
    return false;
  }

  /**
   * Tear the connection down and, when we launched Chrome ourselves, wait for
   * that process to actually be gone before resolving.
   *
   * Waiting matters for anyone who reuses the port or the user-data-dir right
   * after closing: a resolved `close()` that only *asked* Chrome to exit means
   * the next launch races a still-running instance holding the profile lock.
   * The wait is bounded — SIGKILL after `killGraceMs`, give up after
   * `KILL_HARD_TIMEOUT_MS` — so shutdown can be slow but never hangs.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.status = "disconnected";

    // Remove process listeners to prevent accumulation
    if (this._exitHandler)
      globalThis.process.removeListener("exit", this._exitHandler);

    // Close CDP client (which closes the transport)
    await this._cdpClient.close();

    // Terminate child process if we launched it — and wait for it to die.
    await this._terminateChildProcess();

    // Clean up tmp user-data-dir. Only correct after the wait above: Chrome
    // rewrites the profile on exit and would recreate what we just removed.
    if (this._tmpDir) {
      await rm(this._tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * SIGTERM, escalate to SIGKILL, resolve once the process is reaped.
   * Resolves immediately when we never launched Chrome (attach mode) or when
   * it is already gone.
   */
  private _terminateChildProcess(): Promise<void> {
    const child = this._childProcess;
    if (!child) return Promise.resolve();
    return terminateAndWait(child, this.killGraceMs);
  }

  /** Register onClose callback on a CdpClient to trigger reconnect on unexpected disconnect.
   *  BUG-004 fix: fired-flag prevents handler accumulation across reconnect attempts.
   *  Lazy-launch refactor: background reconnect is skipped when autoReconnect is false. */
  private _setupOnClose(client: CdpClient): void {
    let fired = false;
    client.onClose(() => {
      if (fired || this._closed) return;
      fired = true;
      this.status = "disconnected";
      if (!this._autoReconnect) return;
      // Fire-and-forget reconnect
      this.reconnect().catch((err) => {
        debug("Reconnect error: %s", err instanceof Error ? err.message : String(err));
      });
    });
  }

  /** Setup child process exit handler and global exit cleanup */
  private _setupChildProcessHandlers(child: ChildProcess): void {
    // Track status on child process exit + (optionally) trigger reconnect.
    child.on("exit", () => {
      if (this._closed) return; // deliberate shutdown
      this.status = "disconnected";
      if (!this._autoReconnect) return;
      debug("Chrome process exited, attempting relaunch...");
      this.reconnect().catch((err) => {
        debug("Reconnect after crash error: %s", err instanceof Error ? err.message : String(err));
      });
    });

    // H4 fix: Only register 'exit' handler for sync cleanup
    this._exitHandler = () => {
      if (this._closed) return;
      this._childProcess?.kill();
    };
    globalThis.process.on("exit", this._exitHandler);
  }
}

// ── ChromeLauncher (Task 4) ───────────────────────────────────────────

export class ChromeLauncher {
  private readonly _port: number;
  private readonly _autoLaunch: boolean;
  private readonly _headless: boolean;
  private readonly _profilePath: string | undefined;
  private readonly _profileDirectory: string | undefined;
  private readonly _isRealProfile: boolean;
  private readonly _transport: CdpTransportMode;
  private readonly _autoReconnect: boolean;
  private readonly _stealth: boolean;
  private readonly _host: string;
  /**
   * Debugging port of the Chrome this launcher started last: `null` = pipe
   * only, `undefined` = none started yet (then the configured port applies).
   */
  private _launchedDebugPort: number | null | undefined;

  constructor(options?: ChromeConnectionOptions) {
    this._port = options?.port ?? 9222;
    this._host = options?.host ?? DEFAULT_CDP_HOST;
    this._autoLaunch = options?.autoLaunch ?? true;
    this._headless = options?.headless ?? false;
    this._profilePath = options?.profilePath;
    this._profileDirectory = options?.profileDirectory;
    this._isRealProfile = options?.isRealProfile ?? false;
    this._transport = options?.transport ?? "port";
    this._autoReconnect = options?.autoReconnect ?? true;
    this._stealth = options?.stealth ?? true;
  }

  /**
   * WebSocket-only connect — probiert ausschliesslich den existierenden
   * Chrome auf Port 9222 zu erreichen. Faellt NICHT auf Auto-Launch zurueck.
   *
   * Wird vom BrowserSession-Retry-Loop genutzt, wenn wir nach einem
   * Verbindungsverlust versuchen, dieselbe Chrome-Instanz wieder zu erwischen
   * (statt eine frische zu launchen und damit die User-Session zu verlieren).
   */
  async connectToExistingChrome(): Promise<ChromeConnection> {
    // S2: a Chrome we launched over the pipe has no port. Probing one anyway
    // could only find somebody else's browser — and silently continue there.
    if (this._launchedDebugPort === null) {
      throw new Error(
        "The Chrome this session launched has no debugging port (pipe only) — there is nothing to reconnect to.",
      );
    }
    // After the real-profile fallback Chrome listens on a random port, not ours.
    const port = this._launchedDebugPort ?? this._port;
    debug("Trying WebSocket-only on %s:%d...", this._host, port);
    return this._connectViaWebSocket(port);
  }

  async connect(): Promise<ChromeConnection> {
    // No endpoint to discover: transport "pipe" by design, and an auto-launched
    // real profile since S2. Skip straight to launching our own Chrome; probing
    // a port here would either waste a timeout or, worse, attach us to
    // somebody else's browser.
    let wsError: Error | undefined;
    const skipProbe = this._transport === "pipe" || (this._isRealProfile && this._autoLaunch);
    if (skipProbe) {
      if (!this._autoLaunch) {
        throw new Error(
          'transport: "pipe" cannot attach to an existing Chrome — the pipe belongs to '
          + "the process that spawned it. Launch Chrome through Public Browser, or use "
          + 'transport: "port".',
        );
      }
    } else {
      // 1. Try WebSocket to existing Chrome
      debug("Trying WebSocket on %s:%d...", this._host, this._port);
      try {
        return await this._connectViaWebSocket(this._port);
      } catch (err) {
        wsError = err instanceof Error ? err : new Error(String(err));
        debug("WebSocket failed: %s", wsError.message);
      }

      // 2. Auto-launch if enabled
      // C2 fix: preserve original error for better diagnostics
      if (!this._autoLaunch) {
        throw wsError!;
      }
    }

    debug("Launching Chrome (transport: %s)...", this._transport);
    const result = await launchChrome({
      headless: this._headless,
      profilePath: this._profilePath,
      profileDirectory: this._profileDirectory,
      isRealProfile: this._isRealProfile,
      port: this._port,
      stealth: this._stealth,
      transport: this._transport,
    });

    this._launchedDebugPort = result.debugPort;

    // Temp profiles: the dir from the spawn args. Real profiles: the wrapper
    // dir, which only holds a symlink to the profile — removing it after
    // Chrome exits leaves the profile untouched (fs.rm does not follow it).
    let tmpDir: string | undefined = result.wrapperDir;
    if (!tmpDir && !this._profilePath) {
      const tmpDirFlag = result.process.spawnargs.find((a) =>
        a.startsWith("--user-data-dir="),
      );
      tmpDir = tmpDirFlag?.split("=")[1];
    }

    const connection = new ChromeConnection(
      result.cdpClient,
      result.transport,
      result.transportType,
      result.process,
      tmpDir,
      this,
      // The port Chrome really listens on (random after the real-profile
      // fallback) — the configured one could belong to another browser.
      result.debugPort ?? this._port,
      this._headless,
      this._profilePath,
      // Without a port there is nothing to reconnect to: the reconnect path
      // rediscovers Chrome over the port. A lost pipe means a lost session —
      // surfacing that beats retrying against nothing.
      result.debugPort !== null ? this._autoReconnect : false,
      this._stealth,
      this._host,
    );
    connection.debugPort = result.debugPort;
    connection.launchWarning = result.warning;

    debug("Connected via %s", result.transportType);
    return connection;
  }

  private async _connectViaWebSocket(
    port: number,
  ): Promise<ChromeConnection> {
    const versionInfo = await fetchJsonVersion(port, 500, this._host);

    if (!versionInfo.webSocketDebuggerUrl) {
      throw new Error(
        "/json/version response missing webSocketDebuggerUrl field",
      );
    }

    const wsUrl = rewriteWsHost(versionInfo.webSocketDebuggerUrl as string, this._host);
    const transport = await WebSocketTransport.connect(wsUrl, {
      timeoutMs: 5000,
    });
    const cdpClient = new CdpClient(transport);

    // Verify connection
    await cdpClient.send("Browser.getVersion");

    // Auto-detect headless from /json/version Browser field.
    // Headed Chrome reports "Chrome/...", headless reports "HeadlessChrome/...".
    const browserString = typeof versionInfo.Browser === "string" ? versionInfo.Browser : "";
    const detectedHeadless = browserString.includes("HeadlessChrome");
    if (detectedHeadless !== this._headless) {
      debug("Headless auto-detected=%s (Browser: %s), overriding env setting=%s", detectedHeadless, browserString, this._headless);
    }

    if (this._profilePath) {
      debug("Connected via WebSocket to existing Chrome — profilePath ignored (only affects Auto-Launch)");
    } else {
      debug("Connected via WebSocket");
    }
    return new ChromeConnection(
      cdpClient,
      transport,
      "websocket",
      undefined,
      undefined,
      this,
      port,
      detectedHeadless,
      undefined, // profilePath ignored for WebSocket path
      this._autoReconnect,
      this._stealth,
      this._host,
    );
  }
}
