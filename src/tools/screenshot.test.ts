import { describe, it, expect, vi } from "vitest";
import { screenshotSchema, screenshotHandler } from "./screenshot.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import { EMULATED_WIDTH, EMULATED_HEIGHT } from "../cdp/emulation.js";

function mockCdpClient(
  base64Data = "aVZCT1I=",
  contentWidth = 1280,
  contentHeight = 3000,
): CdpClient {
  return {
    send: vi.fn().mockImplementation((method: string) => {
      if (method === "Page.getLayoutMetrics") {
        return Promise.resolve({
          cssContentSize: { width: contentWidth, height: contentHeight },
        });
      }
      if (method === "Page.captureScreenshot") {
        return Promise.resolve({ data: base64Data });
      }
      return Promise.resolve({});
    }),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

// ~75 bytes of base64 → ~56 real bytes (well under 100KB)
const SMALL_BASE64 = "aVZCT1I=";

describe("screenshotSchema", () => {
  // Test 1: Defaults
  it("should default full_page to false", () => {
    const parsed = screenshotSchema.parse({});
    expect(parsed.full_page).toBe(false);
  });
});

describe("screenshotHandler", () => {
  // Test 2: Returns ImageContent
  it("should return ImageContent with type=image and mimeType=image/webp", async () => {
    const cdp = mockCdpClient();
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "image",
        mimeType: "image/webp",
      }),
    );
    expect((result.content[0] as { data: string }).data).toBe(SMALL_BASE64);
  });

  // Test 3: _meta fields
  it("should include correct _meta fields", async () => {
    const cdp = mockCdpClient();
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("screenshot");
    expect(result._meta!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result._meta!.bytes).toBeDefined();
  });

  // Test 4: No layout query for viewport screenshot — single CDP call only
  it("should not query layout metrics for normal viewport screenshots", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const layoutCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.getLayoutMetrics",
    );
    expect(layoutCalls).toHaveLength(0);

    // Also no Runtime.evaluate call
    const runtimeCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Runtime.evaluate",
    );
    expect(runtimeCalls).toHaveLength(0);
  });

  // Test 5: clip with scale for downscaling to MAX_WIDTH
  it("should use clip with scale to downscale to 800px wide", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as { clip: { width: number; height: number; scale: number } };
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.height).toBe(EMULATED_HEIGHT);
    expect(params.clip.scale).toBeCloseTo(800 / EMULATED_WIDTH);
  });

  // Test 6: full_page=true → uses Page.getLayoutMetrics, captureBeyondViewport
  it("should use Page.getLayoutMetrics and captureBeyondViewport for full_page", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 1280, 3000);
    await screenshotHandler({ full_page: true }, cdp, "s1");

    // Verify Page.getLayoutMetrics was called
    const layoutCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.getLayoutMetrics",
    );
    expect(layoutCalls).toHaveLength(1);

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as {
      captureBeyondViewport: boolean;
      clip: { height: number; width: number; scale: number };
    };
    expect(params.captureBeyondViewport).toBe(true);
    expect(params.clip.height).toBe(3000);
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.scale).toBeCloseTo(800 / EMULATED_WIDTH);
  });

  // Test 7: CDP error → isError
  it("should return isError for CDP failure", async () => {
    const cdp = {
      send: vi.fn().mockRejectedValue(new Error("Session closed")),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("screenshot failed"),
      }),
    );
    expect((result.content[0] as { text: string }).text).toContain("Session closed");
  });

  // Test 8: Empty/blank page → valid screenshot (no error)
  it("should return valid screenshot for blank page", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual(
      expect.objectContaining({ type: "image" }),
    );
  });

  // Test 9: Single CDP call — no quality fallback loop (NFR25 optimization)
  it("should make exactly one Page.captureScreenshot call (no quality fallback)", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(1);
  });

  // Test 10: optimizeForSpeed and fixed quality 80 are sent to CDP
  it("should send optimizeForSpeed: true and quality: 80", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as { quality: number; optimizeForSpeed: boolean };
    expect(params.quality).toBe(80);
    expect(params.optimizeForSpeed).toBe(true);
  });

  // Test 11: C1 — Size guard retries with lower quality when >100KB
  it("should retry with quality 50 when screenshot exceeds 100KB", async () => {
    // Create base64 string that decodes to >100KB (~133_334 base64 chars → ~100_000 bytes)
    const largeBase64 = "A".repeat(140_000);
    const smallBase64 = "A".repeat(80_000);
    let callCount = 0;
    const cdp = {
      send: vi.fn().mockImplementation((method: string) => {
        if (method === "Page.captureScreenshot") {
          callCount++;
          // First call returns large, second returns small
          return Promise.resolve({ data: callCount === 1 ? largeBase64 : smallBase64 });
        }
        return Promise.resolve({});
      }),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    } as unknown as CdpClient;

    const result = await screenshotHandler({ full_page: false }, cdp, "s1");

    // Should have made 2 captureScreenshot calls
    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(2);

    // Second call should use quality 50
    const retryParams = screenshotCalls[1][1] as { quality: number };
    expect(retryParams.quality).toBe(50);

    // Result should use the smaller image
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { data: string }).data).toBe(smallBase64);
  });

  // Test 12: C1 — No retry when screenshot is under 100KB
  it("should not retry when screenshot is under 100KB", async () => {
    const cdp = mockCdpClient(SMALL_BASE64);
    await screenshotHandler({ full_page: false }, cdp, "s1");

    const screenshotCalls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(screenshotCalls).toHaveLength(1);
  });

  // Test 13: H3 — Division-by-zero guard: zero width falls back to viewport
  it("should fall back to viewport when cssContentSize width is zero", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, 0, 0);
    const result = await screenshotHandler({ full_page: true }, cdp, "s1");

    expect(result.isError).toBeUndefined();

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    expect(captureCall).toBeDefined();
    const params = captureCall![1] as {
      captureBeyondViewport?: boolean;
      clip: { width: number; height: number; scale: number };
    };
    // Falls back to emulated viewport dimensions
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.height).toBe(EMULATED_HEIGHT);
    expect(params.clip.scale).toBeCloseTo(800 / EMULATED_WIDTH);
    // captureBeyondViewport should NOT be set when falling back
    expect(params.captureBeyondViewport).toBeUndefined();
  });

  // Test 14: H3 — Negative dimensions also fall back to viewport
  it("should fall back to viewport when cssContentSize has negative dimensions", async () => {
    const cdp = mockCdpClient(SMALL_BASE64, -1, -1);
    const result = await screenshotHandler({ full_page: true }, cdp, "s1");

    expect(result.isError).toBeUndefined();

    const captureCall = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "Page.captureScreenshot",
    );
    const params = captureCall![1] as {
      captureBeyondViewport?: boolean;
      clip: { width: number; height: number };
    };
    expect(params.clip.width).toBe(EMULATED_WIDTH);
    expect(params.clip.height).toBe(EMULATED_HEIGHT);
    expect(params.captureBeyondViewport).toBeUndefined();
  });
});
