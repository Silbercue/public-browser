import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerProHooks, getProHooks } from "./pro-hooks.js";
import type {
  ProHooks,
  ToolRegistryPublic,
  A11yTreePublic,
  A11yTreeDiffs,
} from "./pro-hooks.js";
import type { ToolResponse } from "../types.js";
import type { PlanStep } from "../plan/plan-executor.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SnapshotMap, DOMChange } from "../cache/a11y-tree.js";

describe("ProHooks", () => {
  // Reset between tests — clean state
  beforeEach(() => {
    registerProHooks({});
  });

  it("default hooks are an empty object (all properties undefined)", () => {
    const hooks = getProHooks();
    expect(hooks).toEqual({});
    expect(hooks.enhanceTool).toBeUndefined();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("registerProHooks sets new hooks", () => {
    const enhance = (_name: string, params: Record<string, unknown>) => params;
    registerProHooks({ enhanceTool: enhance });

    const hooks = getProHooks();
    expect(hooks.enhanceTool).toBe(enhance);
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("getProHooks returns the registered hooks", () => {
    const myHooks: ProHooks = {
      enhanceTool: (_name, params) => params,
      onToolResult: async (_name, result, _ctx) => result,
    };
    registerProHooks(myHooks);

    const hooks = getProHooks();
    expect(hooks.enhanceTool).toBe(myHooks.enhanceTool);
    expect(hooks.onToolResult).toBe(myHooks.onToolResult);
  });

  it("multiple registerProHooks calls — last one wins", () => {
    const first = (_n: string, p: Record<string, unknown>) => p;
    const second = (_n: string, _p: Record<string, unknown>) => null;

    registerProHooks({ enhanceTool: first });
    expect(getProHooks().enhanceTool).toBe(first);

    registerProHooks({ enhanceTool: second });
    expect(getProHooks().enhanceTool).toBe(second);
  });

  it("registerProHooks with empty object resets hooks", () => {
    registerProHooks({ enhanceTool: (_n, p) => p });
    expect(getProHooks().enhanceTool).toBeDefined();

    registerProHooks({});
    expect(getProHooks().enhanceTool).toBeUndefined();
  });

  it("enhanceTool hook can modify params", () => {
    registerProHooks({
      enhanceTool: (_name, params) => ({ ...params, enhanced: true }),
    });

    const result = getProHooks().enhanceTool!("evaluate", { expression: "1+1" });
    expect(result).toEqual({ expression: "1+1", enhanced: true });
  });

  it("enhanceTool hook can return null for no change", () => {
    registerProHooks({
      enhanceTool: () => null,
    });

    const result = getProHooks().enhanceTool!("evaluate", { expression: "1+1" });
    expect(result).toBeNull();
  });

  // --- Story 15.3: onToolResult Hook (Async + Context-Parameter) ---

  /**
   * Shared mock factory for the a11yTree/A11yTreeDiffs/context objects used
   * by the onToolResult tests. Keeps the setup DRY and lets each test
   * override only the fields it cares about.
   */
  const makeMockA11yTree = (): A11yTreePublic => ({
    classifyRef: vi.fn().mockReturnValue("static"),
    getSnapshotMap: vi.fn().mockReturnValue(new Map() as SnapshotMap),
    getCompactSnapshot: vi.fn().mockReturnValue(null),
    refreshPrecomputed: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    currentUrl: "https://example.com",
    // Story 15.3 (AC #5): diff methods live on the A11yTreePublic facade too
    diffSnapshots: vi.fn().mockReturnValue([] as DOMChange[]),
    formatDomDiff: vi.fn().mockReturnValue(null),
  });

  const makeMockA11yTreeDiffs = (): A11yTreeDiffs => ({
    diffSnapshots: vi.fn().mockReturnValue([] as DOMChange[]),
    formatDomDiff: vi.fn().mockReturnValue(null),
  });

  const makeHookContext = (
    overrides: Partial<Parameters<NonNullable<ProHooks["onToolResult"]>>[2]> = {},
  ): Parameters<NonNullable<ProHooks["onToolResult"]>>[2] => ({
    a11yTree: makeMockA11yTree(),
    a11yTreeDiffs: makeMockA11yTreeDiffs(),
    waitForAXChange: vi.fn().mockResolvedValue(true),
    cdpClient: { send: vi.fn() } as unknown as CdpClient,
    sessionId: "session-1",
    sessionManager: undefined,
    ...overrides,
  });

  it("onToolResult hook can modify response (new async signature with context)", async () => {
    registerProHooks({
      onToolResult: async (_name, result, _ctx) => ({
        ...result,
        content: [...result.content, { type: "text" as const, text: "enhanced" }],
      }),
    });

    const original: ToolResponse = {
      content: [{ type: "text" as const, text: "original" }],
      _meta: { elapsedMs: 10, method: "evaluate" },
    };
    const ctx = makeHookContext();
    const modified = await getProHooks().onToolResult!("evaluate", original, ctx);
    expect(modified.content).toHaveLength(2);
    expect((modified.content[1] as { text: string }).text).toBe("enhanced");
  });

  it("onToolResult is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.onToolResult).toBeUndefined();
  });

  it("onToolResult can be registered and retrieved", async () => {
    const mockFn = vi.fn().mockImplementation(
      async (_name, result, _ctx) => result,
    );
    registerProHooks({ onToolResult: mockFn });

    const hooks = getProHooks();
    expect(hooks.onToolResult).toBe(mockFn);
  });

  it("onToolResult works alongside other hooks", () => {
    const enhance = (_n: string, p: Record<string, unknown>) => p;
    const result: ProHooks["onToolResult"] = async (_name, r, _ctx) => r;

    registerProHooks({
      enhanceTool: enhance,
      onToolResult: result,
    });

    const hooks = getProHooks();
    expect(hooks.enhanceTool).toBe(enhance);
    expect(hooks.onToolResult).toBe(result);
  });

  it("onToolResult is cleared when hooks are reset", () => {
    registerProHooks({
      onToolResult: async (_name, result, _ctx) => result,
    });
    expect(getProHooks().onToolResult).toBeDefined();

    registerProHooks({});
    expect(getProHooks().onToolResult).toBeUndefined();
  });

  it("onToolResult receives context parameter with a11yTree", async () => {
    const mockA11yTree = makeMockA11yTree();
    (mockA11yTree.classifyRef as ReturnType<typeof vi.fn>).mockReturnValue(
      "clickable",
    );

    const captured: { classification?: string } = {};
    registerProHooks({
      onToolResult: async (_name, result, ctx) => {
        captured.classification = ctx.a11yTree.classifyRef("e1");
        return result;
      },
    });

    const result: ToolResponse = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: { elapsedMs: 1, method: "click" },
    };
    const ctx = makeHookContext({ a11yTree: mockA11yTree });
    await getProHooks().onToolResult!("click", result, ctx);

    expect(mockA11yTree.classifyRef).toHaveBeenCalledWith("e1");
    expect(captured.classification).toBe("clickable");
  });

  it("onToolResult can call waitForAXChange via context parameter", async () => {
    const waitMock = vi.fn().mockResolvedValue(true);
    registerProHooks({
      onToolResult: async (_name, result, ctx) => {
        await ctx.waitForAXChange?.(350);
        return result;
      },
    });

    const result: ToolResponse = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: { elapsedMs: 1, method: "click" },
    };
    const ctx = makeHookContext({ waitForAXChange: waitMock });
    await getProHooks().onToolResult!("click", result, ctx);

    expect(waitMock).toHaveBeenCalledWith(350);
  });

  it("onToolResult can return enhanced response asynchronously", async () => {
    registerProHooks({
      onToolResult: async (_name, result, _ctx) => {
        // Simulate an async CDP call before enriching
        await Promise.resolve();
        return {
          ...result,
          content: [
            ...result.content,
            { type: "text" as const, text: "[diff] +button#submit" },
          ],
        };
      },
    });

    const result: ToolResponse = {
      content: [{ type: "text" as const, text: "clicked" }],
      _meta: { elapsedMs: 5, method: "click" },
    };
    const ctx = makeHookContext();
    const enriched = await getProHooks().onToolResult!("click", result, ctx);

    expect(enriched.content).toHaveLength(2);
    expect((enriched.content[1] as { text: string }).text).toBe(
      "[diff] +button#submit",
    );
  });

  // --- Story 15.4: executeParallel Hook ---

  it("executeParallel is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.executeParallel).toBeUndefined();
  });

  it("executeParallel can be registered and retrieved", async () => {
    const mockResponse: ToolResponse = {
      content: [{ type: "text", text: "parallel done" }],
      _meta: { elapsedMs: 10, method: "run_plan", parallel: true },
    };
    const impl = vi.fn().mockResolvedValue(mockResponse);

    registerProHooks({ executeParallel: impl });

    const hooks = getProHooks();
    expect(hooks.executeParallel).toBe(impl);

    const groups: Array<{ tab: string; steps: PlanStep[] }> = [
      { tab: "tab-a", steps: [{ tool: "navigate", params: { url: "https://a.com" } }] },
    ];
    const factory = async (_tabId: string) => ({
      executeTool: async (_name: string, _params: Record<string, unknown>): Promise<ToolResponse> => ({
        content: [{ type: "text", text: "ok" }],
        _meta: { elapsedMs: 1, method: "navigate" },
      }),
    });

    const result = await hooks.executeParallel!(groups, factory, {
      errorStrategy: "abort",
      concurrencyLimit: 5,
    });

    expect(impl).toHaveBeenCalledWith(groups, factory, {
      errorStrategy: "abort",
      concurrencyLimit: 5,
    });
    expect(result).toBe(mockResponse);
  });

  it("executeParallel works alongside other hooks", () => {
    const enhance = (_n: string, p: Record<string, unknown>) => p;
    const impl = async (): Promise<ToolResponse> => ({
      content: [],
      _meta: { elapsedMs: 0, method: "run_plan" },
    });

    registerProHooks({ enhanceTool: enhance, executeParallel: impl });

    const hooks = getProHooks();
    expect(hooks.enhanceTool).toBe(enhance);
    expect(hooks.executeParallel).toBe(impl);
  });

  it("executeParallel is cleared when hooks are reset", async () => {
    const impl = async (): Promise<ToolResponse> => ({
      content: [],
      _meta: { elapsedMs: 0, method: "run_plan" },
    });
    registerProHooks({ executeParallel: impl });
    expect(getProHooks().executeParallel).toBeDefined();

    registerProHooks({});
    expect(getProHooks().executeParallel).toBeUndefined();
  });

  // --- Story 15.2: registerProTools Hook ---

  it("registerProTools is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.registerProTools).toBeUndefined();
  });

  it("registerProTools can be registered and retrieved", () => {
    const impl = vi.fn((_registry: ToolRegistryPublic) => {
      /* Hook consumer would call registry.registerTool(...) here */
    });

    registerProHooks({ registerProTools: impl });

    const hooks = getProHooks();
    expect(hooks.registerProTools).toBe(impl);

    // Simulate Free-Repo calling the hook with a fake registry
    const fakeRegistry: ToolRegistryPublic = {
      registerTool: vi.fn(),
      cdpClient: { send: vi.fn() } as unknown as CdpClient,
      sessionId: "session-1",
      sessionManager: undefined,
    };
    hooks.registerProTools!(fakeRegistry);
    expect(impl).toHaveBeenCalledWith(fakeRegistry);
  });

  it("registerProTools works alongside other hooks", () => {
    const enhance = (_n: string, p: Record<string, unknown>) => p;
    const registerImpl = (_registry: ToolRegistryPublic) => {
      /* no-op */
    };

    registerProHooks({ enhanceTool: enhance, registerProTools: registerImpl });

    const hooks = getProHooks();
    expect(hooks.enhanceTool).toBe(enhance);
    expect(hooks.registerProTools).toBe(registerImpl);
  });

  it("registerProTools is cleared when hooks are reset", () => {
    registerProHooks({ registerProTools: () => { /* no-op */ } });
    expect(getProHooks().registerProTools).toBeDefined();

    registerProHooks({});
    expect(getProHooks().registerProTools).toBeUndefined();
  });

  // --- Story 15.2: enhanceEvaluateResult Hook ---

  it("enhanceEvaluateResult is undefined by default", () => {
    const hooks = getProHooks();
    expect(hooks.enhanceEvaluateResult).toBeUndefined();
  });

  it("enhanceEvaluateResult can be registered and retrieved", async () => {
    const enhanced: ToolResponse = {
      content: [
        { type: "text", text: "result" },
        { type: "text", text: "Visual: 100x50 -> 200x50" },
        { type: "image", data: "fakeBase64", mimeType: "image/webp" },
      ],
      _meta: { elapsedMs: 20, method: "evaluate", visualFeedback: true },
    };
    const impl = vi.fn().mockResolvedValue(enhanced);

    registerProHooks({ enhanceEvaluateResult: impl });

    const hooks = getProHooks();
    expect(hooks.enhanceEvaluateResult).toBe(impl);

    const fakeCdp = { send: vi.fn() } as unknown as CdpClient;
    const base: ToolResponse = {
      content: [{ type: "text", text: "result" }],
      _meta: { elapsedMs: 10, method: "evaluate" },
    };
    const result = await hooks.enhanceEvaluateResult!(
      "el.style.width = '200px'",
      base,
      { cdpClient: fakeCdp, sessionId: "sess-1" },
    );

    expect(impl).toHaveBeenCalledWith(
      "el.style.width = '200px'",
      base,
      { cdpClient: fakeCdp, sessionId: "sess-1" },
    );
    expect(result).toBe(enhanced);
  });

  it("enhanceEvaluateResult is cleared when hooks are reset", async () => {
    const impl = async (
      _expression: string,
      result: ToolResponse,
    ): Promise<ToolResponse> => result;
    registerProHooks({ enhanceEvaluateResult: impl });
    expect(getProHooks().enhanceEvaluateResult).toBeDefined();

    registerProHooks({});
    expect(getProHooks().enhanceEvaluateResult).toBeUndefined();
  });
});
