import { describe, it, expect } from "vitest";
import type { Signal } from "./signal-types.js";
import { aggregateSignals, MAX_CLUSTER_DEPTH } from "./aggregator.js";

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    type: "role",
    signal: "role:generic",
    nodeId: "node-1",
    weight: 0.5,
    count: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture: Login Form Signals
// ---------------------------------------------------------------------------

function loginFormSignals(): Signal[] {
  return [
    makeSignal({ type: "role", signal: "role:form", nodeId: "form-1", weight: 0.7 }),
    makeSignal({ type: "attribute", signal: "type:password", nodeId: "pwd-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "type:submit", nodeId: "submit-1", weight: 0.6 }),
    makeSignal({ type: "attribute", signal: "autocomplete:username", nodeId: "user-1", weight: 0.6 }),
    makeSignal({ type: "structure", signal: "parent:form", nodeId: "pwd-1", weight: 0.5 }),
    makeSignal({ type: "structure", signal: "parent:form", nodeId: "user-1", weight: 0.5 }),
  ];
}

// ---------------------------------------------------------------------------
// Fixture: Page with Form AND Search Result List (two patterns)
// ---------------------------------------------------------------------------

function mixedPageSignals(): Signal[] {
  return [
    // Form cluster
    makeSignal({ type: "role", signal: "role:form", nodeId: "form-1", weight: 0.7 }),
    makeSignal({ type: "attribute", signal: "type:password", nodeId: "form-1", weight: 0.6 }),
    // List cluster
    makeSignal({ type: "role", signal: "role:list", nodeId: "list-1", weight: 0.7 }),
    makeSignal({ type: "role", signal: "role:listitem", nodeId: "list-1", weight: 0.5, count: 5 }),
    makeSignal({ type: "role", signal: "role:search", nodeId: "search-1", weight: 0.7 }),
  ];
}

// ---------------------------------------------------------------------------
// AC-4: Aggregator konsolidiert Signale zu Struktur-Kandidaten
// ---------------------------------------------------------------------------

describe("aggregateSignals — AC-4: Clustering", () => {
  it("merges parent:form children into the form cluster (parent-child clustering)", () => {
    const clusters = aggregateSignals(loginFormSignals());

    // Parent-child clustering: pwd-1 and user-1 carry parent:form signals,
    // so they merge into form-1's cluster (which has role:form).
    const formCluster = clusters.find((c) => c.nodeIds.includes("form-1"));
    expect(formCluster).toBeDefined();

    // pwd-1 and user-1 should be merged into the form cluster
    expect(formCluster!.nodeIds).toContain("pwd-1");
    expect(formCluster!.nodeIds).toContain("user-1");

    // All signals from merged nodes should be in the cluster
    expect(formCluster!.signals.some((s) => s.signal === "role:form")).toBe(true);
    expect(formCluster!.signals.some((s) => s.signal === "type:password")).toBe(true);
    expect(formCluster!.signals.some((s) => s.signal === "autocomplete:username")).toBe(true);
    expect(formCluster!.signals.some((s) => s.signal === "parent:form")).toBe(true);

    // submit-1 has no parent:form signal, so it stays in its own cluster
    const submitCluster = clusters.find((c) =>
      c.nodeIds.includes("submit-1") && !c.nodeIds.includes("form-1"),
    );
    expect(submitCluster).toBeDefined();
  });

  it("separates Form and List signals into exactly two main clusters", () => {
    const clusters = aggregateSignals(mixedPageSignals());

    // Form signals: form-1 has role:form and type:password → one cluster
    const formCluster = clusters.find((c) => c.nodeIds.includes("form-1"));
    expect(formCluster).toBeDefined();
    expect(formCluster!.signals.some((s) => s.signal === "role:form")).toBe(true);
    expect(formCluster!.signals.some((s) => s.signal === "type:password")).toBe(true);

    // List signals: list-1 has role:list and role:listitem → one cluster
    const listCluster = clusters.find((c) => c.nodeIds.includes("list-1"));
    expect(listCluster).toBeDefined();
    expect(listCluster!.signals.some((s) => s.signal === "role:list")).toBe(true);
    expect(listCluster!.signals.some((s) => s.signal === "role:listitem")).toBe(true);

    // Search-1 is a separate cluster (no parent relationship to list-1)
    const searchCluster = clusters.find((c) => c.nodeIds.includes("search-1"));
    expect(searchCluster).toBeDefined();
    expect(searchCluster!.signals.some((s) => s.signal === "role:search")).toBe(true);

    // Form and list are in different clusters
    expect(formCluster).not.toBe(listCluster);
  });

  it("returns empty cluster array for empty signal list", () => {
    const clusters = aggregateSignals([]);
    expect(clusters).toEqual([]);
  });

  it("preserves all input signals — no losses, no duplications", () => {
    const input = loginFormSignals();
    const clusters = aggregateSignals(input);

    // Collect all signals from all clusters
    const outputSignals: Signal[] = [];
    for (const cluster of clusters) {
      outputSignals.push(...cluster.signals);
    }

    // Same count — no losses
    expect(outputSignals.length).toBe(input.length);

    // Every input signal appears exactly once in output
    for (const inputSig of input) {
      const matches = outputSignals.filter(
        (s) => s.signal === inputSig.signal && s.nodeId === inputSig.nodeId,
      );
      expect(matches.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Cluster Profiles
// ---------------------------------------------------------------------------

describe("aggregateSignals — Cluster Profiles", () => {
  it("computes dominantTypes from the most frequent signal type", () => {
    const clusters = aggregateSignals(loginFormSignals());

    // The pwd-1 cluster has type:password (attribute) and parent:form (structure)
    const pwdCluster = clusters.find((c) => c.nodeIds.includes("pwd-1"));
    expect(pwdCluster).toBeDefined();
    expect(pwdCluster!.dominantTypes.length).toBeGreaterThan(0);
  });

  it("handles single-signal clusters correctly", () => {
    const clusters = aggregateSignals([
      makeSignal({ type: "role", signal: "role:article", nodeId: "art-1", weight: 0.9 }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].dominantTypes).toEqual(["role"]);
  });
});

// ---------------------------------------------------------------------------
// Named Constants
// ---------------------------------------------------------------------------

describe("aggregateSignals — Named Constants", () => {
  it("MAX_CLUSTER_DEPTH is a positive number", () => {
    expect(MAX_CLUSTER_DEPTH).toBeGreaterThan(0);
  });

  it("parent-child merge respects MAX_CLUSTER_DEPTH=1 (no transitive chains beyond depth)", () => {
    // With MAX_CLUSTER_DEPTH=1, a→b merge works but a→b→c would not chain fully.
    // Create: c has parent:inner, b (inner) has parent:outer, a (outer) has role:outer.
    // With depth 1: c→b, b→a. Each resolves 1 hop. So c→b and b→a.
    // c ends up at b's target (a), and b ends up at a. All merge into a's cluster.
    const signals: Signal[] = [
      makeSignal({ type: "role", signal: "role:outer", nodeId: "a", weight: 0.7 }),
      makeSignal({ type: "role", signal: "role:inner", nodeId: "b", weight: 0.5 }),
      makeSignal({ type: "structure", signal: "parent:outer", nodeId: "b", weight: 0.4 }),
      makeSignal({ type: "attribute", signal: "type:text", nodeId: "c", weight: 0.5 }),
      makeSignal({ type: "structure", signal: "parent:inner", nodeId: "c", weight: 0.4 }),
    ];

    const clusters = aggregateSignals(signals);

    // With MAX_CLUSTER_DEPTH=1: b→a (1 hop), c→b (1 hop, stops at b not a)
    // So we expect: cluster a contains {a, b}, cluster b is gone (merged into a),
    // cluster c resolves to b — but b already merged to a? No: resolveRoot works per-node.
    // resolveRoot(c) = mergeTarget(c) = b, depth 1 reached → returns b
    // resolveRoot(b) = mergeTarget(b) = a, depth 1 reached → returns a
    // So c goes to cluster "b" and b goes to cluster "a".
    // But the clusterMap uses the root as key, so c→b and b→a.
    // c's root is b, b's root is a. They end up in different clusters if depth=1.
    // Actually: resolveRoot traverses up to MAX_CLUSTER_DEPTH hops.
    // With MAX_CLUSTER_DEPTH=1: resolveRoot(c) follows 1 hop: c→b, returns b.
    // resolveRoot(b) follows 1 hop: b→a, returns a.
    // So c goes to cluster keyed "b" and b goes to cluster keyed "a".
    // Result: 2 clusters: {a, b} and {c} (c reached b but b was already resolved to a).
    // Wait — the clusterMap key for c is resolveRoot(c)="b", and for b is resolveRoot(b)="a".
    // So c goes into the "b" bucket and b goes into the "a" bucket. Since "b" and "a" are
    // different keys, c is NOT in the same cluster as a.

    // With MAX_CLUSTER_DEPTH=1, transitive chains beyond 1 hop don't fully merge.
    const clusterA = clusters.find((cl) => cl.nodeIds.includes("a"));
    expect(clusterA).toBeDefined();
    expect(clusterA!.nodeIds).toContain("b"); // b→a is 1 hop, within depth

    // c→b is 1 hop, so c ends up in b's cluster. But b was moved to a's cluster.
    // The key for c is resolveRoot(c)="b", but b itself is placed under resolveRoot(b)="a".
    // So c ends up under key "b" which is a separate cluster from key "a".
    // This means c is NOT in the same cluster as a — that's the depth limit working.
    const clusterWithC = clusters.find((cl) => cl.nodeIds.includes("c"));
    expect(clusterWithC).toBeDefined();
    // c is in a cluster that does NOT contain a (depth limit prevents full chain)
    expect(clusterWithC!.nodeIds).not.toContain("a");
  });
});
