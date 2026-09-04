import { z } from "zod";
import type { DownloadCollector, DownloadInfo } from "../cdp/download-collector.js";
import type { ToolResponse } from "../types.js";

export const downloadSchema = z.object({
  action: z.enum(["status", "list"])
    .default("status")
    .describe("status waits for pending downloads; list: history, never waits (use for polling)"),
  timeout: z.number()
    .optional()
    .default(30_000)
    .describe("Max wait in ms for pending downloads"),
  settle: z.number()
    .optional()
    .default(250)
    .describe("Ms to wait for a download to START before reporting none — Chrome fires downloadWillBegin a few ms after the click; 0 = instant"),
});

export type DownloadParams = z.infer<typeof downloadSchema>;

function formatDownload(d: DownloadInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {
    filename: d.suggestedFilename,
    path: d.path,
    size: d.size,
    sizeKb: Math.ceil(d.size / 1024),
    url: d.url,
  };
  // Only present when the session runs with downloadHash enabled — keeping it
  // conditional avoids a `"sha256": null` field in every default response.
  if (d.sha256) out.sha256 = d.sha256;
  return out;
}

export async function downloadHandler(
  params: DownloadParams,
  downloadCollector: DownloadCollector,
): Promise<ToolResponse> {
  const start = performance.now();
  const action = params.action ?? "status";

  // --- action: "list" ---
  if (action === "list") {
    const all = downloadCollector.getAllDownloads();
    if (all.length === 0) {
      return {
        content: [{ type: "text", text: "No downloads in this session." }],
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "download", count: 0 },
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(all.map(formatDownload)) }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "download", count: all.length },
    };
  }

  // --- action: "status" (default) ---
  // Grace window first: a download triggered by the click right before this
  // call may not have produced Browser.downloadWillBegin yet. Without it the
  // first status call reports "no downloads" for a file that arrives moments
  // later, and the caller has to invent a retry delay.
  //
  // Kept short on purpose — it is a per-call floor for anyone polling in a
  // loop, and Chrome's willBegin lands in tens of milliseconds. `settle: 0`
  // and `action: "list"` are the wait-free paths.
  const settle = params.settle ?? 250;
  if (downloadCollector.pendingCount === 0 && downloadCollector.completedCount === 0) {
    await downloadCollector.waitForStart(settle);
  }

  const pending = downloadCollector.pendingCount;
  const alreadyCompleted = downloadCollector.consumeCompleted();

  // Nothing in progress and nothing completed — quick exit
  if (pending === 0 && alreadyCompleted.length === 0) {
    return {
      content: [{ type: "text", text: "No downloads in progress or completed." }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "download", pending: 0 },
    };
  }

  // If downloads are pending — wait for them
  let newlyCompleted: DownloadInfo[] = [];
  if (pending > 0) {
    const timeout = params.timeout ?? 30_000;
    newlyCompleted = await downloadCollector.waitForCompletion(timeout);
  }

  const allCompleted = [...alreadyCompleted, ...newlyCompleted];
  const stillPending = downloadCollector.pendingCount;

  const result: Record<string, unknown> = {
    downloads: allCompleted.map(formatDownload),
    pending: stillPending,
  };

  if (stillPending > 0) {
    result.note = `${stillPending} download(s) still in progress after timeout.`;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    _meta: {
      elapsedMs: Math.round(performance.now() - start),
      method: "download",
      count: allCompleted.length,
      pending: stillPending,
    },
  };
}
