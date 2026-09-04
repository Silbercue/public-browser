/**
 * Story 12.4: Server tests — buildInstructions and cortex pattern count
 * in MCP server instructions.
 *
 * Covers:
 *  - buildInstructions() with patternCount > 0 includes cortex line (AC #1)
 *  - buildInstructions() with patternCount === 0 omits cortex line (AC #2)
 *  - Existing instructions text is preserved unchanged (AC #1, #2)
 *  - Integration: server start with patterns → instructions contain cortex line
 *  - Integration: server start without patterns → instructions omit cortex line
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildInstructions } from "./server.js";

describe("buildInstructions (Story 12.4)", () => {
  // =========================================================================
  // AC #1: patternCount > 0 → cortex line present
  // =========================================================================

  it("includes cortex line when patternCount > 0 (AC #1)", () => {
    const result = buildInstructions(15);
    expect(result).toContain("Cortex: 15 patterns loaded.");
  });

  it("includes correct count for various values", () => {
    expect(buildInstructions(1)).toContain("Cortex: 1 patterns loaded.");
    expect(buildInstructions(100)).toContain("Cortex: 100 patterns loaded.");
    expect(buildInstructions(9999)).toContain("Cortex: 9999 patterns loaded.");
  });

  it("cortex line is at the end of the instructions string", () => {
    const result = buildInstructions(15);
    expect(result.endsWith("Cortex: 15 patterns loaded.")).toBe(true);
  });

  // =========================================================================
  // AC #2: patternCount === 0 → no cortex line
  // =========================================================================

  it("omits cortex line when patternCount === 0 (AC #2)", () => {
    const result = buildInstructions(0);
    expect(result).not.toContain("Cortex:");
    expect(result).not.toContain("patterns loaded");
  });

  // =========================================================================
  // Existing instructions content preserved
  // =========================================================================

  it("preserves workflow instruction", () => {
    const withPatterns = buildInstructions(10);
    const withoutPatterns = buildInstructions(0);

    for (const result of [withPatterns, withoutPatterns]) {
      expect(result).toContain("Public Browser controls a real Chrome browser via CDP.");
      expect(result).toContain("Workflow: virtual_desk");
    }
  });

  it("preserves CRITICAL view_page vs capture_image section", () => {
    const result = buildInstructions(0);
    expect(result).toContain("CRITICAL — view_page vs capture_image:");
    expect(result).toContain("ALWAYS call view_page");
    expect(result).toContain("capture_image is ONLY for CSS layout checks");
    expect(result).toContain(
      "Do NOT call capture_image to read text, find buttons, check errors, or see page state — that is view_page.",
    );
  });

  it("preserves Other rules section", () => {
    const result = buildInstructions(0);
    expect(result).toContain("Other rules:");
    expect(result).toContain("fill_form beats multiple type calls");
    expect(result).toContain("run_plan to execute N steps");
    expect(result).toContain("evaluate is for JS computation");
    expect(result).toContain("Element targets: prefer the ref from the last view_page (e.g. 'e5')");
    expect(result).toContain("Refs go stale after navigate, reload or switch_tab");
    expect(result).toContain("not for CSS reading, element discovery, scrolling, dialogs or network capture");
    expect(result).toContain("Avoid evaluate as default recovery after click/type errors");
    expect(result).toContain("bypasses the CDP pointer chain and framework listeners");
    expect(result).toContain("carry a DOM diff (NEW/REMOVED/CHANGED lines)");
  });

  it("bleibt kompakt: unter 2500 Zeichen ohne Cortex-Zeile", () => {
    expect(buildInstructions(0).length).toBeLessThan(2500);
  });

  it("preserves Script API section", () => {
    const result = buildInstructions(0);
    expect(result).toContain("Script API:");
    expect(result).toContain("pip install publicbrowser");
  });

  it("base instructions are identical with and without cortex line", () => {
    const withPatterns = buildInstructions(5);
    const withoutPatterns = buildInstructions(0);

    // Remove the cortex line from withPatterns — the rest should be identical
    const withoutCortexLine = withPatterns.replace("\nCortex: 5 patterns loaded.", "");
    expect(withoutCortexLine).toBe(withoutPatterns);
  });
});

// ===========================================================================
// Integration: startServer() passes cortex pattern count into McpServer
// ===========================================================================

describe("startServer integration (Story 12.4 — C1)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /**
   * Helper: set up all vi.doMock calls for startServer dependencies.
   * Returns a ref object whose `instructions` field is written by the
   * McpServer mock constructor, so the test can inspect it after await.
   */
  function mockServerDeps(patternCount: number): { instructions?: string } {
    const captured: { instructions?: string } = {};

    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: vi.fn(function McpServerMock(_info: unknown, opts: { instructions?: string }) {
        captured.instructions = opts?.instructions;
        return {
          connect: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }));

    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: vi.fn(function StdioServerTransportMock() {
        return {};
      }),
    }));

    vi.doMock("./cdp/browser-session.js", () => ({
      BrowserSession: vi.fn(function BrowserSessionMock() {
        return {
          ensureReady: vi.fn().mockResolvedValue(undefined),
          shutdown: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }));

    vi.doMock("./cdp/chrome-launcher.js", () => ({
      resolveAutoLaunch: vi.fn().mockReturnValue(false),
    }));

    vi.doMock("./registry.js", () => ({
      ToolRegistry: vi.fn(function ToolRegistryMock() {
        return {
          registerAll: vi.fn(),
        };
      }),
    }));

    vi.doMock("./transport/script-api-server.js", () => ({
      ScriptApiServer: vi.fn(),
    }));

    vi.doMock("./cortex/hint-matcher.js", () => ({
      hintMatcher: {
        refreshAsync: vi.fn().mockResolvedValue(undefined),
        patternCount,
      },
    }));

    return captured;
  }

  it("instructions contain cortex line when patterns exist", async () => {
    const captured = mockServerDeps(7);

    const { startServer } = await import("./server.js");
    await startServer();

    expect(captured.instructions).toBeDefined();
    expect(captured.instructions).toContain("Cortex: 7 patterns loaded.");
  });

  it("instructions omit cortex line when no patterns exist", async () => {
    const captured = mockServerDeps(0);

    const { startServer } = await import("./server.js");
    await startServer();

    expect(captured.instructions).toBeDefined();
    expect(captured.instructions).not.toContain("Cortex:");
    expect(captured.instructions).not.toContain("patterns loaded");
  });
});
