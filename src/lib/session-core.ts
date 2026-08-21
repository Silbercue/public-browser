/**
 * In-process Public Browser session — the shared core behind the library API.
 *
 * This is everything `startServer()` builds, minus the MCP stdio transport:
 * a lazy `BrowserSession` plus a fully-registered `ToolRegistry`. Callers
 * drive it through `callTool(name, params)`, which is the exact same dispatch
 * path MCP tool calls and the Python Script API take (Shared Core), so the
 * behaviour of a scripted session is identical to an agent-driven one.
 *
 * Isolation caveat — read before instantiating two of these in one thread:
 * several caches are module-level singletons by design (`a11yTree`,
 * `selectorCache`, the `emulation` viewport/headless flags, the cortex hint
 * matcher). Two cores in the SAME thread would share them and hand each other
 * the other's element refs. `createSession()` therefore defaults to running
 * each core in its own worker thread, where the module registry — and with
 * it every one of those singletons — is per-instance. Use `createSessionCore`
 * directly only when you run exactly one session per thread.
 */

import { mkdirSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserSession } from "../cdp/browser-session.js";
import { parseCdpUrl } from "../cdp/chrome-launcher.js";
import { resolveProfileSpec } from "../cdp/chrome-profiles.js";
import { resolveStealth } from "../cdp/stealth.js";
import { ToolRegistry } from "../registry.js";
import { VERSION } from "../version.js";
import {
  resolveCdpHost,
  resolveCdpPort,
  resolveDownloadDir,
  resolveDownloadHash,
  resolveDownloadNaming,
  resolveHeadless,
} from "../config.js";
import type { DownloadNaming } from "../config.js";
import type { ExecuteToolOptions, ToolResponse } from "../types.js";

export interface SessionCoreOptions {
  /**
   * CDP endpoint of the Chrome this session drives — `http://127.0.0.1:9333`,
   * `127.0.0.1:9333` or a bare port (`"9333"`). Takes precedence over
   * `cdpPort` / `cdpHost`.
   */
  cdpUrl?: string;
  /** CDP port (default: `SILBERCUE_CHROME_PORT`, else 9222). */
  cdpPort?: number;
  /** CDP host (default: `SILBERCUE_CHROME_HOST`, else 127.0.0.1). */
  cdpHost?: string;
  /**
   * Chrome `--user-data-dir` for auto-launch. Give every instance its own
   * directory — two Chromes cannot share one profile directory.
   */
  userDataDir?: string;
  /**
   * Named Chrome profile (as listed by `public-browser profiles`).
   * Mutually exclusive with `userDataDir`; the name wins if both are set.
   */
  profile?: string;
  /** Launch Chrome headless (default: `SILBERCUE_CHROME_HEADLESS`). */
  headless?: boolean;
  /**
   * `navigator.webdriver` masking. `false` keeps the native getter and the
   * `true` value — for integrations that must stay identifiable as bots.
   * Default: `SILBERCUE_STEALTH` / `PUBLIC_BROWSER_STEALTH`, else `true`.
   */
  stealth?: boolean;
  /**
   * Attach-only: never auto-launch, connect to an already-running Chrome on
   * the configured endpoint and fail fast if there is none.
   */
  attach?: boolean;
  /** Auto-launch Chrome when nothing answers on the endpoint (default: true unless `attach`). */
  autoLaunch?: boolean;
  /** Download target directory, e.g. a per-agent quarantine dir. Never deleted by us. */
  downloadDir?: string;
  /** Compute SHA-256 for every completed download (exposed as `DownloadInfo.sha256`). */
  downloadHash?: boolean;
  /**
   * File naming inside `downloadDir`: `"guid"` (default) keeps Chrome's
   * `allowAndName` output, `"suggested"` renames the finished file to the
   * sanitised server-supplied filename. Default:
   * `PUBLIC_BROWSER_DOWNLOAD_NAMING`, else `"guid"`.
   */
  downloadNaming?: DownloadNaming;
}

export interface SessionCore {
  readonly browserSession: BrowserSession;
  readonly registry: ToolRegistry;
  readonly cdpPort: number;
  readonly cdpHost: string;
  readonly stealth: boolean;
  readonly downloadDir: string | undefined;
  /** Execute a tool through the shared dispatch path. Lazily launches Chrome. */
  callTool(
    name: string,
    params?: Record<string, unknown>,
    options?: ExecuteToolOptions,
  ): Promise<ToolResponse>;
  /** Whether a tool with this name is registered. */
  hasTool(name: string): boolean;
  /** Connect to / launch Chrome now instead of on the first tool call. */
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Resolve endpoint, profile and download settings, then build the session.
 * No Chrome is launched here — that happens on `start()` or the first
 * `callTool()`, exactly as in the MCP server.
 */
export function createSessionCore(
  options: SessionCoreOptions = {},
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): SessionCore {
  // --- endpoint ---
  let cdpPort: number;
  let cdpHost: string;
  if (options.cdpUrl) {
    const endpoint = parseCdpUrl(options.cdpUrl);
    cdpPort = endpoint.port;
    cdpHost = endpoint.host;
  } else {
    cdpPort = resolveCdpPort(env, options.cdpPort);
    cdpHost = resolveCdpHost(env, options.cdpHost);
  }

  // --- profile / user-data-dir ---
  let profilePath: string | undefined;
  let profileDirectory: string | undefined;
  let isRealProfile = false;
  if (options.profile) {
    const resolved = resolveProfileSpec(options.profile);
    profilePath = resolved.userDataDir;
    profileDirectory = resolved.profileDirectory;
    isRealProfile = resolved.isRealProfile;
  } else if (options.userDataDir) {
    // Raw user-data-dir: Chrome owns the directory layout, we only point at it.
    // Create it up front — a per-agent directory that does not exist yet is the
    // normal case for a fresh instance, and the launcher refuses a missing path.
    mkdirSync(options.userDataDir, { recursive: true });
    profilePath = options.userDataDir;
  }

  const attach = options.attach ?? false;
  const browserSession = new BrowserSession({
    profilePath,
    profileDirectory,
    isRealProfile,
    headless: resolveHeadless(env, options.headless),
    autoLaunch: attach ? false : (options.autoLaunch ?? true),
    attachMode: attach,
    // Script mode stays off: a library session owns its tabs the same way the
    // MCP server does, and enabling ownership tracking would hide tabs the
    // host process opened itself.
    scriptMode: false,
    cdpPort,
    cdpHost,
    // Resolved here rather than inside BrowserSession so the caller-supplied
    // `env` governs the decision, exactly like every other setting above.
    stealth: resolveStealth(env, options.stealth),
    downloadDir: resolveDownloadDir(env, options.downloadDir),
    downloadHash: resolveDownloadHash(env, options.downloadHash),
    downloadNaming: resolveDownloadNaming(env, options.downloadNaming),
  });

  // The registry needs an McpServer to register tool schemas against, but the
  // server is never connected to a transport here — it exists purely as the
  // registration sink. Tool dispatch goes through `executeTool()`.
  const server = new McpServer({ name: "public-browser", version: VERSION });
  const registry = new ToolRegistry(server, browserSession);
  registry.registerAll();

  return {
    browserSession,
    registry,
    cdpPort,
    cdpHost,
    stealth: browserSession.stealth,
    get downloadDir() {
      return browserSession.downloadDir;
    },
    callTool(name, params = {}, execOptions) {
      return registry.executeTool(name, params, undefined, execOptions);
    },
    hasTool(name) {
      return registry.hasHandler(name);
    },
    async start() {
      await browserSession.ensureReady();
    },
    async close() {
      await browserSession.shutdown();
      try {
        await server.close();
      } catch {
        /* the server was never connected — closing is best-effort */
      }
    },
  };
}
