/**
 * Tests fuer Top-Level CLI Subcommands (Free Tier).
 * Phase 2 (Distribution-Setup) — Story analog SilbercueSwift main.swift.
 *
 * Strategie: process.exit + console.log werden gemockt, sodass jeder
 * Subcommand vollstaendig durchlaufen kann ohne den Test-Runner zu killen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  dispatchTopLevelCli,
  readPackageVersion,
  FREE_TIER_TOOL_COUNT,
} from "./top-level-commands.js";
import { ALL_FREE_TOOL_NAMES } from "../registry.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Story 11.2 (M2): FREE_TIER_TOOL_COUNT muss mit der realen Tool-Liste
// in registry.ts uebereinstimmen. Faengt Drift ab wenn Tools hinzugefuegt
// oder entfernt werden ohne die Konstante nachzuziehen.
describe("FREE_TIER_TOOL_COUNT consistency", () => {
  it("matches the number of tools in ALL_FREE_TOOL_NAMES", () => {
    expect(FREE_TIER_TOOL_COUNT).toBe(ALL_FREE_TOOL_NAMES.length);
  });

  it("ALL_FREE_TOOL_NAMES has no duplicates", () => {
    const unique = new Set(ALL_FREE_TOOL_NAMES);
    expect(unique.size).toBe(ALL_FREE_TOOL_NAMES.length);
  });
});

describe("readPackageVersion", () => {
  it("findet die package.json relativ zur src-Datei", () => {
    const result = readPackageVersion(import.meta.url);
    expect(result.name).toBe("public-browser");
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("liefert sinnvollen Fallback bei einer kaputten URL", () => {
    const result = readPackageVersion("file:///nonexistent/path/that/cannot/exist/foo.js");
    // Im worst case liefert er den Fallback OR irgendeine package.json
    // weiter oben — aber `name` und `version` sind immer Strings.
    expect(typeof result.name).toBe("string");
    expect(typeof result.version).toBe("string");
  });
});

describe("dispatchTopLevelCli", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // Throw a sentinel error so the dispatcher control-flow stops here
      throw new Error("__exit__");
    }) as never);
  });

  // ---- no command → fall-through ----
  describe("no subcommand", () => {
    it("returns false when no argv[2] is given (server should start)", async () => {
      const handled = await dispatchTopLevelCli(["node", "index.js"], import.meta.url);
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("returns false for unknown subcommand (server should start)", async () => {
      const handled = await dispatchTopLevelCli(
        ["node", "index.js", "totally-unknown"],
        import.meta.url,
      );
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });

  });

  // ---- version ----
  describe("version", () => {
    it("prints package name + version and exits 0", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "version"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("public-browser");
      expect(out).toMatch(/\d+\.\d+\.\d+/);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("works with --version flag", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "--version"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("works with -v shortcut", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "-v"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ---- status ----
  describe("status", () => {
    it("shows tool count and exits 0", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "status"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain(`${FREE_TIER_TOOL_COUNT}`);
      expect(out).toContain("available");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // ---- help ----
  describe("help", () => {
    it("prints help text and exits 0 (help)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "help"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("Public Browser MCP Server");
      expect(out).toContain("Usage:");
      expect(out).toContain("version");
      expect(out).toContain("status");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("prints help text and exits 0 (--help)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "--help"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("prints help text and exits 0 (-h)", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "-h"], import.meta.url),
      ).rejects.toThrow("__exit__");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("help text includes --attach flag documentation", async () => {
      await expect(
        dispatchTopLevelCli(["node", "index.js", "help"], import.meta.url),
      ).rejects.toThrow("__exit__");
      const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(out).toContain("--attach");
      expect(out).toContain("attach-only mode");
    });
  });

  // ---- --attach flag (Story 22.3) ----
  describe("--attach flag pass-through", () => {
    it("--attach is NOT treated as a subcommand (server should start)", async () => {
      const handled = await dispatchTopLevelCli(
        ["node", "index.js", "--attach"],
        import.meta.url,
      );
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("--attach with other args is NOT treated as a subcommand", async () => {
      const handled = await dispatchTopLevelCli(
        ["node", "index.js", "--attach", "--some-other-flag"],
        import.meta.url,
      );
      expect(handled).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
