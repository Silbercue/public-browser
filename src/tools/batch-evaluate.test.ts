import { describe, it, expect, vi, beforeEach } from "vitest";
import { batchEvaluateHandler } from "./batch-evaluate.js";
import type { BatchEvaluateParams } from "./batch-evaluate.js";

function createMockCdpClient() {
  return {
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as import("../cdp/cdp-client.js").CdpClient;
}

describe("batchEvaluateHandler", () => {
  let cdpClient: ReturnType<typeof createMockCdpClient>;

  beforeEach(() => {
    cdpClient = createMockCdpClient();
  });

  it("returns empty results for empty URL array", async () => {
    const params: BatchEvaluateParams = {
      urls: [],
      evaluate_per_page: "document.title",
      settle_ms: 2000,
      timeout_per_page_ms: 30000,
      continue_on_error: true,
    };

    const result = await batchEvaluateHandler(params, cdpClient, "sess");
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.succeeded).toBe(0);
    expect(body.failed).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it("processes a single URL successfully", async () => {
    cdpClient.send
      .mockResolvedValueOnce({ frameId: "f1", loaderId: "l1" }) // Page.navigate
      .mockResolvedValueOnce({ result: { type: "string", value: "Hello" } }); // Runtime.evaluate

    // settle() will call Page.lifecycleEvent listener — mock it to resolve quickly
    // Since settle uses cdpClient.on/off for events, we need to trigger them
    cdpClient.on.mockImplementation((event: string, handler: (params: unknown) => void) => {
      if (event === "Page.lifecycleEvent") {
        setTimeout(() => handler({ frameId: "f1", loaderId: "l1", name: "networkIdle", timestamp: 0 }), 10);
      }
    });

    const params: BatchEvaluateParams = {
      urls: ["https://example.com"],
      evaluate_per_page: "document.title",
      settle_ms: 50,
      timeout_per_page_ms: 5000,
      continue_on_error: true,
    };

    const result = await batchEvaluateHandler(params, cdpClient, "sess");
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(body.total).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.results[0].url).toBe("https://example.com");
    expect(body.results[0].result).toBe("Hello");
    expect(body.results[0].error).toBeUndefined();
  });

  it("reports navigation error and continues", async () => {
    // First URL fails navigation
    cdpClient.send
      .mockResolvedValueOnce({ frameId: "f1", errorText: "net::ERR_CONNECTION_REFUSED" })
      // Second URL succeeds
      .mockResolvedValueOnce({ frameId: "f2", loaderId: "l2" })
      .mockResolvedValueOnce({ result: { type: "string", value: "OK" } });

    cdpClient.on.mockImplementation((event: string, handler: (params: unknown) => void) => {
      if (event === "Page.lifecycleEvent") {
        setTimeout(() => handler({ frameId: "f2", loaderId: "l2", name: "networkIdle", timestamp: 0 }), 10);
      }
    });

    const params: BatchEvaluateParams = {
      urls: ["https://bad.example", "https://good.example"],
      evaluate_per_page: "1",
      settle_ms: 50,
      timeout_per_page_ms: 5000,
      continue_on_error: true,
    };

    const result = await batchEvaluateHandler(params, cdpClient, "sess");
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toContain("net::ERR_CONNECTION_REFUSED");
    expect(body.results[1].result).toBe("OK");
  });

  it("aborts on first error when continue_on_error is false", async () => {
    cdpClient.send
      .mockResolvedValueOnce({ frameId: "f1", errorText: "net::ERR_FAILED" });

    const params: BatchEvaluateParams = {
      urls: ["https://bad.example", "https://never-reached.example"],
      evaluate_per_page: "1",
      settle_ms: 50,
      timeout_per_page_ms: 5000,
      continue_on_error: false,
    };

    const result = await batchEvaluateHandler(params, cdpClient, "sess");
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(body.total).toBe(2);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].error).toContain("net::ERR_FAILED");
    expect(body.failed).toBe(1);
    expect(body.succeeded).toBe(0);
  });

  it("reports JS evaluation error", async () => {
    cdpClient.send
      .mockResolvedValueOnce({ frameId: "f1", loaderId: "l1" })
      .mockResolvedValueOnce({
        result: { type: "undefined" },
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "ReferenceError: x is not defined" },
        },
      });

    cdpClient.on.mockImplementation((event: string, handler: (params: unknown) => void) => {
      if (event === "Page.lifecycleEvent") {
        setTimeout(() => handler({ frameId: "f1", loaderId: "l1", name: "networkIdle", timestamp: 0 }), 10);
      }
    });

    const params: BatchEvaluateParams = {
      urls: ["https://example.com"],
      evaluate_per_page: "x",
      settle_ms: 50,
      timeout_per_page_ms: 5000,
      continue_on_error: true,
    };

    const result = await batchEvaluateHandler(params, cdpClient, "sess");
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(body.failed).toBe(1);
    expect(body.results[0].error).toContain("ReferenceError");
  });

  it("times out slow pages", async () => {
    // Navigation that never settles
    cdpClient.send.mockResolvedValueOnce({ frameId: "f1", loaderId: "l1" });
    // settle() will wait for lifecycle events that never come
    cdpClient.on.mockImplementation(() => {}); // never fires events

    const params: BatchEvaluateParams = {
      urls: ["https://slow.example"],
      evaluate_per_page: "1",
      settle_ms: 50,
      timeout_per_page_ms: 200,
      continue_on_error: true,
    };

    const result = await batchEvaluateHandler(params, cdpClient, "sess");
    const body = JSON.parse((result.content[0] as { text: string }).text);

    expect(body.failed).toBe(1);
    expect(body.results[0].error).toContain("Timeout");
  });
});
