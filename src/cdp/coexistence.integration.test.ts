/**
 * CDP coexistence integration tests — Story 9.4.
 *
 * Verifies NFR19: MCP-Server and external CDP clients (Python Script API)
 * can run in parallel without interference. In script mode, MCP tools only
 * see MCP-owned tabs; externally created tabs are invisible.
 *
 * These tests use mock-based approach (no real Chrome needed) to verify
 * the tab-ownership filtering logic in BrowserSession, virtual_desk, and
 * switch_tab. They run as part of the regular `npm test` suite.
 *
 * For real end-to-end coexistence tests (Chrome running on port 9222),
 * see `python/tests/test_coexistence.py` (pytest -m integration).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserSession } from "./browser-session.js";
import { virtualDeskHandler } from "../tools/virtual-desk.js";
import { switchTabHandler, _resetSwitchLock, _resetOriginTab } from "../tools/switch-tab.js";
import type { TabOwnership } from "../tools/switch-tab.js";
import { TabStateCache } from "../cache/tab-state-cache.js";
import type { CdpClient } from "./cdp-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a BrowserSession in script mode with mock internals,
 * tracking a set of MCP-owned tabs.
 */
function buildScriptModeSession(ownedTargetIds: string[]): BrowserSession {
  const session = new BrowserSession({ scriptMode: true });
  for (const id of ownedTargetIds) {
    session.trackOwnedTarget(id);
  }
  return session;
}

/**
 * Create a mock CdpClient that returns configurable responses.
 */
function createMockCdp(sendResponses?: Record<string, unknown>): CdpClient {
  const sendFn = vi.fn(async (method: string) => {
    if (sendResponses && method in sendResponses) {
      const val = sendResponses[method];
      if (typeof val === "function") return val();
      return val;
    }
    // Default: return empty window info for getWindowForTarget
    if (method === "Browser.getWindowForTarget") {
      return {
        windowId: 1,
        bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" },
      };
    }
    return {};
  });

  return {
    send: sendFn,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  } as unknown as CdpClient;
}

/**
 * Create a TabOwnership adapter from a BrowserSession (mirrors the
 * real wiring in tool-registry).
 */
function tabOwnershipFrom(session: BrowserSession): TabOwnership {
  return {
    filter: (id: string) => session.isOwnedTarget(id),
    track: (id: string) => session.trackOwnedTarget(id),
    untrack: (id: string) => session.untrackOwnedTarget(id),
  };
}

// ---------------------------------------------------------------------------
// BrowserSession — script mode tab isolation
// ---------------------------------------------------------------------------

describe("CDP Coexistence — BrowserSession scriptMode isolation", () => {
  it("MCP-owned tabs are visible, external tabs are not", () => {
    const session = buildScriptModeSession(["mcp-tab-1", "mcp-tab-2"]);

    expect(session.isOwnedTarget("mcp-tab-1")).toBe(true);
    expect(session.isOwnedTarget("mcp-tab-2")).toBe(true);
    expect(session.isOwnedTarget("script-tab-external")).toBe(false);
  });

  it("external tab lifecycle does not affect MCP tab ownership", () => {
    const session = buildScriptModeSession(["mcp-tab-1"]);

    // External client creates a tab — BrowserSession never sees it
    const externalTabId = "external-python-tab-42";
    expect(session.isOwnedTarget(externalTabId)).toBe(false);

    // External client closes its tab — no effect on MCP state
    // (the session does not track it, so untrack is a safe no-op)
    session.untrackOwnedTarget(externalTabId);
    expect(session.isOwnedTarget("mcp-tab-1")).toBe(true);
  });

  it("multiple external tabs can coexist without disturbing MCP tabs", () => {
    const session = buildScriptModeSession(["mcp-1"]);

    // Simulate 3 external tabs appearing in Chrome
    const externalIds = ["ext-A", "ext-B", "ext-C"];
    for (const id of externalIds) {
      expect(session.isOwnedTarget(id)).toBe(false);
    }

    // MCP tab is still visible
    expect(session.isOwnedTarget("mcp-1")).toBe(true);
  });

  it("non-script mode treats all tabs as owned (backward compat)", () => {
    const session = new BrowserSession({ scriptMode: false });
    expect(session.isOwnedTarget("any-tab")).toBe(true);
    expect(session.isOwnedTarget("another-tab")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// virtual_desk — script mode tab filtering
// ---------------------------------------------------------------------------

describe("CDP Coexistence — virtual_desk hides external tabs", () => {
  it("virtual_desk shows only MCP-owned tabs, not external script tabs", async () => {
    // Chrome has 3 tabs: 2 MCP-owned, 1 created by external script
    const allTabs = [
      { targetId: "MCP-1", type: "page", url: "https://mcp-page.com", title: "MCP Page 1" },
      { targetId: "SCRIPT-EXT", type: "page", url: "https://script-data.com", title: "Python Script Tab" },
      { targetId: "MCP-2", type: "page", url: "https://mcp-page2.com", title: "MCP Page 2" },
    ];

    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: allTabs },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("MCP-1");

    const session = buildScriptModeSession(["MCP-1", "MCP-2"]);
    const tabFilter = (id: string) => session.isOwnedTarget(id);

    const result = await virtualDeskHandler({}, cdp, undefined, cache, undefined, tabFilter);
    const text = result.content[0].text;

    // MCP tabs visible
    expect(text).toContain("MCP-1");
    expect(text).toContain("MCP-2");
    expect(text).toContain("MCP Page 1");
    expect(text).toContain("MCP Page 2");

    // Script tab hidden
    expect(text).not.toContain("SCRIPT-EXT");
    expect(text).not.toContain("Python Script Tab");
    expect(text).not.toContain("script-data.com");
  });

  it("virtual_desk tab count reflects only MCP-owned tabs", async () => {
    const allTabs = [
      { targetId: "MCP-1", type: "page", url: "https://a.com", title: "A" },
      { targetId: "EXT-1", type: "page", url: "https://ext.com", title: "External" },
      { targetId: "EXT-2", type: "page", url: "https://ext2.com", title: "External 2" },
    ];

    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: allTabs },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const session = buildScriptModeSession(["MCP-1"]);
    const tabFilter = (id: string) => session.isOwnedTarget(id);

    const result = await virtualDeskHandler({}, cdp, undefined, cache, undefined, tabFilter);

    expect(result._meta?.tabCount).toBe(1);
  });

  it("virtual_desk returns 'No open tabs' when only external tabs exist", async () => {
    const allTabs = [
      { targetId: "EXT-ONLY", type: "page", url: "https://ext.com", title: "External Only" },
    ];

    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: allTabs },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });

    const session = buildScriptModeSession([]); // No MCP tabs
    const tabFilter = (id: string) => session.isOwnedTarget(id);

    const result = await virtualDeskHandler({}, cdp, undefined, cache, undefined, tabFilter);

    expect(result.content[0].text).toBe("No open tabs");
  });
});

// ---------------------------------------------------------------------------
// switch_tab — script mode tab filtering
// ---------------------------------------------------------------------------

describe("CDP Coexistence — switch_tab hides external tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSwitchLock();
    _resetOriginTab();
  });

  it("switch_tab list shows only MCP-owned tabs", async () => {
    const allTabs = [
      { targetId: "MCP-TAB", type: "page", url: "https://mcp.com", title: "MCP" },
      { targetId: "SCRIPT-TAB", type: "page", url: "https://script.com", title: "Script" },
    ];

    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: allTabs },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("MCP-TAB");

    const session = buildScriptModeSession(["MCP-TAB"]);
    const ownership = tabOwnershipFrom(session);
    const onSessionChange = vi.fn();

    // No tab param → list mode
    const result = await switchTabHandler(
      { action: "switch" },
      cdp,
      "session-1",
      cache,
      onSessionChange,
      undefined,
      ownership,
    );

    const text = result.content[0].text;
    expect(text).toContain("MCP-TAB");
    expect(text).not.toContain("SCRIPT-TAB");
    expect(text).toContain("Tabs (1 open)");
  });

  it("switch_tab cannot switch to an external script tab", async () => {
    const allTabs = [
      { targetId: "MCP-TAB", type: "page", url: "https://mcp.com", title: "MCP" },
      { targetId: "SCRIPT-TAB", type: "page", url: "https://script.com", title: "Script" },
    ];

    const cdp = createMockCdp({
      "Target.getTargets": { targetInfos: allTabs },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("MCP-TAB");

    const session = buildScriptModeSession(["MCP-TAB"]);
    const ownership = tabOwnershipFrom(session);
    const onSessionChange = vi.fn();

    // Try to switch to the script tab — should fail
    const result = await switchTabHandler(
      { action: "switch", tab: "SCRIPT-TAB" },
      cdp,
      "session-1",
      cache,
      onSessionChange,
      undefined,
      ownership,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Tab not found");
  });
});

// ---------------------------------------------------------------------------
// MCP tab URL stability during external tab lifecycle
// ---------------------------------------------------------------------------

describe("CDP Coexistence — MCP tab URL stability", () => {
  it("MCP tab URL remains unchanged during external tab create/navigate/close cycle", () => {
    // This test simulates the scenario described in AC #2:
    // 1. MCP server has an active tab on URL X
    // 2. External script creates, navigates, and closes a tab
    // 3. MCP tab URL must remain X

    const session = buildScriptModeSession(["mcp-tab-1"]);

    // MCP tab is tracked, external operations don't affect it
    const mcpTabUrl = "https://mcp-dashboard.example.com";

    // Phase 1: Verify MCP tab is visible
    expect(session.isOwnedTarget("mcp-tab-1")).toBe(true);

    // Phase 2: Simulate external tab lifecycle
    const externalTab = "python-script-tab-99";
    // External tab appears — NOT in ownership set
    expect(session.isOwnedTarget(externalTab)).toBe(false);

    // Phase 3: External tab navigates (no effect on session state)
    // (navigation happens via CDP on the external tab's own session)

    // Phase 4: External tab closes (no effect on session state)
    session.untrackOwnedTarget(externalTab); // safe no-op

    // Phase 5: MCP tab is still visible and unchanged
    expect(session.isOwnedTarget("mcp-tab-1")).toBe(true);

    // The URL comparison would happen at the CDP level — the MCP server
    // stores its active tab's URL in tabStateCache. Since the external
    // tab lifecycle never touches the MCP session's cdpClient/sessionId,
    // the URL stays the same. This test verifies the ownership isolation
    // that makes that guarantee possible.
  });

  it("MCP tab URL stability verified via virtual_desk before and after external tab lifecycle", async () => {
    // More detailed test: actually calls virtual_desk before and after
    // to verify the MCP tab info is identical

    const mcpTabs = [
      { targetId: "MCP-MAIN", type: "page", url: "https://dashboard.com/users", title: "Users Dashboard" },
    ];

    const cdpBefore = createMockCdp({
      "Target.getTargets": { targetInfos: mcpTabs },
    });
    const cache = new TabStateCache({ ttlMs: 30_000 });
    cache.setActiveTarget("MCP-MAIN");

    const session = buildScriptModeSession(["MCP-MAIN"]);
    const tabFilter = (id: string) => session.isOwnedTarget(id);

    // Before external tab
    const resultBefore = await virtualDeskHandler({}, cdpBefore, undefined, cache, undefined, tabFilter);
    const textBefore = resultBefore.content[0].text;

    // Simulate external tab appearing and disappearing
    // (In reality this happens via CDP Target.createTarget from Python)
    const allTabsDuring = [
      ...mcpTabs,
      { targetId: "EXT-TEMP", type: "page", url: "https://scrape-target.com", title: "Scraping..." },
    ];

    const cdpDuring = createMockCdp({
      "Target.getTargets": { targetInfos: allTabsDuring },
    });

    const resultDuring = await virtualDeskHandler({}, cdpDuring, undefined, cache, undefined, tabFilter);
    const textDuring = resultDuring.content[0].text;

    // During: external tab is NOT visible
    expect(textDuring).not.toContain("EXT-TEMP");
    expect(textDuring).not.toContain("scrape-target.com");

    // After external tab is closed — back to original tabs
    const cdpAfter = createMockCdp({
      "Target.getTargets": { targetInfos: mcpTabs },
    });

    const resultAfter = await virtualDeskHandler({}, cdpAfter, undefined, cache, undefined, tabFilter);
    const textAfter = resultAfter.content[0].text;

    // Before and after should be identical (MCP tab unchanged)
    expect(textBefore).toBe(textAfter);
  });
});

// ---------------------------------------------------------------------------
// Context manager cleanup simulation
// ---------------------------------------------------------------------------

describe("CDP Coexistence — tab cleanup on script exit", () => {
  it("untracking a tab makes it invisible to MCP immediately", () => {
    const session = buildScriptModeSession(["mcp-1", "mcp-2"]);

    // Suppose mcp-2 was actually an MCP tab that gets closed
    session.untrackOwnedTarget("mcp-2");
    expect(session.isOwnedTarget("mcp-1")).toBe(true);
    expect(session.isOwnedTarget("mcp-2")).toBe(false);
  });

  it("external tab never enters the ownership set, so no cleanup needed from MCP side", () => {
    const session = buildScriptModeSession(["mcp-1"]);

    // External tab created by Python script — never tracked
    const extTabId = "python-ctx-mgr-tab";
    expect(session.isOwnedTarget(extTabId)).toBe(false);

    // Python script closes the tab via Target.closeTarget — the MCP
    // session state is unaffected. The tab simply disappears from
    // Chrome's Target.getTargets list.
    // No MCP-side cleanup action needed.
    expect(session.isOwnedTarget("mcp-1")).toBe(true);
  });
});
