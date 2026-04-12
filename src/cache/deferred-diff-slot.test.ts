import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeferredDiffSlot } from "./deferred-diff-slot.js";

/**
 * Story 20.1 — Unit-Tests fuer `DeferredDiffSlot`.
 *
 * Structural analog to `prefetch-slot.test.ts` (Story 18.5). Tests cover:
 *  1. Happy-Path: schedule, build completes, drain returns the diff text
 *  2. Drain on empty slot returns null
 *  3. Drain consumes the value (second drain returns null)
 *  4. Second schedule cancels first via AbortSignal
 *  5. Identity-Check: aborted slot's completion does NOT overwrite new slot's result
 *  6. cancel() aborts and clears the pending diff
 *  7. cancel() on empty slot is a no-op
 *  8. Build errors are absorbed, slot cleans up, drain returns null
 *  9. AbortError in build is swallowed silently
 * 10. Schedule clears previous pending diff text
 * 11. Build returning null is stored and drained correctly
 */

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("DeferredDiffSlot (Story 20.1)", () => {
  let slot: DeferredDiffSlot;
  let unhandledRejections: unknown[];
  const unhandledHandler = (err: unknown): void => {
    unhandledRejections.push(err);
  };

  beforeEach(() => {
    slot = new DeferredDiffSlot();
    unhandledRejections = [];
    process.on("unhandledRejection", unhandledHandler);
  });

  afterEach(() => {
    process.off("unhandledRejection", unhandledHandler);
    expect(unhandledRejections).toHaveLength(0);
  });

  // Test 1: Happy-Path
  it("schedule runs the build callback once, drain returns the result", async () => {
    const build = vi.fn(async (_signal: AbortSignal) => {
      return "--- DOM diff ---";
    });

    const done = slot.schedule(build);
    expect(slot.isActive).toBe(true);

    await done;

    expect(build).toHaveBeenCalledTimes(1);
    expect(slot.isActive).toBe(false);

    const drained = slot.drain();
    expect(drained).toBe("--- DOM diff ---");
  });

  // Test 2: Drain on empty slot returns null
  it("drain on empty slot returns null", () => {
    expect(slot.drain()).toBeNull();
  });

  // Test 3: Drain consumes the value
  it("drain consumes the value — second drain returns null", async () => {
    const done = slot.schedule(async () => "diff text");
    await done;

    expect(slot.drain()).toBe("diff text");
    expect(slot.drain()).toBeNull();
  });

  // Test 4: Second schedule cancels first via AbortSignal
  it("second schedule aborts first via AbortSignal", async () => {
    let firstSignal: AbortSignal | undefined;
    let firstResolve: (() => void) | undefined;

    const firstBuild = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          firstSignal = signal;
          firstResolve = () => resolve("first diff");
        }),
    );

    const firstDone = slot.schedule(firstBuild);
    expect(slot.isActive).toBe(true);

    await tick();
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    // Second schedule replaces first
    let secondSignal: AbortSignal | undefined;
    const secondBuild = vi.fn(async (signal: AbortSignal) => {
      secondSignal = signal;
      return "second diff";
    });
    const secondDone = slot.schedule(secondBuild);

    // First was aborted synchronously
    expect(firstSignal?.aborted).toBe(true);
    expect(slot.isActive).toBe(true);

    await tick();
    expect(secondSignal).toBeDefined();
    expect(secondSignal?.aborted).toBe(false);

    // Resolve first (after abort — should not set pending)
    firstResolve?.();
    await firstDone;
    await secondDone;

    // Only second diff should be drainable
    expect(slot.drain()).toBe("second diff");
  });

  // Test 5: Identity-Check — aborted slot's completion does NOT overwrite
  it("aborted slot's build completion does NOT overwrite new slot's result", async () => {
    let firstResolve: ((v: string | null) => void) | undefined;
    const firstBuild = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          firstResolve = resolve;
        }),
    );

    const firstDone = slot.schedule(firstBuild);
    await tick();

    // Second slot (hangs)
    let secondResolve: ((v: string | null) => void) | undefined;
    const secondBuild = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          secondResolve = resolve;
        }),
    );
    const secondDone = slot.schedule(secondBuild);
    await tick();

    // First resolves AFTER being replaced — its identity-check must prevent
    // writing to _pendingDiffText
    firstResolve?.("STALE diff");
    await firstDone;

    // Second is still active, no stale data leaked
    expect(slot.isActive).toBe(true);
    expect(slot.pendingDiffText).toBeNull(); // no stale "first diff"

    // Finish second
    secondResolve?.("correct diff");
    await secondDone;

    expect(slot.drain()).toBe("correct diff");
  });

  // Test 6: cancel() aborts and clears pending diff
  it("cancel empties the slot, aborts the build, and clears pending diff", async () => {
    let signalRef: AbortSignal | undefined;
    let buildResolve: ((v: string | null) => void) | undefined;
    const build = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          signalRef = signal;
          buildResolve = resolve;
        }),
    );

    const done = slot.schedule(build);
    expect(slot.isActive).toBe(true);
    await tick();
    expect(signalRef?.aborted).toBe(false);

    slot.cancel();

    expect(slot.isActive).toBe(false);
    expect(signalRef?.aborted).toBe(true);
    expect(slot.drain()).toBeNull();

    buildResolve?.("should-be-ignored");
    await done;
  });

  // Test 7: cancel() on empty slot is a no-op
  it("cancel on empty slot is a no-op", () => {
    expect(slot.isActive).toBe(false);
    expect(() => slot.cancel()).not.toThrow();
    expect(slot.isActive).toBe(false);
  });

  // Test 8: Build errors are absorbed
  it("build errors are absorbed, slot cleans up, drain returns null", async () => {
    // Async throw
    const asyncFailBuild = vi.fn(async (_signal: AbortSignal): Promise<string | null> => {
      throw new Error("async build boom");
    });
    const asyncDone = slot.schedule(asyncFailBuild);
    await asyncDone;
    expect(slot.isActive).toBe(false);
    expect(slot.drain()).toBeNull();

    // Sync throw
    const syncFailBuild = vi.fn((_signal: AbortSignal): Promise<string | null> => {
      throw new Error("sync build boom");
    });
    const syncDone = slot.schedule(syncFailBuild);
    await syncDone;
    expect(slot.isActive).toBe(false);
    expect(slot.drain()).toBeNull();
  });

  // Test 9: AbortError is swallowed silently
  it("AbortError in build is swallowed silently", async () => {
    const build = vi.fn(async (_signal: AbortSignal): Promise<string | null> => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const done = slot.schedule(build);
    await done;
    expect(slot.isActive).toBe(false);
    expect(slot.drain()).toBeNull();
  });

  // Test 10: Schedule clears previous pending diff text
  it("new schedule clears any previous pending diff text", async () => {
    // First build completes with a diff
    const done1 = slot.schedule(async () => "old diff");
    await done1;
    expect(slot.pendingDiffText).toBe("old diff");

    // Second schedule must clear the pending diff from the first (synchronously)
    let secondResolve: ((v: string | null) => void) | undefined;
    const done2 = slot.schedule(
      (_signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          secondResolve = resolve;
        }),
    );

    // Pending diff from the first schedule was cleared synchronously by schedule()
    expect(slot.pendingDiffText).toBeNull();

    // Wait for setImmediate so secondResolve is assigned
    await tick();

    secondResolve?.("second diff");
    await done2;
    expect(slot.drain()).toBe("second diff");
  });

  // Test 11: Build returning null is stored and drained correctly
  it("build returning null is stored — drain returns null (no diff detected)", async () => {
    const done = slot.schedule(async () => null);
    await done;

    // pendingDiffText is null (the build returned null)
    expect(slot.pendingDiffText).toBeNull();
    // drain returns null
    expect(slot.drain()).toBeNull();
  });

  // Test 12 (M2): In-flight discard — drain while build is in-flight cancels
  // the build and prevents its result from appearing in a later drain.
  it("drain cancels in-flight build — late completion does NOT store result (H1-Fix)", async () => {
    let buildResolve: ((v: string | null) => void) | undefined;
    let buildSignal: AbortSignal | undefined;

    const build = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          buildSignal = signal;
          buildResolve = resolve;
        }),
    );

    const done = slot.schedule(build);
    await tick(); // Let setImmediate fire so build starts
    expect(slot.isActive).toBe(true);
    expect(buildSignal?.aborted).toBe(false);

    // Drain while build is still in-flight
    const drained1 = slot.drain();
    expect(drained1).toBeNull(); // No result yet

    // Build should have been cancelled
    expect(buildSignal?.aborted).toBe(true);
    expect(slot.isActive).toBe(false);

    // Build completes AFTER drain (late resolution)
    buildResolve?.("ghost diff that must NOT appear");
    await done;

    // Second drain must return null — the ghost result was discarded
    const drained2 = slot.drain();
    expect(drained2).toBeNull();
    expect(slot.pendingDiffText).toBeNull();
  });
});
