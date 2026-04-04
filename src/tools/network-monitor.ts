import { z } from "zod";
import type { NetworkCollector } from "../cdp/network-collector.js";
import type { ToolResponse } from "../types.js";

export const networkMonitorSchema = z.object({
  action: z.enum(["start", "get", "stop"])
    .describe("start: begin recording, get: retrieve recorded requests, stop: return and clear"),
  filter: z.enum(["failed"])
    .optional()
    .describe("Filter results — 'failed': only requests with HTTP >= 400 or network errors"),
  pattern: z.string()
    .optional()
    .describe("Regex pattern to match against request URLs"),
});

export type NetworkMonitorParams = z.infer<typeof networkMonitorSchema>;

export async function networkMonitorHandler(
  params: NetworkMonitorParams,
  networkCollector: NetworkCollector,
): Promise<ToolResponse> {
  const start = performance.now();

  // action: "start"
  if (params.action === "start") {
    await networkCollector.start();
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "monitoring",
        since: networkCollector.monitoringSince,
      }) }],
      _meta: { elapsedMs: Math.round(performance.now() - start), method: "network_monitor" },
    };
  }

  // action: "get"
  if (params.action === "get") {
    if (!networkCollector.isMonitoring) {
      return {
        content: [{ type: "text", text: "Network-Monitoring nicht aktiv — starte mit action: 'start'" }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "network_monitor" },
      };
    }
    let requests;
    try {
      requests = (params.filter || params.pattern)
        ? networkCollector.getFiltered(params.filter, params.pattern)
        : networkCollector.getAll();
    } catch (err) {
      return {
        content: [{ type: "text", text: `Invalid regex pattern: ${(err as Error).message}` }],
        isError: true,
        _meta: { elapsedMs: Math.round(performance.now() - start), method: "network_monitor" },
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(requests) }],
      _meta: {
        elapsedMs: Math.round(performance.now() - start),
        method: "network_monitor",
        count: requests.length,
      },
    };
  }

  // action: "stop"
  const requests = await networkCollector.stop();
  return {
    content: [{ type: "text", text: JSON.stringify(requests) }],
    _meta: {
      elapsedMs: Math.round(performance.now() - start),
      method: "network_monitor",
      count: requests.length,
    },
  };
}
