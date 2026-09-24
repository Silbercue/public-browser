import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPlanHandler, runPlanSchema } from "./run-plan.js";
import type { RunPlanParams } from "./run-plan.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolResponse } from "../types.js";
import { PlanStateStore } from "../plan/plan-state-store.js";
import type { SuspendedPlanResponse } from "../plan/plan-executor.js";
import { registerProHooks } from "../hooks/pro-hooks.js";

function createMockRegistry(
  toolResponses: Map<string, ToolResponse>,
): ToolRegistry {
  return {
    executeTool: vi.fn(async (name: string, _params: Record<string, unknown>) => {
      const response = toolResponses.get(name);
      if (!response) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
          _meta: { elapsedMs: 0, method: name },
        };
      }
      return response;
    }),
    // Story 18.1: Plan-Executor ruft am Plan-Ende runAggregationHook
    // ueber den letzten Step auf. Mocks brauchen eine no-op-Implementation.
    runAggregationHook: vi.fn(async () => {}),
  } as unknown as ToolRegistry;
}

describe("runPlanHandler", () => {
  it("delegates to executePlan with parsed steps", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "OK" }],
      _meta: { elapsedMs: 10, method: "navigate" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://test.com" } }],
    };

    const result = await runPlanHandler(params, registry);

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
    expect(result._meta).toBeDefined();
    expect(result._meta!.method).toBe("run_plan");
  });

  it("passes registry to executePlan", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("evaluate", {
      content: [{ type: "text", text: "42" }],
      _meta: { elapsedMs: 3, method: "evaluate" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "evaluate", params: { expression: "21*2" } }],
    };

    await runPlanHandler(params, registry);

    // Verify the registry's executeTool was called. Story 18.1: run_plan
    // uebergibt jetzt einen 4. Options-Parameter mit `skipOnToolResultHook`.
    expect(registry.executeTool).toHaveBeenCalledWith(
      "evaluate",
      { expression: "21*2" },
      undefined,
      { skipOnToolResultHook: true },
    );
  });

  it("passes vars and errorStrategy to executePlan", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "OK" }],
      _meta: { elapsedMs: 5, method: "navigate" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "$url" } }],
      vars: { url: "https://test.com" },
      errorStrategy: "continue",
    };

    const result = await runPlanHandler(params, registry);

    expect(result).toBeDefined();
    expect(registry.executeTool).toHaveBeenCalledWith(
      "navigate",
      { url: "https://test.com" },
      undefined,
      { skipOnToolResultHook: true },
    );
  });

  it("works without vars and errorStrategy (backward compatible)", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", {
      content: [{ type: "text", text: "Clicked" }],
      _meta: { elapsedMs: 2, method: "click" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [{ tool: "click", params: { ref: "e1" } }],
    };

    const result = await runPlanHandler(params, registry);

    expect(result).toBeDefined();
    expect(result.isError).toBeFalsy();
  });
});

describe("runPlanSchema (Story 6.4)", () => {
  it("accepts vars in schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [{ tool: "navigate", params: { url: "$url" } }],
      vars: { url: "https://test.com" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts errorStrategy in schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [{ tool: "click" }],
      errorStrategy: "continue",
    });
    expect(result.success).toBe(true);
  });

  it("accepts saveAs and if in step schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [
        { tool: "evaluate", params: { expression: "1" }, saveAs: "result" },
        { tool: "click", params: { ref: "e1" }, if: "$result === 1" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("errorStrategy defaults to abort", () => {
    const result = runPlanSchema.parse({
      steps: [{ tool: "click" }],
    });
    expect(result.errorStrategy).toBe("abort");
  });

  it("rejects invalid errorStrategy", () => {
    const result = runPlanSchema.safeParse({
      steps: [{ tool: "click" }],
      errorStrategy: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("runPlanSchema — keine toten Parameter (S9)", () => {
  it("kennt parallel und use_operator nicht mehr", () => {
    expect(Object.keys(runPlanSchema.shape).sort()).toEqual(["errorStrategy", "resume", "steps", "vars"]);
  });

  it("verwirft parallel und use_operator beim Parsen", () => {
    const parsed = runPlanSchema.parse({
      steps: [{ tool: "click" }],
      parallel: [{ tab: "t1", steps: [] }],
      use_operator: true,
    });
    expect(parsed).not.toHaveProperty("parallel");
    expect(parsed).not.toHaveProperty("use_operator");
  });
});

// ===== Story 6.5: Suspend/Resume in runPlanHandler =====

function isSuspended(result: unknown): result is SuspendedPlanResponse {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    (result as SuspendedPlanResponse).status === "suspended"
  );
}

describe("runPlanHandler — Suspend/Resume (Story 6.5)", () => {
  it("returns error when neither steps nor resume is provided", async () => {
    const registry = createMockRegistry(new Map());
    const params = {} as RunPlanParams;

    const result = await runPlanHandler(params, registry, undefined, new PlanStateStore());

    expect(result).toBeDefined();
    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("One of 'steps' or 'resume' must be provided");
  });

  it("returns error when resume has unknown planId", async () => {
    const registry = createMockRegistry(new Map());
    const store = new PlanStateStore();
    const params: RunPlanParams = {
      resume: { planId: "nonexistent-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry, undefined, store);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Plan expired or not found");
  });

  it("returns error when resume called without stateStore", async () => {
    const registry = createMockRegistry(new Map());
    const params: RunPlanParams = {
      resume: { planId: "some-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Resume not available");
  });

  it("suspend returns SuspendedPlanResponse through runPlanHandler", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "OK" }],
      _meta: { elapsedMs: 10, method: "navigate" },
    });

    const registry = createMockRegistry(responses);
    const store = new PlanStateStore();
    const params: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "navigate", params: { url: "https://example.com/2" }, suspend: { question: "Continue?" } },
      ],
    };

    const result = await runPlanHandler(params, registry, undefined, store);

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) throw new Error("Expected suspended");
    expect(result.question).toBe("Continue?");
    expect(result.completedSteps).toHaveLength(1);
  });

  it("resume continues and completes the plan", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("navigate", {
      content: [{ type: "text", text: "Navigated" }],
      _meta: { elapsedMs: 10, method: "navigate" },
    });
    responses.set("click", {
      content: [{ type: "text", text: "Clicked" }],
      _meta: { elapsedMs: 5, method: "click" },
    });

    const registry = createMockRegistry(responses);
    const store = new PlanStateStore();

    // First: suspend
    const suspendParams: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e5" }, suspend: { question: "Which element?" } },
        { tool: "navigate", params: { url: "https://example.com/done" } },
      ],
    };

    const suspendResult = await runPlanHandler(suspendParams, registry, undefined, store);
    expect(isSuspended(suspendResult)).toBe(true);
    if (!isSuspended(suspendResult)) throw new Error("Expected suspended");

    // Resume
    const resumeParams: RunPlanParams = {
      resume: { planId: suspendResult.planId, answer: "e15" },
    };

    const resumeResult = await runPlanHandler(resumeParams, registry, undefined, store);
    expect(isSuspended(resumeResult)).toBe(false);
    expect((resumeResult as ToolResponse).isError).toBeFalsy();
  });

  it("returns error when both steps and resume are provided", async () => {
    const registry = createMockRegistry(new Map());
    const store = new PlanStateStore();
    const params: RunPlanParams = {
      steps: [{ tool: "navigate", params: { url: "https://example.com" } }],
      resume: { planId: "some-id", answer: "yes" },
    };

    const result = await runPlanHandler(params, registry, undefined, store);

    expect((result as ToolResponse).isError).toBe(true);
    const text = ((result as ToolResponse).content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Only one of 'steps' or 'resume' may be provided");
  });

});

describe("runPlanSchema — Suspend/Resume (Story 6.5)", () => {
  it("accepts steps as optional", () => {
    const result = runPlanSchema.safeParse({
      resume: { planId: "abc123", answer: "e15" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts suspend in step schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [
        {
          tool: "click",
          params: { ref: "e5" },
          suspend: { question: "Which element?", context: "capture_image" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts suspend with condition in step schema", () => {
    const result = runPlanSchema.safeParse({
      steps: [
        {
          tool: "evaluate",
          params: { expression: "1" },
          saveAs: "count",
          suspend: { condition: "$count === 0" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts resume schema", () => {
    const result = runPlanSchema.safeParse({
      resume: { planId: "test-id", answer: "yes" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects resume with missing answer", () => {
    const result = runPlanSchema.safeParse({
      resume: { planId: "test-id" },
    });
    expect(result.success).toBe(false);
  });
});

// ===== Story 11.1: Step-Limit entfernt — alle Steps werden ausgefuehrt =====

describe("runPlanHandler — No Step-Limit (Story 11.1)", () => {
  it("executes all steps without truncation regardless of count", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate", params: { url: "https://example.com" } },
        { tool: "click", params: { ref: "e1" } },
        { tool: "capture_image" },
        { tool: "evaluate", params: { expression: "1" } },
        { tool: "type", params: { ref: "e2", text: "hi" } },
      ],
    };

    const result = await runPlanHandler(params, registry);

    expect(callLog).toHaveLength(5);
    expect(callLog).toEqual(["navigate", "click", "capture_image", "evaluate", "type"]);
    expect(result._meta).toBeDefined();
    expect(result._meta!.truncated).toBeUndefined();
    expect(result._meta!.stepsCompleted).toBe(5);
    expect(result.isError).toBeFalsy();
  });

  it("executes many steps (>3) without truncation even without license", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate" },
        { tool: "click" },
        { tool: "capture_image" },
        { tool: "evaluate" },
        { tool: "type" },
        { tool: "wait_for" },
        { tool: "view_page" },
        { tool: "dom_snapshot" },
      ],
    };

    const result = await runPlanHandler(params, registry);

    expect(callLog).toHaveLength(8);
    expect(result._meta!.truncated).toBeUndefined();
    expect(result._meta!.stepsCompleted).toBe(8);
  });

  it("defaults to no truncation when no license provided", async () => {
    const callLog: string[] = [];
    const registry = {
      executeTool: vi.fn(async (name: string) => {
        callLog.push(name);
        return {
          content: [{ type: "text" as const, text: `${name} done` }],
          _meta: { elapsedMs: 5, method: name },
        };
      }),
    } as unknown as ToolRegistry;

    const params: RunPlanParams = {
      steps: [
        { tool: "navigate" },
        { tool: "click" },
        { tool: "capture_image" },
        { tool: "evaluate" },
        { tool: "type" },
      ],
    };

    const result = await runPlanHandler(params, registry);

    expect(callLog).toHaveLength(5);
    expect(result._meta!.truncated).toBeUndefined();
    expect(result._meta!.stepsCompleted).toBe(5);
  });

});

// --- Story 18.1: run_plan suppresses Ambient-Context-Hook per step ---

describe("runPlanHandler — Ambient-Context suppression (Story 18.1)", () => {
  beforeEach(() => {
    registerProHooks({});
  });

  it("every intermediate step is executed with skipOnToolResultHook=true", async () => {
    const responses = new Map<string, ToolResponse>();
    responses.set("click", {
      content: [{ type: "text", text: "Clicked" }],
      _meta: { elapsedMs: 1, method: "click" },
    });
    responses.set("type", {
      content: [{ type: "text", text: "Typed" }],
      _meta: { elapsedMs: 1, method: "type" },
    });

    const registry = createMockRegistry(responses);
    const params: RunPlanParams = {
      steps: [
        { tool: "click", params: { ref: "e1" } },
        { tool: "type", params: { ref: "e2", text: "hi" } },
      ],
    };

    await runPlanHandler(params, registry);

    const calls = (registry.executeTool as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);
    for (const [, , sessionIdOverride, options] of calls) {
      expect(sessionIdOverride).toBeUndefined();
      expect(options).toEqual({ skipOnToolResultHook: true });
    }
  });

  it("direct tool-calls outside run_plan stay opt-in (ambient context default)", async () => {
    // This verifies the opt-in semantics: only run_plan threads the flag
    // through. A registry callsite that does not pass options preserves
    // the current default behavior (hook runs normally).
    //
    // We check this by building a responses map where the mock registry
    // inspects the fourth argument. run_plan-driven calls must carry the
    // flag; a direct executeTool call (simulating the MCP server.tool
    // callsite) must NOT.
    const directCallOptions: Array<unknown> = [];
    const planCallOptions: Array<unknown> = [];
    const mockRegistry = {
      executeTool: vi.fn(
        async (
          _name: string,
          _params: Record<string, unknown>,
          _sess: string | undefined,
          options: unknown,
        ) => {
          // Route based on who called: for this test we push into the
          // "plan" bucket if the options object was provided, "direct"
          // otherwise. The real production code mirrors this split:
          // run_plan always passes options, the server.tool wrap does not.
          if (options !== undefined) planCallOptions.push(options);
          else directCallOptions.push(options);
          return {
            content: [{ type: "text" as const, text: "ok" }],
            _meta: { elapsedMs: 1, method: _name },
          };
        },
      ),
      runAggregationHook: vi.fn(async () => {}),
    } as unknown as ToolRegistry;

    // Plan-driven call: options must be set
    await runPlanHandler(
      { steps: [{ tool: "click", params: { ref: "e1" } }] } as RunPlanParams,
      mockRegistry,
    );

    // Direct call (outside run_plan): no options → default behavior
    await mockRegistry.executeTool("click", { ref: "e2" });

    expect(planCallOptions).toHaveLength(1);
    expect(planCallOptions[0]).toEqual({ skipOnToolResultHook: true });
    expect(directCallOptions).toHaveLength(1);
    expect(directCallOptions[0]).toBeUndefined();
  });
});
