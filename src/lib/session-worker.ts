/**
 * Worker-thread entry point for an isolated Public Browser session.
 *
 * One worker == one Chrome == one complete copy of the module graph. That
 * last part is the whole point: `a11yTree`, `selectorCache`, the `emulation`
 * viewport state, the stealth flag and the cortex hint matcher are all
 * module-level singletons. Running each session in its own thread gives every
 * instance a private copy instead of a shared one, which is what makes
 * "N sessions in one host process" correct rather than merely convenient.
 *
 * A thread is not a trust boundary — same process memory, same file
 * descriptors. `isolation: "process"` (see `session-child.ts`) is the variant
 * for integrators who need one.
 *
 * Started only by `createSession()` — never run directly.
 */

import { parentPort, workerData } from "node:worker_threads";
import { startSessionEndpoint } from "./session-endpoint.js";
import type { HostToWorkerMessage, WorkerInitData } from "./worker-protocol.js";

const port = parentPort;
if (!port) {
  throw new Error("session-worker.js must be started as a worker thread");
}

const handle = startSessionEndpoint(workerData as WorkerInitData, {
  post: (message) => port.postMessage(message),
  exit: (code) => process.exit(code),
});

port.on("message", (message: HostToWorkerMessage) => handle(message));
