import { z } from "zod";
import type { ToolResponse } from "../types.js";
import type { ToolRegistry } from "../registry.js";
import type { CdpClient } from "../cdp/cdp-client.js";
import type { SessionManager } from "../cdp/session-manager.js";
import { executePlan } from "../plan/plan-executor.js";
import type { PlanStep, PlanOptions, SuspendedPlanResponse } from "../plan/plan-executor.js";
import type { PlanStateStore } from "../plan/plan-state-store.js";
import { getProHooks } from "../hooks/pro-hooks.js";

const suspendSchema = z.object({
  question: z.string().optional().describe("Question to ask the agent when suspending"),
  context: z.enum(["capture_image"]).optional().describe("Context to include: 'capture_image' captures the page"),
  condition: z.string().optional().describe("Condition expression — suspend AFTER step if true. Uses $varName syntax."),
});

const stepSchema = z.object({
  tool: z.string().describe("Tool name to execute (e.g. 'click', 'type', 'press_key', 'navigate', 'scroll')"),
  params: z.record(z.unknown()).optional().describe("Parameters for the tool. Use $varName for variable substitution."),
  saveAs: z.string().optional().describe("Save step result as variable (accessible via $name in later steps)"),
  if: z.string().optional().describe("Condition expression — step runs only if true. Use $varName for variables. Example: \"$pageTitle === 'Login'\""),
  suspend: suspendSchema.optional().describe("Suspend plan at this step to ask the agent a question"),
});

const resumeSchema = z.object({
  planId: z.string().describe("ID of the suspended plan to resume"),
  answer: z.string().describe("Agent's answer to the suspend question"),
});

// Story 7.6: Schema for parallel tab groups
const parallelGroupSchema = z.object({
  tab: z.string().describe("Tab ID (targetId) to execute steps on"),
  steps: z.array(stepSchema).describe("Steps to execute on this tab"),
});

export const runPlanSchema = z.object({
  steps: z
    .array(stepSchema)
    .optional()
    .describe("Array of tool steps to execute sequentially."),
  parallel: z
    .array(parallelGroupSchema)
    .optional()
    .describe("Array of tab groups to execute in parallel across tabs."),
  vars: z
    .record(z.unknown())
    .optional()
    .describe("Initial variables for the plan. Accessible via $varName in step params and conditions."),
  errorStrategy: z
    .enum(["abort", "continue", "capture_image"])
    .optional()
    .default("abort")
    .describe("Error handling: 'abort' (default) stops on first error, 'continue' runs all steps, 'capture_image' captures page on error then aborts."),
  use_operator: z.boolean().optional().default(false).describe(
    "Operator mode (rule engine + Micro-LLM). Requires the executeOperator hook to be registered."
  ),
  resume: resumeSchema.optional().describe("Resume a previously suspended plan."),
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
  deps?: RunPlanDeps,
  stateStore?: PlanStateStore,
): Promise<ToolResponse | SuspendedPlanResponse> {
  // use_operator requires executeOperator hook — not yet implemented in open-source
  if (params.use_operator) {
    return {
      content: [{ type: "text", text: "use_operator requires the operator hook to be registered" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "use_operator" },
    };
  }

  // --- Validation: steps, parallel, and resume are mutually exclusive ---
  const modeCount = [params.steps, params.parallel, params.resume].filter(Boolean).length;
  if (modeCount > 1) {
    return {
      content: [{ type: "text", text: "Only one of 'steps', 'parallel', or 'resume' may be provided" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "run_plan" },
    };
  }

  if (modeCount === 0) {
    return {
      content: [{ type: "text", text: "One of 'steps', 'parallel', or 'resume' must be provided" }],
      isError: true,
      _meta: { elapsedMs: 0, method: "run_plan" },
    };
  }

  // --- Story 7.6 / 15.4: Parallel path ---
  // Multi-Tab-Parallel-Engine wird via executeParallel-Hook injiziert.
  if (params.parallel) {
    if (params.parallel.length === 0) {
      return {
        content: [{ type: "text", text: "parallel must not be empty" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }

    if (!deps) {
      return {
        content: [{ type: "text", text: "Parallel execution requires a CDP connection" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }

    // Safety-Net: executeParallel-Hook muss registriert sein, sonst sauberer Fehler
    // statt undefined.executeParallel(...)-Crash.
    const hooks = getProHooks();
    if (!hooks.executeParallel) {
      return {
        content: [{ type: "text", text: "parallel execution requires the executeParallel hook to be registered" }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    }

    // Inline tab-scope: attach + Runtime/Accessibility enable + sessionId-Override.
    // Standard-CDP-Plumbing, keine Pro-Logik — bleibt im Free-Repo. Der Pro-Hook ist
    // die reine Orchestrierungs-Engine (Semaphore, Promise.allSettled, Group-Aggregation).
    //
    // H2-Fix (Code-Review 15.4): attachte Sessions werden in `attachedSessions`
    // getrackt und nach dem Hook-Aufruf via `Target.detachFromTarget` aufgeraeumt,
    // damit wiederholte parallel-Laeufe keine Session-Leaks verursachen.
    const cdpClient = deps.cdpClient;
    const attachedSessions: Array<{ targetId: string; sessionId: string }> = [];
    const registryFactory = async (tabTargetId: string) => {
      const { sessionId: tabSessionId } = await cdpClient.send<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId: tabTargetId, flatten: true },
      );
      attachedSessions.push({ targetId: tabTargetId, sessionId: tabSessionId });
      await cdpClient.send("Runtime.enable", {}, tabSessionId);
      await cdpClient.send("Accessibility.enable", {}, tabSessionId);
      return {
        // Story 18.1: Parallel-Pfad muss dieselbe Suppression-Semantik haben
        // wie der sequentielle Plan-Executor, sonst leakt der Ambient-Context-
        // Hook zurueck. Das Closure setzt das Flag auf jedem einzelnen
        // `executeTool`-Call; der Aggregations-Hook am Group-Ende liegt
        // im executeParallel-Hook.
        executeTool: (name: string, toolParams: Record<string, unknown>): Promise<ToolResponse> =>
          registry.executeTool(name, toolParams, tabSessionId, {
            skipOnToolResultHook: true,
          }),
      };
    };

    // H1-Fix (Code-Review 15.4): Hook-Exceptions in MCP-konforme isError-Response
    // wandeln statt nach oben durchzulassen.
    try {
      const parallelResult = await hooks.executeParallel(
        params.parallel as Array<{ tab: string; steps: PlanStep[] }>,
        registryFactory,
        {
          vars: params.vars,
          errorStrategy: params.errorStrategy,
          concurrencyLimit: 5,
        },
      );

      // Story 18.1 H1 (Code-Review 18.1): Aggregations-Hook fuer den
      // Parallel-Pfad. Der `registryFactory`-Vertrag exponiert bewusst nur
      // `executeTool` (nicht `runAggregationHook`), damit der Pro-`executeParallel`
      // keinen tab-spezifischen End-Hook rufen muss. Stattdessen rufen wir
      // hier im Free-Repo, nach Abschluss der gesamten Parallel-Gruppe,
      // den Aggregations-Hook genau einmal ueber die aktuelle (nicht-tab)
      // Session. Das garantiert AC-2 auch fuer Parallel-Runs: N Steps →
      // Hook laeuft genau 1x am Ende, nicht 3x (bei 3 Steps) und nicht 0x.
      //
      // Guards:
      //  - Nur wenn die Parallel-Response kein `isError` ist (kein Early-Abort).
      //  - Hook-Exceptions werden geschluckt (best-effort), damit der
      //    Plan-Response nicht wegen eines Hook-Fehlers kippt.
      if (!parallelResult.isError) {
        try {
          await registry.runAggregationHook(parallelResult, "run_plan");
        } catch {
          // Best-effort — siehe plan-executor.ts Aggregations-Hook.
        }
      }

      return parallelResult;
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `parallel execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
        _meta: { elapsedMs: 0, method: "run_plan" },
      };
    } finally {
      // H2-Fix: Cleanup aller attachten Sessions, auch im Fehlerfall.
      // Best-effort: Detach-Fehler werden geschluckt, damit ein einzelner
      // bereits geschlossener Tab nicht den ganzen Cleanup blockiert.
      for (const { sessionId: tabSessionId } of attachedSessions) {
        try {
          await cdpClient.send("Target.detachFromTarget", { sessionId: tabSessionId });
        } catch {
          // Tab ggf. bereits geschlossen — ignorieren
        }
      }
    }
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
