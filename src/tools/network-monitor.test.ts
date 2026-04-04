import { describe, it, expect, vi, beforeEach } from "vitest";
import { networkMonitorHandler } from "./network-monitor.js";
import type { NetworkCollector, NetworkRequestEntry } from "../cdp/network-collector.js";

// --- Mock NetworkCollector ---

function createMockCollector(opts: {
  isMonitoring?: boolean;
  entries?: NetworkRequestEntry[];
  monitoringSince?: number;
} = {}): {
  collector: NetworkCollector;
  startFn: ReturnType<typeof vi.fn>;
  stopFn: ReturnType<typeof vi.fn>;
  getAllFn: ReturnType<typeof vi.fn>;
  getFilteredFn: ReturnType<typeof vi.fn>;
} {
  const entries = opts.entries ?? [];
  const startFn = vi.fn(async () => {});
  const stopFn = vi.fn(async () => [...entries]);
  const getAllFn = vi.fn<[], NetworkRequestEntry[]>().mockReturnValue([...entries]);
  const getFilteredFn = vi.fn<[string?, string?], NetworkRequestEntry[]>().mockImplementation(
    (filter?: string, pattern?: string) => {
      let result = [...entries];
      if (filter === "failed") result = result.filter((e) => e.failed || e.status >= 400);
      if (pattern) {
        const re = new RegExp(pattern);
        result = result.filter((e) => re.test(e.url));
      }
      return result;
    },
  );

  const collector = {
    start: startFn,
    stop: stopFn,
    getAll: getAllFn,
    getFiltered: getFilteredFn,
    isMonitoring: opts.isMonitoring ?? false,
    monitoringSince: opts.monitoringSince ?? 12345,
    count: entries.length,
    detach: vi.fn(),
    reinit: vi.fn(),
  } as unknown as NetworkCollector;

  return { collector, startFn, stopFn, getAllFn, getFilteredFn };
}

const SAMPLE_REQUESTS: NetworkRequestEntry[] = [
  {
    url: "https://example.com/api/v2/users",
    method: "GET",
    status: 200,
    mimeType: "application/json",
    size: 2048,
    duration: 150,
    initiator: "script",
    failed: false,
  },
  {
    url: "https://example.com/style.css",
    method: "GET",
    status: 200,
    mimeType: "text/css",
    size: 512,
    duration: 30,
    initiator: "parser",
    failed: false,
  },
  {
    url: "https://example.com/api/v2/broken",
    method: "POST",
    status: 0,
    mimeType: "",
    size: 0,
    duration: 50,
    initiator: "script",
    failed: true,
    errorText: "net::ERR_FAILED",
  },
  {
    url: "https://example.com/not-found",
    method: "GET",
    status: 404,
    mimeType: "text/html",
    size: 128,
    duration: 20,
    initiator: "parser",
    failed: false,
  },
];

describe("networkMonitorHandler", () => {
  // --- action: "start" ---

  it('action "start": calls networkCollector.start() and returns status "monitoring"', async () => {
    const { collector, startFn } = createMockCollector({ monitoringSince: 9999 });

    const result = await networkMonitorHandler(
      { action: "start" },
      collector,
    );

    expect(startFn).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.status).toBe("monitoring");
    expect(parsed.since).toBeDefined();
  });

  // --- action: "get" ---

  it('action "get": returns all requests as JSON with count in _meta', async () => {
    const { collector } = createMockCollector({
      isMonitoring: true,
      entries: SAMPLE_REQUESTS,
    });

    const result = await networkMonitorHandler(
      { action: "get" },
      collector,
    );

    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(4);
    expect(result._meta?.count).toBe(4);
  });

  it('action "get" without active monitoring: isError with hint', async () => {
    const { collector } = createMockCollector({ isMonitoring: false });

    const result = await networkMonitorHandler(
      { action: "get" },
      collector,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Network-Monitoring nicht aktiv",
    );
  });

  it('action "get" with filter "failed": returns only failed requests', async () => {
    const { collector, getFilteredFn } = createMockCollector({
      isMonitoring: true,
      entries: SAMPLE_REQUESTS,
    });

    const result = await networkMonitorHandler(
      { action: "get", filter: "failed" },
      collector,
    );

    expect(result.isError).toBeFalsy();
    expect(getFilteredFn).toHaveBeenCalledWith("failed", undefined);

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    // Should include the network error (failed: true) and 404 (status >= 400)
    expect(parsed).toHaveLength(2);
  });

  it('action "get" with pattern: matches URL per regex', async () => {
    const { collector, getFilteredFn } = createMockCollector({
      isMonitoring: true,
      entries: SAMPLE_REQUESTS,
    });

    const result = await networkMonitorHandler(
      { action: "get", pattern: "api/v2" },
      collector,
    );

    expect(result.isError).toBeFalsy();
    expect(getFilteredFn).toHaveBeenCalledWith(undefined, "api/v2");

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].url).toContain("api/v2");
    expect(parsed[1].url).toContain("api/v2");
  });

  it('action "get" with invalid regex: isError with error message', async () => {
    const { collector, getFilteredFn } = createMockCollector({
      isMonitoring: true,
      entries: SAMPLE_REQUESTS,
    });

    getFilteredFn.mockImplementation(() => {
      throw new SyntaxError("Invalid regular expression: /[invalid/: Unterminated character class");
    });

    const result = await networkMonitorHandler(
      { action: "get", pattern: "[invalid" },
      collector,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid regex pattern");
  });

  // --- action: "stop" ---

  it('action "stop": returns collected requests and stops monitoring', async () => {
    const { collector, stopFn } = createMockCollector({
      isMonitoring: true,
      entries: SAMPLE_REQUESTS,
    });

    const result = await networkMonitorHandler(
      { action: "stop" },
      collector,
    );

    expect(stopFn).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toHaveLength(4);
    expect(result._meta?.count).toBe(4);
  });

  it('action "stop" without active monitoring: returns empty array, no error', async () => {
    const { collector, stopFn } = createMockCollector({
      isMonitoring: false,
      entries: [],
    });

    const result = await networkMonitorHandler(
      { action: "stop" },
      collector,
    );

    expect(stopFn).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual([]);
    expect(result._meta?.count).toBe(0);
  });

  // --- _meta ---

  it("_meta contains elapsedMs and method: network_monitor", async () => {
    const { collector } = createMockCollector({ isMonitoring: true, entries: [] });

    const result = await networkMonitorHandler(
      { action: "get" },
      collector,
    );

    expect(result._meta).toBeDefined();
    expect(result._meta?.method).toBe("network_monitor");
    expect(typeof result._meta?.elapsedMs).toBe("number");
  });
});
