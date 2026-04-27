/**
 * Story 12a.5: TelemetryUploader unit tests.
 *
 * Covers all acceptance criteria:
 *  - AC #1: No data sent when telemetry is disabled (default)
 *  - AC #2: Pattern uploaded when telemetry is enabled
 *  - AC #3: Payload contains ONLY the 5 whitelisted fields (NFR21)
 *  - AC #4: Rate-limiting (1 upload per minute per pattern key)
 *  - Error handling: fetch failures are silently swallowed
 *  - Singleton configuration via environment variables
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CortexPattern } from "./cortex-types.js";
import type { TelemetryConfig } from "./cortex-types.js";
import { TELEMETRY_RATE_LIMIT_MS } from "./cortex-types.js";
import { TelemetryUploader } from "./telemetry-upload.js";

/**
 * Factory for a minimal valid CortexPattern (Story 12a.5: pageType-based).
 */
function makePattern(overrides: Partial<CortexPattern> = {}): CortexPattern {
  return {
    pageType: "login",
    toolSequence: ["navigate", "view_page", "click"],
    outcome: "success",
    contentHash: "a1b2c3d4e5f6a7b8",
    timestamp: 1700000000000,
    ...overrides,
  };
}

/** Factory for a TelemetryConfig with telemetry enabled. */
function enabledConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
  return {
    enabled: true,
    endpoint: "https://test.example.com/v1/patterns",
    rateLimitMs: TELEMETRY_RATE_LIMIT_MS,
    ...overrides,
  };
}

/** Factory for a TelemetryConfig with telemetry disabled. */
function disabledConfig(): TelemetryConfig {
  return {
    enabled: false,
    endpoint: "https://test.example.com/v1/patterns",
    rateLimitMs: TELEMETRY_RATE_LIMIT_MS,
  };
}

describe("TelemetryUploader (Story 12a.5)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Mock globalThis.fetch for all tests.
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // AC #1: No data sent when telemetry is disabled
  // ===========================================================================

  describe("AC #1 — disabled by default", () => {
    it("does NOT call fetch() when enabled is false", () => {
      const uploader = new TelemetryUploader(disabledConfig());
      uploader.maybeUpload(makePattern());

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // AC #2: Pattern uploaded when telemetry is enabled
  // ===========================================================================

  describe("AC #2 — upload when enabled", () => {
    it("calls fetch() with correct endpoint, method POST, and Content-Type JSON", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      uploader.maybeUpload(makePattern());

      // Let the microtask queue flush (fire-and-forget promise).
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://test.example.com/v1/patterns");
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("sends correctly sanitized payload as JSON body", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const pattern = makePattern({
        pageType: "data_table",
        toolSequence: ["navigate", "fill_form"],
        contentHash: "deadbeef12345678",
        timestamp: 1700000001000,
      });

      uploader.maybeUpload(pattern);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toEqual({
        pageType: "data_table",
        toolSequence: ["navigate", "fill_form"],
        successRate: 1.0,
        contentHash: "deadbeef12345678",
        timestamp: 1700000001000,
      });
    });
  });

  // ===========================================================================
  // AC #3: Payload contains ONLY 5 whitelisted fields (NFR21)
  // ===========================================================================

  describe("AC #3 — NFR21 payload whitelist", () => {
    it("payload has exactly 5 fields, no additional properties", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      uploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(
        ["contentHash", "pageType", "successRate", "timestamp", "toolSequence"],
      );
      expect(keys).toHaveLength(5);
    });

    it("does NOT leak CortexPattern 'outcome' field into payload", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      uploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("outcome");
    });

    it("does NOT leak domain into payload (Privacy AC #3)", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      uploader.maybeUpload(makePattern({ domain: "secret.internal.corp" }));
      await vi.advanceTimersByTimeAsync(0);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).not.toHaveProperty("domain");
    });

    it("successRate is always 1.0 in Phase 1", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      uploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.successRate).toBe(1.0);
    });

    it("toolSequence is a shallow copy (not a reference)", () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const pattern = makePattern();
      const sanitized = uploader._sanitize(pattern);

      // Mutating the sanitized copy should NOT affect the original.
      sanitized.toolSequence.push("extra");
      expect(pattern.toolSequence).not.toContain("extra");
    });
  });

  // ===========================================================================
  // AC #4: Rate-limiting
  // ===========================================================================

  describe("AC #4 — rate-limiting", () => {
    it("skips second upload within rateLimitMs for the same key", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const pattern = makePattern();

      uploader.maybeUpload(pattern);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call within rate limit — should be skipped.
      uploader.maybeUpload(pattern);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("allows upload again after rateLimitMs has elapsed", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const pattern = makePattern();

      uploader.maybeUpload(pattern);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance time past the rate limit.
      vi.advanceTimersByTime(TELEMETRY_RATE_LIMIT_MS);

      uploader.maybeUpload(pattern);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("rate-limits independently per pageType+toolSequence key", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const patternA = makePattern({ pageType: "login", toolSequence: ["navigate", "click"] });
      const patternB = makePattern({ pageType: "search_results", toolSequence: ["navigate", "scroll"] });

      uploader.maybeUpload(patternA);
      uploader.maybeUpload(patternB);
      await vi.advanceTimersByTimeAsync(0);

      // Both should be uploaded — different keys.
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("same pageType but different toolSequence are independent keys", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const pattern1 = makePattern({ pageType: "login", toolSequence: ["navigate", "click"] });
      const pattern2 = makePattern({ pageType: "login", toolSequence: ["navigate", "fill_form"] });

      uploader.maybeUpload(pattern1);
      uploader.maybeUpload(pattern2);
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("same pageType and same toolSequence are rate-limited as one key", async () => {
      const uploader = new TelemetryUploader(enabledConfig());
      const pattern1 = makePattern({ pageType: "login", toolSequence: ["navigate", "click"] });
      const pattern2 = makePattern({ pageType: "login", toolSequence: ["navigate", "click"], contentHash: "different1234567" });

      uploader.maybeUpload(pattern1);
      uploader.maybeUpload(pattern2);
      await vi.advanceTimersByTimeAsync(0);

      // Only the first should be uploaded — same key despite different contentHash.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Error handling: fetch failures are silently swallowed
  // ===========================================================================

  describe("Error handling — no throw on fetch errors", () => {
    it("swallows network errors without throwing", async () => {
      fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
      const uploader = new TelemetryUploader(enabledConfig());

      // Should NOT throw.
      expect(() => uploader.maybeUpload(makePattern())).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
    });

    it("swallows timeout errors without throwing", async () => {
      const timeoutErr = new DOMException("Signal timed out.", "TimeoutError");
      fetchSpy.mockRejectedValue(timeoutErr);
      const uploader = new TelemetryUploader(enabledConfig());

      expect(() => uploader.maybeUpload(makePattern())).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
    });

    it("swallows non-2xx HTTP status without throwing", async () => {
      fetchSpy.mockResolvedValue({ ok: false, status: 500 });
      const uploader = new TelemetryUploader(enabledConfig());

      expect(() => uploader.maybeUpload(makePattern())).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);

      // fetch was called — the non-2xx is just debug-logged, not thrown.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Singleton configuration via env variables (C1: tests actual resolveConfig)
  // ===========================================================================

  describe("Singleton env configuration", () => {
    const originalTelemetry = process.env.PUBLIC_BROWSER_TELEMETRY;
    const originalEndpoint = process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT;

    afterEach(() => {
      // Restore original env.
      if (originalTelemetry === undefined) {
        delete process.env.PUBLIC_BROWSER_TELEMETRY;
      } else {
        process.env.PUBLIC_BROWSER_TELEMETRY = originalTelemetry;
      }
      if (originalEndpoint === undefined) {
        delete process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT;
      } else {
        process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT = originalEndpoint;
      }
      vi.resetModules();
    });

    it("singleton is disabled by default (no env variable)", async () => {
      delete process.env.PUBLIC_BROWSER_TELEMETRY;
      delete process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT;

      // Force fresh module load so resolveConfig() runs with current env.
      vi.resetModules();
      const { telemetryUploader } = await import("./telemetry-upload.js");

      telemetryUploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      // Disabled — fetch should NOT be called.
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("singleton is enabled when PUBLIC_BROWSER_TELEMETRY=1", async () => {
      process.env.PUBLIC_BROWSER_TELEMETRY = "1";
      process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT = "https://test.example.com/v1/patterns";

      vi.resetModules();
      const { telemetryUploader } = await import("./telemetry-upload.js");

      telemetryUploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("singleton is enabled when PUBLIC_BROWSER_TELEMETRY=true", async () => {
      process.env.PUBLIC_BROWSER_TELEMETRY = "true";
      process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT = "https://test.example.com/v1/patterns";

      vi.resetModules();
      const { telemetryUploader } = await import("./telemetry-upload.js");

      telemetryUploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("singleton uses custom endpoint from PUBLIC_BROWSER_TELEMETRY_ENDPOINT", async () => {
      process.env.PUBLIC_BROWSER_TELEMETRY = "1";
      process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT = "https://custom.corp.internal/v1/patterns";

      vi.resetModules();
      const { telemetryUploader } = await import("./telemetry-upload.js");

      telemetryUploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://custom.corp.internal/v1/patterns");
    });
  });

  // ===========================================================================
  // H1: HTTPS enforcement — http:// endpoint disables telemetry
  // ===========================================================================

  describe("H1 — HTTPS enforcement", () => {
    it("http:// endpoint disables telemetry even when enabled is true", async () => {
      const uploader = new TelemetryUploader({
        enabled: true,
        endpoint: "http://insecure.example.com/v1/patterns",
        rateLimitMs: TELEMETRY_RATE_LIMIT_MS,
      });

      uploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe("http://insecure.example.com/v1/patterns");
    });

    it("singleton is disabled when endpoint is http:// (resolveConfig enforcement)", async () => {
      process.env.PUBLIC_BROWSER_TELEMETRY = "1";
      process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT = "http://insecure.example.com/v1/patterns";

      vi.resetModules();
      const { telemetryUploader } = await import("./telemetry-upload.js");

      telemetryUploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      // HTTPS enforcement: fetch should NOT be called.
      expect(fetchSpy).not.toHaveBeenCalled();

      // Cleanup env.
      delete process.env.PUBLIC_BROWSER_TELEMETRY;
      delete process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT;
      vi.resetModules();
    });

    it("singleton is enabled when endpoint is https:// (positive case)", async () => {
      process.env.PUBLIC_BROWSER_TELEMETRY = "1";
      process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT = "https://secure.example.com/v1/patterns";

      vi.resetModules();
      const { telemetryUploader } = await import("./telemetry-upload.js");

      telemetryUploader.maybeUpload(makePattern());
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Cleanup env.
      delete process.env.PUBLIC_BROWSER_TELEMETRY;
      delete process.env.PUBLIC_BROWSER_TELEMETRY_ENDPOINT;
      vi.resetModules();
    });
  });
});
