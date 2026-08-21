/**
 * Public Browser as a Node library — `createSession()`.
 *
 * Motivation: an integrator that runs several browsers per agent (say a
 * read-only research Chrome and a separate action Chrome) previously had to
 * spawn one `npx public-browser` process per instance and pay 4–6 s of
 * start-up each time, then talk to it over stdio or HTTP. `createSession()`
 * removes both costs: the session lives inside the host process and is ready
 * in roughly the time it takes to spin up a worker thread.
 *
 * ```ts
 * import { createSession } from "public-browser";
 *
 * const research = await createSession({
 *   cdpUrl: "http://127.0.0.1:9333",
 *   userDataDir: "/var/agents/a1/research",
 *   stealth: false,                        // stay identifiable as a bot
 *   downloadDir: "/var/agents/a1/quarantine",
 *   downloadHash: true,                    // DownloadInfo.sha256
 *   downloadNaming: "suggested",           // real filenames, not GUIDs
 *   transport: "pipe",                     // no CDP port for anyone else
 *   cortexDir: "/var/agents/a1/cortex",    // per-instance pattern store
 *   inheritEnv: ["HTTPS_PROXY"],           // opt in to what the session needs
 * });
 *
 * await research.callTool("navigate", { url: "https://example.com" });
 * const page = await research.callTool("view_page", {});
 * await research.close();
 * ```
 *
 * Isolation: every session runs in its own worker thread by default, so the
 * module-level caches (`a11yTree`, `selectorCache`, emulation viewport, the
 * stealth flag, the cortex matcher) exist once per session instead of once
 * per process. `isolation: "process"` puts each session in its own OS
 * process instead — a real memory and file-descriptor boundary, at the cost
 * of a fork. `isolation: "inline"` skips isolation entirely and is only
 * correct when the host thread runs exactly one session.
 *
 * Environment: a session starts from a documented minimum, not from the host
 * environment. Public Browser's own `SILBERCUE_*` / `PUBLIC_BROWSER_*`
 * variables never travel (every one of them has an option here), and neither
 * do the host's credentials — an orchestrator's API keys have no business in a
 * browser session. Widen it deliberately with `inheritEnv`. See
 * `session-env.ts` for the exact rules.
 */

import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { buildSessionEnv, type InheritEnv } from "./session-env.js";
import type { SessionCore, SessionCoreOptions } from "./session-core.js";
import type {
  HostToWorkerMessage,
  WorkerInitData,
  WorkerReadyInfo,
  WorkerToHostMessage,
} from "./worker-protocol.js";
import type { ToolResponse } from "../types.js";

export type SessionIsolation = "worker" | "process" | "inline";

export interface CreateSessionOptions extends SessionCoreOptions {
  /**
   * `"worker"` (default) runs the session in its own thread — enough for
   * more than one session per process. `"process"` forks a child process
   * instead, giving a separate heap, separate file descriptors and a
   * separate crash domain; pick it when the trust boundary has to be a
   * process boundary. `"inline"` keeps the session in the calling thread,
   * which is cheapest but shares all module-level caches.
   */
  isolation?: SessionIsolation;
  /**
   * Cortex pattern store for this instance (`PUBLIC_BROWSER_CORTEX_DIR`).
   * Give every session its own directory so instances do not append to each
   * other's Merkle log. In `"inline"` mode this only takes effect if the
   * cortex modules have not been loaded yet — another reason to prefer
   * worker or process isolation.
   */
  cortexDir?: string;
   /**
   * What the session inherits from the host environment. `false` (default)
   * gives it the documented essentials only (`PATH`, `HOME`, temp dir,
   * `CHROME_PATH`, platform basics — see `ESSENTIAL_ENV_VARS`), an array adds
   * the names you list (`["HTTPS_PROXY", "NO_PROXY"]` is the common one), and
   * `true` inherits everything. Public Browser's own config variables are
   * stripped in every case; use `env` to set one deliberately.
   *
   * `"inline"` sessions run in the host's own process and cannot have their
   * environment restricted — only the config-variable strip applies there.
   */
  inheritEnv?: InheritEnv;
  /**
   * Extra environment variables for the session. Applied last, so they win
   * over both inheritance and the config-variable strip; `undefined` values
   * unset a variable. Worker and process isolation only.
   */
  env?: Record<string, string | undefined>;
  /**
   * Connect to (or launch) Chrome during `createSession()` instead of on the
   * first tool call. Surfaces launch failures immediately. Default: false.
   */
  eager?: boolean;
  /** Startup budget for the session thread/process in ms (default: 30000). */
  startupTimeoutMs?: number;
}

export interface PublicBrowserSession {
  /** Stable id for logs — `pb-1`, `pb-2`, ... within this process. */
  readonly id: string;
  readonly isolation: SessionIsolation;
  /** OS process id of the session — only set for `isolation: "process"`. */
  readonly pid: number | undefined;
  /**
   * CDP port this session drives. `undefined` with `transport: "pipe"` —
   * there is no listening port, and the default would name the user's own
   * Chrome on 9222.
   */
  readonly cdpPort: number | undefined;
  /** CDP host this session drives. */
  readonly cdpHost: string;
  /** Whether `navigator.webdriver` masking is active. `false` = honest bot. */
  readonly stealth: boolean;
  /**
   * CDP transport in use. `"pipe"` means no port is listening, so no other
   * local process can attach to this browser.
   */
  readonly transport: "port" | "pipe";
  /** Directory downloads land in (temp dir when none was configured). */
  readonly downloadDir: string | undefined;
  /** True until `close()` completes or the session dies. */
  readonly isAlive: boolean;
  /**
   * Execute a Public Browser tool — same names and parameters as the MCP
   * tools (`navigate`, `view_page`, `click`, `type`, `fill_form`, `run_plan`,
   * `download`, ...). Chrome is launched lazily on the first call.
   */
  callTool(name: string, params?: Record<string, unknown>): Promise<ToolResponse>;
  /** Shut the session down: closes Chrome (if we launched it) and the endpoint. */
  close(): Promise<void>;
}

let sessionCounter = 0;

/**
 * Locate a compiled entry next to this module, falling back to the `.ts`
 * source so the library also works under a TypeScript loader (tsx, ts-node,
 * vitest).
 */
function resolveEntry(base: string): URL {
  const js = new URL(`./${base}.js`, import.meta.url);
  if (existsSync(fileURLToPath(js))) return js;
  const ts = new URL(`./${base}.ts`, import.meta.url);
  if (existsSync(fileURLToPath(ts))) return ts;
  throw new Error(
    `Public Browser session entry "${base}" not found next to ${import.meta.url}. ` +
      `Use createSession({ isolation: "inline" }) if the package layout is bundled.`,
  );
}

/**
 * Build the session's `process.env`.
 *
 * Kept as a named export for integrators who construct their own runners and
 * want the exact same rules; `buildSessionEnv` holds the logic.
 */
export function buildWorkerEnv(
  hostEnv: Record<string, string | undefined>,
  options: CreateSessionOptions,
): Record<string, string> {
  return buildSessionEnv(hostEnv, {
    inheritEnv: options.inheritEnv,
    cortexDir: options.cortexDir,
    env: options.env,
  });
}

/**
 * Create an isolated Public Browser session inside this process.
 * Resolves once the session is constructed (and, with `eager: true`, once
 * Chrome is actually reachable).
 */
export async function createSession(
  options: CreateSessionOptions = {},
): Promise<PublicBrowserSession> {
  const id = `pb-${++sessionCounter}`;
  const isolation = options.isolation ?? "worker";
  if (isolation === "inline") return createInlineSession(id, options);
  return createChannelSession(id, isolation, options);
}

// ── inline ────────────────────────────────────────────────────────────

async function createInlineSession(
  id: string,
  options: CreateSessionOptions,
): Promise<PublicBrowserSession> {
  if (options.cortexDir) {
    // Best effort: only wins if the cortex store has not been constructed yet.
    process.env.PUBLIC_BROWSER_CORTEX_DIR = options.cortexDir;
  }

  // An inline session runs in the host's own environment, so `inheritEnv`
  // cannot be honoured — but the config-variable strip can be, and must be:
  // the whole point is that explicit options are not overridden by a
  // host-level `SILBERCUE_CHROME_HOST`.
  const env = buildSessionEnv(process.env as Record<string, string | undefined>, {
    cortexDir: options.cortexDir,
    env: options.env,
  });

  const { createSessionCore } = await import("./session-core.js");
  const core: SessionCore = createSessionCore(options, env);
  if (options.eager) await core.start();

  let alive = true;
  return {
    id,
    isolation: "inline",
    pid: undefined,
    cdpPort: core.cdpPort,
    cdpHost: core.cdpHost,
    stealth: core.stealth,
    transport: core.transport,
    get downloadDir() {
      return core.downloadDir;
    },
    get isAlive() {
      return alive;
    },
    async callTool(name, params = {}) {
      if (!alive) throw new Error(`Session ${id} is closed`);
      return core.callTool(name, params);
    },
    async close() {
      if (!alive) return;
      alive = false;
      await core.close();
    },
  };
}

// ── worker / process ──────────────────────────────────────────────────

/**
 * The slice of a Worker or a ChildProcess this module actually uses. Both
 * transports speak the same message protocol; only the plumbing differs.
 */
interface SessionChannel {
  readonly pid: number | undefined;
  send(message: HostToWorkerMessage): void;
  onMessage(fn: (message: WorkerToHostMessage) => void): void;
  offMessage(fn: (message: WorkerToHostMessage) => void): void;
  onError(fn: (err: Error) => void): void;
  offError(fn: (err: Error) => void): void;
  onExit(fn: (code: number) => void): void;
  offExit(fn: (code: number) => void): void;
  terminate(): Promise<void>;
}

function workerChannel(worker: Worker): SessionChannel {
  return {
    pid: undefined,
    send: (message) => worker.postMessage(message),
    onMessage: (fn) => void worker.on("message", fn),
    offMessage: (fn) => void worker.off("message", fn),
    onError: (fn) => void worker.on("error", fn),
    offError: (fn) => void worker.off("error", fn),
    onExit: (fn) => void worker.on("exit", fn),
    offExit: (fn) => void worker.off("exit", fn),
    terminate: async () => {
      await worker.terminate().catch(() => {});
    },
  };
}

function childChannel(child: ChildProcess): SessionChannel {
  // `exit` reports a signal instead of a code for a killed process
  // (SIGKILL → code null), so the listener is wrapped. Keep the wrappers
  // addressable, otherwise `offExit` cannot detach what `onExit` attached.
  const exitWrappers = new Map<(code: number) => void, (code: number | null) => void>();

  return {
    pid: child.pid,
    send: (message) => {
      if (!child.connected) throw new Error("Session process is not connected");
      child.send(message);
    },
    onMessage: (fn) => void child.on("message", fn as (message: unknown) => void),
    offMessage: (fn) => void child.off("message", fn as (message: unknown) => void),
    onError: (fn) => void child.on("error", fn),
    offError: (fn) => void child.off("error", fn),
    onExit: (fn) => {
      const wrapper = (code: number | null) => fn(code ?? -1);
      exitWrappers.set(fn, wrapper);
      child.on("exit", wrapper);
    },
    offExit: (fn) => {
      const wrapper = exitWrappers.get(fn);
      if (!wrapper) return;
      exitWrappers.delete(fn);
      child.off("exit", wrapper);
    },
    terminate: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

interface Pending {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

async function createChannelSession(
  id: string,
  isolation: "worker" | "process",
  options: CreateSessionOptions,
): Promise<PublicBrowserSession> {
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const initData: WorkerInitData = {
    // Strip host-only fields — the endpoint builds a plain SessionCore.
    options: stripHostOptions(options),
    eager: options.eager ?? false,
  };
  const env = buildWorkerEnv(process.env as Record<string, string | undefined>, options);

  let channel: SessionChannel;
  if (isolation === "worker") {
    channel = workerChannel(
      new Worker(resolveEntry("session-worker"), { workerData: initData, env }),
    );
  } else {
    const entry = fileURLToPath(resolveEntry("session-child"));
    channel = childChannel(
      fork(entry, [JSON.stringify(initData)], {
        env,
        // The session must never write to the host's stdout: an MCP host
        // speaks JSON-RPC there. stderr stays inherited so launch problems
        // remain visible in the operator's log.
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      }),
    );
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let alive = true;
  let deathReason: Error | null = null;

  const killPending = (err: Error) => {
    deathReason = err;
    alive = false;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  channel.onMessage((message: WorkerToHostMessage) => {
    if (message.t === "ready" || message.t === "init-error") return; // handled below
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.t === "result") entry.resolve(message.json);
    else if (message.t === "closed") entry.resolve("{}");
    else entry.reject(toError(message.message, message.stack));
  });

  channel.onError((err) => {
    killPending(err instanceof Error ? err : new Error(String(err)));
  });

  channel.onExit((code) => {
    if (!alive && pending.size === 0) return;
    killPending(new Error(`Public Browser session ${id} ${isolation} exited (code ${code})`));
  });

  const info = await waitForReady(channel, id, isolation, startupTimeoutMs);

  const send = (message: HostToWorkerMessage): Promise<string> => {
    if (!alive) {
      return Promise.reject(deathReason ?? new Error(`Session ${id} is closed`));
    }
    return new Promise<string>((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      try {
        channel.send(message);
      } catch (err) {
        pending.delete(message.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return {
    id,
    isolation,
    pid: channel.pid,
    cdpPort: info.cdpPort,
    cdpHost: info.cdpHost,
    stealth: info.stealth,
    transport: info.transport,
    downloadDir: info.downloadDir,
    get isAlive() {
      return alive;
    },
    async callTool(name, params = {}) {
      const json = await send({ t: "call", id: nextId++, tool: name, params });
      return JSON.parse(json) as ToolResponse;
    },
    async close() {
      if (!alive) return;
      try {
        await send({ t: "close", id: nextId++ });
      } catch {
        // The endpoint may exit before acknowledging — that is a successful
        // shutdown from the host's point of view.
      }
      alive = false;
      pending.clear();
      await channel.terminate();
    },
  };
}

/** Remove options that only mean something on the host side. */
function stripHostOptions(options: CreateSessionOptions): SessionCoreOptions {
  const {
    isolation: _isolation,
    cortexDir: _cortexDir,
    inheritEnv: _inheritEnv,
    env: _env,
    eager: _eager,
    startupTimeoutMs: _startupTimeoutMs,
    ...core
  } = options;
  return core;
}

function toError(message: string, stack?: string): Error {
  const err = new Error(message);
  if (stack) err.stack = stack;
  return err;
}

function waitForReady(
  channel: SessionChannel,
  id: string,
  isolation: string,
  timeoutMs: number,
): Promise<WorkerReadyInfo> {
  return new Promise<WorkerReadyInfo>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.offMessage(onMessage);
      channel.offError(onError);
      channel.offExit(onExit);
      fn();
    };

    const onMessage = (message: WorkerToHostMessage) => {
      if (message.t === "ready") finish(() => resolve(message.info));
      else if (message.t === "init-error") {
        finish(() => {
          void channel.terminate();
          reject(toError(message.message, message.stack));
        });
      }
    };
    const onError = (err: Error) => finish(() => reject(err));
    const onExit = (code: number) =>
      finish(() =>
        reject(
          new Error(
            `Public Browser session ${id} ${isolation} exited during startup (code ${code})`,
          ),
        ),
      );

    const timer = setTimeout(() => {
      finish(() => {
        void channel.terminate();
        reject(new Error(`Public Browser session ${id} did not start within ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref();

    channel.onMessage(onMessage);
    channel.onError(onError);
    channel.onExit(onExit);
  });
}
