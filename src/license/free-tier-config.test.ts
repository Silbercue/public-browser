import { describe, it, expect, vi, afterEach } from "vitest";
import { loadFreeTierConfig, DEFAULT_FREE_TIER_CONFIG } from "./free-tier-config.js";

describe("FreeTierConfig", () => {
  afterEach(() => {
    delete process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT;
  });

  it("DEFAULT_FREE_TIER_CONFIG has runPlanLimit of Infinity (no limit)", () => {
    expect(DEFAULT_FREE_TIER_CONFIG.runPlanLimit).toBe(Infinity);
  });

  it("loadFreeTierConfig returns default when no env var set", () => {
    delete process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT;
    const config = loadFreeTierConfig();
    expect(config.runPlanLimit).toBe(Infinity);
  });

  it("loadFreeTierConfig reads SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT env var", () => {
    process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT = "5";
    const config = loadFreeTierConfig();
    expect(config.runPlanLimit).toBe(5);
  });

  it("loadFreeTierConfig falls back to default for non-numeric env var", () => {
    process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT = "abc";
    const config = loadFreeTierConfig();
    expect(config.runPlanLimit).toBe(Infinity);
  });

  it("loadFreeTierConfig falls back to default for empty env var", () => {
    process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT = "";
    const config = loadFreeTierConfig();
    expect(config.runPlanLimit).toBe(Infinity);
  });

  it("loadFreeTierConfig handles zero as valid limit", () => {
    process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT = "0";
    const config = loadFreeTierConfig();
    // 0 is not a meaningful limit, falls back to default
    expect(config.runPlanLimit).toBe(Infinity);
  });

  it("loadFreeTierConfig handles negative values by falling back to default", () => {
    process.env.SILBERCUECHROME_FREE_TIER_RUN_PLAN_LIMIT = "-1";
    const config = loadFreeTierConfig();
    expect(config.runPlanLimit).toBe(Infinity);
  });
});
