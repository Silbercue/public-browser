import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionManager } from "./session-manager.js";
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
  fireEvent: (method: string, params: unknown, sessionId?: string) => void;
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

  // S8: like CdpClient._dispatch — the second argument is the session the
  // event arrived on (for Target.attachedToTarget: the parent session).
  const fireEvent = (method: string, params: unknown, sessionId?: string) => {
    const set = listeners.get(method);
    if (set) {
      for (const entry of set) {
        entry.callback(params, sessionId);
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

describe("SessionManager", () => {
  let mock: MockCdpSetup;
  let manager: SessionManager;

  beforeEach(() => {
    mock = createMockCdp();
    manager = new SessionManager(mock.cdpClient, "main-session");
  });

  // --- init tests ---

  it("init calls Target.setAutoAttach with correct params", async () => {
    await manager.init();

    expect(mock.sendFn).toHaveBeenCalledWith(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
      "main-session",
    );
  });

  it("init registers event listeners for attachedToTarget and detachedFromTarget", async () => {
    await manager.init();

    expect(mock.onFn).toHaveBeenCalledWith(
      "Target.attachedToTarget",
      expect.any(Function),
    );
    expect(mock.onFn).toHaveBeenCalledWith(
      "Target.detachedFromTarget",
      expect.any(Function),
    );
  });

  // --- onAttached tests ---

  it("onAttached creates session for iframe target", async () => {
    await manager.init();

    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-session-1",
      targetInfo: {
        targetId: "target-1",
        type: "iframe",
        url: "https://accounts.google.com",
      },
      waitingForDebugger: false,
    }, "main-session");

    // Wait for async domain enables
    await vi.waitFor(() => {
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-session-1");
    });

    expect(mock.sendFn).toHaveBeenCalledWith("DOM.enable", {}, "oopif-session-1");
    expect(mock.sendFn).toHaveBeenCalledWith("Runtime.enable", {}, "oopif-session-1");

    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1].sessionId).toBe("oopif-session-1");
    expect(sessions[1].isMain).toBe(false);
    expect(sessions[1].url).toBe("https://accounts.google.com");
  });

  it("onAttached ignores non-iframe targets", async () => {
    await manager.init();

    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "worker-session",
      targetInfo: {
        targetId: "target-w",
        type: "worker",
        url: "blob:worker",
      },
      waitingForDebugger: false,
    });

    // Give async code a chance to run
    await new Promise((r) => setTimeout(r, 10));

    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(1); // Only main session
    expect(sessions[0].isMain).toBe(true);
  });

  // --- onDetached tests ---

  it("onDetached removes session and associated nodes", async () => {
    await manager.init();

    // Attach an OOPIF
    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-session-1",
      targetInfo: {
        targetId: "target-1",
        type: "iframe",
        url: "https://accounts.google.com",
      },
      waitingForDebugger: false,
    }, "main-session");

    await vi.waitFor(() => {
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-session-1");
    });

    // Register some nodes
    manager.registerNode(1001, "oopif-session-1");
    manager.registerNode(1002, "oopif-session-1");

    expect(manager.getSessionForNode(1001)).toBe("oopif-session-1");

    // Detach
    mock.fireEvent("Target.detachedFromTarget", {
      sessionId: "oopif-session-1",
    });

    // Nodes should fall back to main session
    expect(manager.getSessionForNode(1001)).toBe("main-session");
    expect(manager.getSessionForNode(1002)).toBe("main-session");

    // Session should be gone
    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(1);
  });

  // --- getSessionForNode tests ---

  it("getSessionForNode returns main session for unknown nodes", () => {
    expect(manager.getSessionForNode(9999)).toBe("main-session");
  });

  it("getSessionForNode returns OOPIF session for registered nodes", () => {
    manager.registerNode(42, "oopif-session-1");
    expect(manager.getSessionForNode(42)).toBe("oopif-session-1");
  });

  // --- registerNode tests ---

  it("registerNode maps backendNodeId to sessionId", () => {
    manager.registerNode(100, "session-a");
    manager.registerNode(200, "session-b");

    expect(manager.getSessionForNode(100)).toBe("session-a");
    expect(manager.getSessionForNode(200)).toBe("session-b");
  });

  // --- getAllSessions tests ---

  it("getAllSessions returns main + OOPIF sessions", async () => {
    await manager.init();

    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-1",
      targetInfo: { targetId: "t-1", type: "iframe", url: "https://a.com" },
      waitingForDebugger: false,
    }, "main-session");
    mock.fireEvent("Target.attachedToTarget", {
      sessionId: "oopif-2",
      targetInfo: { targetId: "t-2", type: "iframe", url: "https://b.com" },
      waitingForDebugger: false,
    }, "main-session");

    await vi.waitFor(() => {
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-2");
    });

    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(3);
    expect(sessions[0].isMain).toBe(true);
    expect(sessions[0].sessionId).toBe("main-session");
    expect(sessions[1].sessionId).toBe("oopif-1");
    expect(sessions[2].sessionId).toBe("oopif-2");
  });

  // --- reinit tests ---

  it("reinit clears state and re-initializes", async () => {
    await manager.init();

    // Register some state
    manager.registerNode(42, "oopif-old");

    // Create new mock CDP
    const newMock = createMockCdp();
    await manager.reinit(newMock.cdpClient, "new-main-session");

    // Old state should be cleared
    expect(manager.getSessionForNode(42)).toBe("new-main-session");
    expect(manager.mainSessionId).toBe("new-main-session");

    // New init should have been called
    expect(newMock.sendFn).toHaveBeenCalledWith(
      "Target.setAutoAttach",
      {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      },
      "new-main-session",
    );
  });

  // --- detach tests ---

  it("detach cleans up event listeners", async () => {
    await manager.init();

    // Verify listeners were registered
    const attachedListeners = mock.listeners.get("Target.attachedToTarget");
    const detachedListeners = mock.listeners.get("Target.detachedFromTarget");
    expect(attachedListeners?.size).toBe(1);
    expect(detachedListeners?.size).toBe(1);

    manager.detach();

    // Verify off was called
    expect(mock.offFn).toHaveBeenCalledWith(
      "Target.attachedToTarget",
      expect.any(Function),
    );
    expect(mock.offFn).toHaveBeenCalledWith(
      "Target.detachedFromTarget",
      expect.any(Function),
    );

    // All sessions should be cleared
    const sessions = manager.getAllSessions();
    expect(sessions).toHaveLength(1); // Only main
  });

  // --- S8: nested cross-origin iframes, only frames of this tab ---

  describe("S8: nested OOPIFs", () => {
    const iframe = (sessionId: string, targetId: string, url: string) => ({
      sessionId,
      targetInfo: { targetId, type: "iframe", url },
      waitingForDebugger: false,
    });

    it("init attaches nothing browser-wide (no Target.getTargets / Target.attachToTarget sweep)", async () => {
      await manager.init();

      const methods = mock.sendFn.mock.calls.map((c: unknown[]) => c[0]);
      expect(methods).not.toContain("Target.getTargets");
      expect(methods).not.toContain("Target.attachToTarget");
    });

    it("an attached OOPIF gets its own auto-attach so frames inside it are attached too", async () => {
      await manager.init();

      mock.fireEvent("Target.attachedToTarget", iframe("oopif-1", "t-1", "http://127.0.0.1:8792/mid.html"), "main-session");

      await vi.waitFor(() => {
        expect(mock.sendFn).toHaveBeenCalledWith(
          "Target.setAutoAttach",
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          "oopif-1",
        );
      });
    });

    it("a frame attached via an OOPIF session (2nd level) is registered", async () => {
      await manager.init();

      mock.fireEvent("Target.attachedToTarget", iframe("oopif-1", "t-1", "http://127.0.0.1:8792/mid.html"), "main-session");
      await vi.waitFor(() => {
        expect(mock.sendFn).toHaveBeenCalledWith("Target.setAutoAttach", expect.anything(), "oopif-1");
      });
      mock.fireEvent("Target.attachedToTarget", iframe("oopif-2", "t-2", "http://[::1]:8793/inner.html"), "oopif-1");

      await vi.waitFor(() => {
        expect(mock.sendFn).toHaveBeenCalledWith("Target.setAutoAttach", expect.anything(), "oopif-2");
      });
      expect(mock.sendFn).toHaveBeenCalledWith("Accessibility.enable", {}, "oopif-2");
      const ids = manager.getAllSessions().map((x) => x.sessionId);
      expect(ids).toEqual(["main-session", "oopif-1", "oopif-2"]);
    });

    it("ignores iframes attached via a foreign session (another tab) or at browser level", async () => {
      await manager.init();

      mock.fireEvent("Target.attachedToTarget", iframe("other-tab-frame", "t-9", "https://other.example/"), "other-tab-session");
      mock.fireEvent("Target.attachedToTarget", iframe("browser-level-frame", "t-8", "https://other.example/"));
      await new Promise((r) => setTimeout(r, 10));

      expect(manager.getAllSessions()).toHaveLength(1);
      expect(mock.sendFn).not.toHaveBeenCalledWith("Accessibility.enable", {}, "other-tab-frame");
      expect(mock.sendFn).not.toHaveBeenCalledWith("Accessibility.enable", {}, "browser-level-frame");
    });

    it("a failing nested auto-attach keeps the frame registered", async () => {
      mock.sendFn.mockImplementation(async (...args: unknown[]) => {
        if (args[0] === "Target.setAutoAttach" && args[2] === "oopif-1") throw new Error("Target closed");
        return {};
      });
      await manager.init();

      mock.fireEvent("Target.attachedToTarget", iframe("oopif-1", "t-1", "https://a.com"), "main-session");

      await vi.waitFor(() => {
        expect(mock.sendFn).toHaveBeenCalledWith("Target.setAutoAttach", expect.anything(), "oopif-1");
      });
      expect(manager.getAllSessions().map((x) => x.sessionId)).toContain("oopif-1");
    });
  });
});
