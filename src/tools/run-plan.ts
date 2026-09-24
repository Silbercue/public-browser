import { z } from "zod";
import type { ToolResponse } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { executePlan } from "../plan/plan-executor.js";
import type { PlanStep, PlanOptions, SuspendedPlanResponse } from "../plan/plan-executor.js";
import type { PlanStateStore } from "../plan/plan-state-store.js";

const suspendSchema = z.object({
  question: z.string().optional().describe("Question for the agent"),
  context: z.enum(["capture_image"]).optional().describe("capture_image: attach a screenshot"),
  condition: z.string().optional().describe("Suspend after the step if this $-expression is true"),
});

const stepSchema = z.object({
  tool: z.string().describe("Tool name"),
  params: z.record(z.unknown()).optional().describe("Tool parameters; $name substitutes a variable"),
  saveAs: z.string().optional().describe("Save the result as $name for later steps"),
  if: z.string().optional().describe("Run the step only if this expression is true, e.g. \"$pageTitle === 'Login'\""),
  suspend: suspendSchema.optional().describe("Pause here to ask the agent a question"),
});

const resumeSchema = z.object({
  planId: z.string().describe("ID of the suspended plan"),
  answer: z.string().describe("Answer to the suspend question"),
});

// S9: `parallel` (tab groups) and `use_operator` are gone — both needed hooks
// of the closed Pro version and answered every call with an error.
export const runPlanSchema = z.object({
  steps: z
    .array(stepSchema)
    .optional()
    .describe("Tool steps to run in order"),
  vars: z
    .record(z.unknown())
    .optional()
    .describe("Initial variables, available as $name"),
  errorStrategy: z
    .enum(["abort", "continue", "capture_image"])
    .optional()
    .default("abort")
    .describe("abort stops at the first error; continue runs all steps; capture_image screenshots, then aborts"),
  resume: resumeSchema.optional().describe("Resume a suspended plan"),
});

export type RunPlanParams = z.infer<typeof runPlanSchema>;

/** Dependencies injected by the registry */
export interface RunPlanDeps {
  cdpClient: CdpClient;
  sessionId: string;
  sessionManager?: SessionManager;
}

export async function runPlanHandler(
  params: RunPlanParams,
  registry: ToolRegistry,
  _deps?: RunPlanDeps,
  stateStore?: PlanStateStore,
): Promise<ToolResponse | SuspendedPlanResponse> {
  // --- Validation: steps and resume are mutually exclusive ---
  const modeCount = [params.steps, params.resume].filter(Boolean).length;
  if (modeCount > 1) {
    return {
      content: [{ type: "text", text: "Only one of 'steps' or 'resume' may be provided" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "run_plan" },
    };
  }

  if (modeCount === 0) {
    return {
      content: [{ type: "text", text: "One of 'steps' or 'resume' must be provided" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "run_plan" },
    };
  }

  // --- Resume path ---
  if (params.resume) {
    if (!stateStore) {
      return {
        content: [{ type: "text", text: "Resume not available: no PlanStateStore configured" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }
    const suspended = stateStore.resume(params.resume.planId);
    if (!suspended) {
      return {
        content: [{ type: "text", text: "Plan expired or not found" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }
    const resumeOptions: PlanOptions = {
      vars: suspended.vars,
      errorStrategy: suspended.errorStrategy,
      resumeState: {
        suspendedAtIndex: suspended.suspendedAtIndex,
        completedResults: suspended.completedResults,
        vars: suspended.vars,
        answer: params.resume.answer,
      },
    };

    return executePlan(suspended.steps, registry, resumeOptions, stateStore);
  }

  const planOptions: PlanOptions = {
    vars: params.vars,
    errorStrategy: params.errorStrategy,
  };

  // Default: plain sequential execution
  const steps = params.steps as PlanStep[];
  return executePlan(steps, registry, planOptions, stateStore);
}
