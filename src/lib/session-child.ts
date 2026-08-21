/**
 * Child-process entry point for an isolated Public Browser session.
 *
 * Same protocol as the worker variant, one difference that matters: this is
 * a separate OS process. Separate heap, separate file descriptors, separate
 * crash domain — a session cannot read the host's memory, and a segfault in
 * Chrome's CDP client takes down the session instead of the orchestrator.
 * Integrators whose trust model draws the line at the process boundary pick
 * `isolation: "process"` for exactly that; everyone else pays ~40 ms less
 * startup with the default worker thread.
 *
 * Init data arrives as `process.argv[2]` (JSON) rather than over the IPC
 * channel, so the core is already booting while the host attaches its
 * listeners. Started only by `createSession()` — never run directly.
 */

import { startSessionEndpoint } from "./session-endpoint.js";
import type { HostToWorkerMessage, WorkerInitData } from "./worker-protocol.js";

const send = process.send?.bind(process);
if (!send) {
  throw new Error("session-child.js must be started with an IPC channel (child_process.fork)");
}

const raw = process.argv[2];
if (!raw) {
  throw new Error("session-child.js requires its init payload as argv[2]");
}

const handle = startSessionEndpoint(JSON.parse(raw) as WorkerInitData, {
  post: (message) => {
    try {
      send(message);
    } catch {
      // The host went away mid-reply — nothing to deliver to.
    }
  },
  exit: (code) => process.exit(code),
});

process.on("message", (message: HostToWorkerMessage) => handle(message));

// Without a `disconnect` guard a killed host would leave the session — and
// the Chrome it launched — running: the IPC channel closes and no `close`
// message ever arrives. Route it through the normal shutdown so Chrome is
// terminated and a caller-supplied download directory stays untouched.
process.on("disconnect", () => handle({ t: "close", id: -1 }));
