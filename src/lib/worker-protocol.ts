/**
 * Message protocol between the host thread and a session worker.
 *
 * Payloads are deliberately plain JSON: tool responses can carry base64
 * image blocks and arbitrary `_meta` shapes, and `postMessage`'s structured
 * clone rejects anything non-cloneable (functions, class instances). Encoding
 * the response as a JSON string keeps the channel total instead of failing on
 * an unexpected `_meta` value.
 */

import type { SessionCoreOptions } from "./session-core.js";

export interface WorkerInitData {
  options: SessionCoreOptions;
  /** Connect to / launch Chrome during startup instead of on the first call. */
  eager: boolean;
}

/** Facts about the live session, reported once the worker is up. */
export interface WorkerReadyInfo {
  cdpPort: number;
  cdpHost: string;
  stealth: boolean;
  downloadDir?: string;
}

export type HostToWorkerMessage =
  | { t: "call"; id: number; tool: string; params: Record<string, unknown> }
  | { t: "info"; id: number }
  | { t: "close"; id: number };

export type WorkerToHostMessage =
  | { t: "ready"; info: WorkerReadyInfo }
  | { t: "init-error"; message: string; stack?: string }
  /** `json` is a JSON-encoded ToolResponse (or WorkerReadyInfo for `info`). */
  | { t: "result"; id: number; json: string }
  | { t: "error"; id: number; message: string; stack?: string }
  | { t: "closed"; id: number };
