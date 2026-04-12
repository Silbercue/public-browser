/**
 * Signal Aggregator — second layer of the Scan-Match-Pipeline.
 *
 * Groups flat Signal[] into DOM-proximity clusters so the Matcher
 * can detect multiple card patterns on a single page (FR6).
 *
 * Module Boundaries:
 *   - MAY import: ./signal-types.ts, ./match-types.ts
 *   - MUST NOT import: src/operator/, src/cards/, src/audit/, src/tools/
 *
 * @tokens max 200
 */

import type { Signal, SignalType } from "./signal-types.js";
import type { AggregatedCluster } from "./match-types.js";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// ---------------------------------------------------------------------------

/**
 * Maximum parent-distance for cluster assignment.
 * Signals whose nodeId starts with "parent:" are assigned to the parent's
 * cluster if the parent nodeId is within this depth.
 * @internal tuning knob — increase if clustering is too aggressive.
 */
export const MAX_CLUSTER_DEPTH = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Group a flat signal list into DOM-proximity clusters.
 *
 * Clustering rules:
 * 1. Signals with the same `nodeId` belong to the same cluster.
 * 2. Signals whose `signal` string starts with `parent:` indicate a
 *    parent-child relationship. The nodeId that carries a `parent:*`
 *    signal is merged into the cluster of a sibling nodeId that carries
 *    a matching role signal (e.g. `parent:form` merges into the cluster
 *    whose nodeId has `role:form`), up to MAX_CLUSTER_DEPTH hops.
 *
 * Every input signal appears in exactly one output cluster — no losses,
 * no duplications (AC-4).
 *
 * @param signals - Flat signal array from extractSignals()
 * @returns Array of clusters, each with nodeIds, signals, and dominant types
 */
export function aggregateSignals(signals: Signal[]): AggregatedCluster[] {
  if (signals.length === 0) return [];

  // Phase 1: Group signals by nodeId
  const nodeGroups = new Map<string, Signal[]>();
  for (const sig of signals) {
    const key = sig.nodeId;
    let group = nodeGroups.get(key);
    if (!group) {
      group = [];
      nodeGroups.set(key, group);
    }
    group.push(sig);
  }

  // Phase 2: Parent-Child Clustering
  // For each nodeId group that contains a `parent:*` signal, find the
  // parent cluster (a different nodeId group that has a role signal
  // matching the parent reference) and merge into it.
  //
  // Build a lookup: role-signal → nodeId (for parent resolution)
  const roleToNodeId = new Map<string, string>();
  for (const [nodeId, groupSignals] of nodeGroups) {
    for (const sig of groupSignals) {
      if (sig.signal.startsWith("role:")) {
        // First occurrence wins — the first nodeId claiming a role is the parent
        if (!roleToNodeId.has(sig.signal)) {
          roleToNodeId.set(sig.signal, nodeId);
        }
      }
    }
  }

  // Resolve merge targets: childNodeId → parentNodeId
  // A node merges into a parent if it has a `parent:X` signal and
  // there is a different node with `role:X`.
  const mergeTarget = new Map<string, string>();
  for (const [nodeId, groupSignals] of nodeGroups) {
    for (const sig of groupSignals) {
      if (sig.signal.startsWith("parent:")) {
        const parentRole = "role:" + sig.signal.slice("parent:".length);
        const parentNodeId = roleToNodeId.get(parentRole);
        if (parentNodeId && parentNodeId !== nodeId) {
          mergeTarget.set(nodeId, parentNodeId);
          break; // one merge target per node
        }
      }
    }
  }

  // Resolve transitive merges up to MAX_CLUSTER_DEPTH
  function resolveRoot(nodeId: string): string {
    let current = nodeId;
    for (let depth = 0; depth < MAX_CLUSTER_DEPTH; depth++) {
      const target = mergeTarget.get(current);
      if (!target) break;
      current = target;
    }
    return current;
  }

  // Phase 3: Build clusters by resolved root
  const clusterMap = new Map<string, { nodeIds: Set<string>; signals: Signal[] }>();
  for (const [nodeId, groupSignals] of nodeGroups) {
    const root = resolveRoot(nodeId);
    let cluster = clusterMap.get(root);
    if (!cluster) {
      cluster = { nodeIds: new Set(), signals: [] };
      clusterMap.set(root, cluster);
    }
    cluster.nodeIds.add(nodeId);
    cluster.signals.push(...groupSignals);
  }

  // Phase 4: Convert to output format
  const clusters: AggregatedCluster[] = [];
  for (const cluster of clusterMap.values()) {
    const dominantTypes = computeDominantTypes(cluster.signals);
    clusters.push({
      nodeIds: [...cluster.nodeIds],
      signals: cluster.signals,
      dominantTypes,
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the dominant signal types for a cluster.
 * Returns the types that appear most frequently (may be multiple if tied).
 */
function computeDominantTypes(signals: Signal[]): SignalType[] {
  const counts = new Map<SignalType, number>();
  for (const sig of signals) {
    counts.set(sig.type, (counts.get(sig.type) ?? 0) + 1);
  }

  if (counts.size === 0) return [];

  let maxCount = 0;
  for (const count of counts.values()) {
    if (count > maxCount) maxCount = count;
  }

  const dominant: SignalType[] = [];
  for (const [type, count] of counts) {
    if (count === maxCount) dominant.push(type);
  }

  return dominant;
}
