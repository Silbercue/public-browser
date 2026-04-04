import { describe, it, expect, vi, beforeEach } from "vitest";
import { NetworkCollector } from "./network-collector.js";
import type { CdpClient } from "./cdp-client.js";

// --- Mock debug ---

vi.mock("./debug.js", () => ({
  debug: vi.fn(),
}));

// --- Types ---

type EventCallback = (params: unknown, sessionId?: string) => void;

// --- Mock CDP client ---

interface MockCdpSetup {
  cdpClient: CdpClient;
  sendFn: ReturnType<typeof vi.fn>;
  onFn: ReturnType<typeof vi.fn>;
  offFn: ReturnType<typeof vi.fn>;
  listeners: Map<string, Set<{ callback: EventCallback; sessionId?: string }>>;
  fireEvent: (method: string, params: unknown) => void;
}

function createMockCdp(): MockCdpSetup {
  const listeners = new Map<string, Set<{ callback: EventCallback; sessionId?: string }>>();

  const sendFn = vi.fn(async () => ({}));

  const onFn = vi.fn((method: string, callback: EventCallback, sessionId?: string) => {
    let set = listeners.get(method);
    if (!set) {
      set = new Set();
      listeners.set(method, set);
    }
    set.add({ callback, sessionId });
  });

  const offFn = vi.fn((method: string, callback: EventCallback) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        if (entry.callback === callback) {
          set.delete(entry);
          break;
        }
      }
    }
  });

  const fireEvent = (method: string, params: unknown) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        entry.callback(params, entry.sessionId);
      }
    }
  };

  const cdpClient = {
    send: sendFn,
    on: onFn,
    once: vi.fn(),
    off: offFn,
  } as unknown as CdpClient;

  return { cdpClient, sendFn, onFn, offFn, listeners, fireEvent };
}

// --- Helper: simulate a full request lifecycle ---

function fireFullRequest(
  mock: MockCdpSetup,
  opts: {
    requestId: string;
    url: string;
    method?: string;
    startTimestamp: number;
    status?: number;
    mimeType?: string;
    endTimestamp?: number;
    encodedDataLength?: number;
    initiator?: string;
  },
): void {
  mock.fireEvent("Network.requestWillBeSent", {
    requestId: opts.requestId,
    request: { url: opts.url, method: opts.method ?? "GET" },
    timestamp: opts.startTimestamp,
    initiator: { type: opts.initiator ?? "script" },
  });

  if (opts.status !== undefined) {
    mock.fireEvent("Network.responseReceived", {
      requestId: opts.requestId,
      response: { status: opts.status, mimeType: opts.mimeType ?? "text/html" },
    });
  }

  if (opts.endTimestamp !== undefined) {
    mock.fireEvent("Network.loadingFinished", {
      requestId: opts.requestId,
      timestamp: opts.endTimestamp,
      encodedDataLength: opts.encodedDataLength ?? 0,
    });
  }
}

describe("NetworkCollector", () => {
  let mock: MockCdpSetup;
  let collector: NetworkCollector;

  beforeEach(() => {
    mock = createMockCdp();
    collector = new NetworkCollector(mock.cdpClient, "test-session");
  });

  // --- start tests ---

  it("start() calls Network.enable and registers 4 event listeners", async () => {
    await collector.start();

    expect(mock.sendFn).toHaveBeenCalledWith("Network.enable", {}, "test-session");
    expect(mock.onFn).toHaveBeenCalledWith("Network.requestWillBeSent", expect.any(Function), "test-session");
    expect(mock.onFn).toHaveBeenCalledWith("Network.responseReceived", expect.any(Function), "test-session");
    expect(mock.onFn).toHaveBeenCalledWith("Network.loadingFinished", expect.any(Function), "test-session");
    expect(mock.onFn).toHaveBeenCalledWith("Network.loadingFailed", expect.any(Function), "test-session");
    expect(mock.onFn).toHaveBeenCalledTimes(4);
  });

  it("start() is idempotent — second call has no effect", async () => {
    await collector.start();
    await collector.start();

    // Network.enable called only once
    expect(mock.sendFn).toHaveBeenCalledTimes(1);
    expect(mock.onFn).toHaveBeenCalledTimes(4);
  });

  // --- stop tests ---

  it("stop() calls Network.disable, returns buffer and clears it", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/api",
      startTimestamp: 100.0,
      status: 200,
      mimeType: "application/json",
      endTimestamp: 100.5,
      encodedDataLength: 1024,
    });

    const result = await collector.stop();

    expect(mock.sendFn).toHaveBeenCalledWith("Network.disable", {}, "test-session");
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/api");
    expect(result[0].status).toBe(200);

    // Buffer should be cleared
    expect(collector.count).toBe(0);
    expect(collector.isMonitoring).toBe(false);
  });

  it("stop() without prior start() returns empty array", async () => {
    const result = await collector.stop();

    expect(result).toEqual([]);
    // Network.disable should NOT be called
    expect(mock.sendFn).not.toHaveBeenCalled();
  });

  // --- detach tests ---

  it("detach() removes listeners but does NOT call Network.disable", async () => {
    await collector.start();
    mock.sendFn.mockClear(); // Clear the Network.enable call

    collector.detach();

    expect(mock.offFn).toHaveBeenCalledWith("Network.requestWillBeSent", expect.any(Function));
    expect(mock.offFn).toHaveBeenCalledWith("Network.responseReceived", expect.any(Function));
    expect(mock.offFn).toHaveBeenCalledWith("Network.loadingFinished", expect.any(Function));
    expect(mock.offFn).toHaveBeenCalledWith("Network.loadingFailed", expect.any(Function));

    // No CDP send calls (Network.disable not called)
    expect(mock.sendFn).not.toHaveBeenCalled();
    expect(collector.isMonitoring).toBe(false);
  });

  // --- reinit tests ---

  it("reinit() detaches, sets new client/session, clears buffer", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com",
      startTimestamp: 100.0,
      status: 200,
      endTimestamp: 100.1,
    });
    expect(collector.count).toBe(1);

    const newMock = createMockCdp();
    collector.reinit(newMock.cdpClient, "new-session");

    // Old listeners removed
    expect(mock.offFn).toHaveBeenCalled();

    // Buffer and pending cleared
    expect(collector.count).toBe(0);

    // Monitoring OFF — agent must call start() again
    expect(collector.isMonitoring).toBe(false);
  });

  // --- requestWillBeSent tests ---

  it("requestWillBeSent creates PendingRequest in _pending map", async () => {
    await collector.start();

    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/api", method: "POST" },
      timestamp: 100.0,
      initiator: { type: "script" },
    });

    // Not yet in buffer (pending)
    expect(collector.count).toBe(0);

    // Complete it to verify it was tracked
    mock.fireEvent("Network.loadingFinished", {
      requestId: "req1",
      timestamp: 100.5,
      encodedDataLength: 512,
    });

    const entries = collector.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe("https://example.com/api");
    expect(entries[0].method).toBe("POST");
    expect(entries[0].initiator).toBe("script");
  });

  // --- responseReceived tests ---

  it("responseReceived sets status and mimeType on PendingRequest", async () => {
    await collector.start();

    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/data.json", method: "GET" },
      timestamp: 200.0,
      initiator: { type: "script" },
    });

    mock.fireEvent("Network.responseReceived", {
      requestId: "req1",
      response: { status: 200, mimeType: "application/json" },
    });

    mock.fireEvent("Network.loadingFinished", {
      requestId: "req1",
      timestamp: 200.3,
      encodedDataLength: 2048,
    });

    const entries = collector.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(200);
    expect(entries[0].mimeType).toBe("application/json");
    expect(entries[0].size).toBe(2048);
  });

  // --- loadingFinished tests ---

  it("loadingFinished completes request and moves to buffer", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/page",
      startTimestamp: 50.0,
      status: 200,
      mimeType: "text/html",
      endTimestamp: 50.8,
      encodedDataLength: 4096,
    });

    expect(collector.count).toBe(1);
    const entries = collector.getAll();
    expect(entries[0].size).toBe(4096);
  });

  // --- loadingFailed tests ---

  it("loadingFailed marks request as failed with errorText", async () => {
    await collector.start();

    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/broken", method: "GET" },
      timestamp: 300.0,
      initiator: { type: "other" },
    });

    mock.fireEvent("Network.loadingFailed", {
      requestId: "req1",
      timestamp: 300.1,
      errorText: "net::ERR_CONNECTION_REFUSED",
      canceled: false,
    });

    const entries = collector.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].failed).toBe(true);
    expect(entries[0].errorText).toBe("net::ERR_CONNECTION_REFUSED");
    expect(entries[0].status).toBe(0);
    expect(entries[0].size).toBe(0);
  });

  // --- Duration calculation ---

  it("duration is correctly calculated (CDP seconds to milliseconds)", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/slow",
      startTimestamp: 100.0,
      status: 200,
      endTimestamp: 102.5,  // 2.5 seconds
      encodedDataLength: 100,
    });

    const entries = collector.getAll();
    expect(entries[0].duration).toBe(2500); // 2.5s * 1000 = 2500ms
  });

  // --- Ring-Buffer ---

  it("ring buffer removes oldest entries at overflow (maxEntries)", async () => {
    const smallCollector = new NetworkCollector(mock.cdpClient, "test-session", {
      maxEntries: 3,
    });
    await smallCollector.start();

    for (let i = 1; i <= 4; i++) {
      fireFullRequest(mock, {
        requestId: `req${i}`,
        url: `https://example.com/page${i}`,
        startTimestamp: i * 10,
        status: 200,
        endTimestamp: i * 10 + 0.1,
      });
    }

    const entries = smallCollector.getAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].url).toBe("https://example.com/page2");
    expect(entries[1].url).toBe("https://example.com/page3");
    expect(entries[2].url).toBe("https://example.com/page4");
  });

  // --- Redirect handling ---

  it("redirect: second requestWillBeSent with same requestId overwrites URL", async () => {
    await collector.start();

    // First request
    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/old-url", method: "GET" },
      timestamp: 400.0,
      initiator: { type: "parser" },
    });

    // Redirect: same requestId, new URL
    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/new-url", method: "GET" },
      timestamp: 400.1,
      initiator: { type: "parser" },
      redirectResponse: { status: 302 },
    });

    mock.fireEvent("Network.responseReceived", {
      requestId: "req1",
      response: { status: 200, mimeType: "text/html" },
    });

    mock.fireEvent("Network.loadingFinished", {
      requestId: "req1",
      timestamp: 400.5,
      encodedDataLength: 1024,
    });

    const entries = collector.getAll();
    expect(entries).toHaveLength(1); // One entry, not two
    expect(entries[0].url).toBe("https://example.com/new-url");
    expect(entries[0].status).toBe(200);
  });

  // --- Unknown requestId handling ---

  it("responseReceived for unknown requestId is ignored", async () => {
    await collector.start();

    mock.fireEvent("Network.responseReceived", {
      requestId: "unknown-id",
      response: { status: 200, mimeType: "text/html" },
    });

    expect(collector.count).toBe(0);
  });

  // --- getFiltered tests ---

  it('getFiltered with filter "failed" returns only failed requests', async () => {
    await collector.start();

    // Successful request
    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/ok",
      startTimestamp: 500.0,
      status: 200,
      endTimestamp: 500.1,
    });

    // Network error (failed)
    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req2",
      request: { url: "https://example.com/broken", method: "GET" },
      timestamp: 501.0,
      initiator: { type: "script" },
    });
    mock.fireEvent("Network.loadingFailed", {
      requestId: "req2",
      timestamp: 501.1,
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    const filtered = collector.getFiltered("failed");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toBe("https://example.com/broken");
    expect(filtered[0].failed).toBe(true);
  });

  it('getFiltered with filter "failed" includes HTTP >= 400', async () => {
    await collector.start();

    // 200 OK
    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/ok",
      startTimestamp: 600.0,
      status: 200,
      endTimestamp: 600.1,
    });

    // 404 Not Found
    fireFullRequest(mock, {
      requestId: "req2",
      url: "https://example.com/not-found",
      startTimestamp: 601.0,
      status: 404,
      mimeType: "text/html",
      endTimestamp: 601.1,
    });

    // 500 Internal Server Error
    fireFullRequest(mock, {
      requestId: "req3",
      url: "https://example.com/error",
      startTimestamp: 602.0,
      status: 500,
      mimeType: "text/html",
      endTimestamp: 602.1,
    });

    const filtered = collector.getFiltered("failed");
    expect(filtered).toHaveLength(2);
    expect(filtered[0].url).toBe("https://example.com/not-found");
    expect(filtered[1].url).toBe("https://example.com/error");
  });

  it("getFiltered with pattern matches URL per regex", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/api/v2/users",
      startTimestamp: 700.0,
      status: 200,
      endTimestamp: 700.1,
    });

    fireFullRequest(mock, {
      requestId: "req2",
      url: "https://example.com/static/style.css",
      startTimestamp: 701.0,
      status: 200,
      endTimestamp: 701.1,
    });

    fireFullRequest(mock, {
      requestId: "req3",
      url: "https://example.com/api/v2/posts",
      startTimestamp: 702.0,
      status: 200,
      endTimestamp: 702.1,
    });

    const filtered = collector.getFiltered(undefined, "api/v2");
    expect(filtered).toHaveLength(2);
    expect(filtered[0].url).toContain("api/v2");
    expect(filtered[1].url).toContain("api/v2");
  });

  it("getFiltered with invalid regex throws Error", async () => {
    await collector.start();

    expect(() => collector.getFiltered(undefined, "[invalid")).toThrow();
  });

  it("getFiltered with filter + pattern combines both (AND)", async () => {
    await collector.start();

    // Failed API request
    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/api/v2/users", method: "GET" },
      timestamp: 800.0,
      initiator: { type: "script" },
    });
    mock.fireEvent("Network.loadingFailed", {
      requestId: "req1",
      timestamp: 800.1,
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    // Successful API request
    fireFullRequest(mock, {
      requestId: "req2",
      url: "https://example.com/api/v2/posts",
      startTimestamp: 801.0,
      status: 200,
      endTimestamp: 801.1,
    });

    // Failed non-API request
    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req3",
      request: { url: "https://example.com/image.png", method: "GET" },
      timestamp: 802.0,
      initiator: { type: "parser" },
    });
    mock.fireEvent("Network.loadingFailed", {
      requestId: "req3",
      timestamp: 802.1,
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    const filtered = collector.getFiltered("failed", "api/v2");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].url).toBe("https://example.com/api/v2/users");
    expect(filtered[0].failed).toBe(true);
  });

  // --- isMonitoring ---

  it("isMonitoring returns correct status", async () => {
    expect(collector.isMonitoring).toBe(false);

    await collector.start();
    expect(collector.isMonitoring).toBe(true);

    await collector.stop();
    expect(collector.isMonitoring).toBe(false);
  });

  // --- getAll copy test ---

  it("getAll() returns a copy of the buffer (no aliasing)", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com",
      startTimestamp: 900.0,
      status: 200,
      endTimestamp: 900.1,
    });

    const copy1 = collector.getAll();
    const copy2 = collector.getAll();
    expect(copy1).not.toBe(copy2);
    expect(copy1).toEqual(copy2);

    // Mutating the copy should not affect the buffer
    copy1.push({
      url: "injected",
      method: "GET",
      status: 200,
      mimeType: "",
      size: 0,
      duration: 0,
      initiator: "script",
      failed: false,
    });
    expect(collector.count).toBe(1);
  });

  // --- H1: Network.disable failure recovery ---

  it("stop() resets collector even when Network.disable throws (CDP disconnect)", async () => {
    await collector.start();

    fireFullRequest(mock, {
      requestId: "req1",
      url: "https://example.com/ok",
      startTimestamp: 1100.0,
      status: 200,
      endTimestamp: 1100.1,
    });

    // Make Network.disable throw (simulates CDP disconnect)
    mock.sendFn.mockRejectedValueOnce(new Error("WebSocket is not open"));

    const result = await collector.stop();

    // Should still return buffered entries
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].url).toBe("https://example.com/ok");

    // Collector should be fully reset — start() must work again
    expect(collector.isMonitoring).toBe(false);
    expect(collector.count).toBe(0);

    // Verify start() works after the failed stop
    await collector.start();
    expect(collector.isMonitoring).toBe(true);
  });

  // --- H2: Pending limit eviction ---

  it("pending limit evicts oldest pending entries into buffer when exceeded", async () => {
    const limitedCollector = new NetworkCollector(mock.cdpClient, "test-session", {
      maxPending: 3,
    });
    await limitedCollector.start();

    // Create 5 pending requests (no loadingFinished, so they stay pending)
    for (let i = 1; i <= 5; i++) {
      mock.fireEvent("Network.requestWillBeSent", {
        requestId: `pending${i}`,
        request: { url: `https://example.com/long-poll${i}`, method: "GET" },
        timestamp: 1200 + i,
        initiator: { type: "script" },
      });
    }

    // Pending limit is 3, so 2 oldest should have been evicted into the buffer
    const entries = limitedCollector.getAll();
    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe("https://example.com/long-poll1");
    expect(entries[1].url).toBe("https://example.com/long-poll2");
    // Evicted entries have duration 0 (incomplete)
    expect(entries[0].duration).toBe(0);
    expect(entries[1].duration).toBe(0);
  });

  // --- H3: stop() flushes pending requests ---

  it("stop() flushes pending requests into results before clearing", async () => {
    await collector.start();

    // One completed request
    fireFullRequest(mock, {
      requestId: "req-done",
      url: "https://example.com/done",
      startTimestamp: 1300.0,
      status: 200,
      endTimestamp: 1300.1,
    });

    // One pending request (no loadingFinished)
    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req-pending",
      request: { url: "https://example.com/in-flight", method: "POST" },
      timestamp: 1301.0,
      initiator: { type: "script" },
    });

    const result = await collector.stop();

    // Both should be in the result
    expect(result).toHaveLength(2);
    expect(result[0].url).toBe("https://example.com/done");
    expect(result[0].status).toBe(200);

    // The pending request should be flushed as incomplete
    expect(result[1].url).toBe("https://example.com/in-flight");
    expect(result[1].method).toBe("POST");
    expect(result[1].status).toBe(0);        // No response received
    expect(result[1].duration).toBe(0);       // Incomplete
    expect(result[1].failed).toBe(false);     // Not explicitly failed
  });

  // --- Cancelled requests ---

  it("cancelled requests are marked as failed", async () => {
    await collector.start();

    mock.fireEvent("Network.requestWillBeSent", {
      requestId: "req1",
      request: { url: "https://example.com/cancelled", method: "GET" },
      timestamp: 1000.0,
      initiator: { type: "script" },
    });

    mock.fireEvent("Network.loadingFailed", {
      requestId: "req1",
      timestamp: 1000.05,
      errorText: "net::ERR_ABORTED",
      canceled: true,
    });

    const entries = collector.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].failed).toBe(true);
    expect(entries[0].errorText).toBe("net::ERR_ABORTED");
  });
});
