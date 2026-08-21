/**
 * The session side of the host↔session protocol, independent of transport.
 *
 * Two transports use it: a worker thread (`session-worker.ts`, cheap, shares
 * the host's process) and a child process (`session-child.ts`, one OS process
 * per session — a real memory and file-descriptor boundary for integrators
 * whose trust model needs one). Both are thin wrappers; everything that can
 * differ between them is the `channel`.
 *
 * The session core itself is imported dynamically on purpose: `process.env`
 * for this thread/process is supplied by the host, and modules that read env
 * at import time (the cortex store's data directory, for one) must see the
 * final values. A static import would be hoisted above that setup.
 */

import type { SessionCore } from "./session-core.js";
import type {
  HostToWorkerMessage,
  WorkerInitData,
  WorkerReadyInfo,
  WorkerToHostMessage,
} from "./worker-protocol.js";

export interface EndpointChannel {
  /** Deliver a message to the host. */
  post(message: WorkerToHostMessage): void;
  /**
   * Terminate this endpoint after a `close`. Chrome pipes and CDP sockets can
   * keep the event loop alive, so exiting explicitly is what guarantees the
   * host's `close()` resolves instead of hanging.
   */
  exit(code: number): void;
}

function describe(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

function readyInfo(core: SessionCore): WorkerReadyInfo {
  return {
    cdpPort: core.cdpPort,
    cdpHost: core.cdpHost,
    stealth: core.stealth,
    downloadDir: core.downloadDir,
    transport: core.transport,
  };
}

/**
 * Boot a session core and return the message handler for it.
 *
 * Messages that arrive before the core is up are answered with an error
 * rather than queued — the host waits for `ready` before sending anything,
 * so this only fires on protocol misuse.
 */
export function startSessionEndpoint(
  init: WorkerInitData,
  channel: EndpointChannel,
): (message: HostToWorkerMessage) => void {
  let core: SessionCore | null = null;

  void (async () => {
    try {
      const { createSessionCore } = await import("./session-core.js");
      core = createSessionCore(init.options);
      if (init.eager) await core.start();
      channel.post({ t: "ready", info: readyInfo(core) });
    } catch (err) {
      channel.post({ t: "init-error", ...describe(err) });
    }
  })();

  async function handle(message: HostToWorkerMessage): Promise<void> {
    if (message.t === "close") {
      try {
        await core?.close();
      } catch {
        /* shutdown is best-effort — the endpoint is going away either way */
      }
      channel.post({ t: "closed", id: message.id });
      channel.exit(0);
      return;
    }

    if (!core) {
      channel.post({ t: "error", id: message.id, message: "Session is not initialised" });
      return;
    }

    try {
      if (message.t === "info") {
        channel.post({ t: "result", id: message.id, json: JSON.stringify(readyInfo(core)) });
        return;
      }

      const response = await core.callTool(message.tool, message.params);
      channel.post({ t: "result", id: message.id, json: JSON.stringify(response) });
    } catch (err) {
      channel.post({ t: "error", id: message.id, ...describe(err) });
    }
  }

  return (message: HostToWorkerMessage) => {
    void handle(message);
  };
}
