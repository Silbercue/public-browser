/**
 * Operator Return Builder — constructs validated return payloads.
 *
 * Two entry points:
 *   - buildOfferReturn()  — Karten-Angebot (mode: "offer")
 *   - buildResultReturn() — Karten-Ergebnis (mode: "result")
 *
 * Both functions validate their output through the Zod schema before
 * returning, ensuring runtime type safety (AC-8).
 *
 * Module Boundaries:
 *   - MAY import: src/scan/ (MatchResult, formatWhyThisCard, AggregatedCluster),
 *                 src/cache/ (AXNode), zod, return-schema.ts
 *   - MUST NOT import: src/tools/
 */

import type { AXNode } from "../cache/a11y-tree.js";
import type { MatchResult, AggregatedCluster } from "../scan/match-types.js";
import { formatWhyThisCard } from "../scan/matcher.js";
import {
  OperatorOfferReturnSchema,
  OperatorResultReturnSchema,
} from "./return-schema.js";
import type {
  OperatorOfferReturn,
  OperatorResultReturn,
  PageState,
  PageTreeNode,
  CardAnnotation,
} from "./return-schema.js";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// M3 fix: re-export from serializer to maintain public API compatibility.
// ---------------------------------------------------------------------------

// Re-export budget constants (canonical source: return-serializer.ts)
export { MAX_OFFER_TOKENS, MAX_RESULT_TOKENS } from "./return-serializer.js";

/** Maximum tree depth for the compact page tree. */
export const MAX_TREE_DEPTH = 3;

/** Escape-hatch hint text for the LLM. */
const OFFER_HINT_TEXT = "Full tree: call read_page";

// ---------------------------------------------------------------------------
// Types for Builder Input
// ---------------------------------------------------------------------------

/**
 * Page context from tab info — URL and title.
 * Passed by the caller (operator-tool.ts in Story 19.7).
 */
export interface PageContext {
  title: string;
  url: string;
}

/**
 * Card info needed for annotations — card name, description, and parameters.
 * Satisfied by the Card type from src/cards/card-schema.ts.
 */
export interface CardInfo {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required: boolean }>;
}

/**
 * Combined match result with card info and cluster assignment.
 * The caller (Story 19.7) builds this by joining MatchResult + Card + Cluster.
 */
export interface AnnotatedMatch {
  /** The match result from the matcher */
  matchResult: MatchResult;
  /** The full card info (name, description, parameters) */
  cardInfo: CardInfo;
  /** The cluster this match belongs to (for node assignment) */
  cluster: AggregatedCluster;
}

// ---------------------------------------------------------------------------
// ARIA Roles considered interactive or landmark (for tree filtering)
// ---------------------------------------------------------------------------

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button", "textbox", "checkbox", "radio", "combobox", "listbox",
  "menuitem", "tab", "link", "searchbox", "slider", "spinbutton",
  "switch", "menuitemcheckbox", "menuitemradio", "option",
]);

const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "main", "navigation", "search", "form", "banner", "contentinfo",
  "complementary", "region",
]);

// ---------------------------------------------------------------------------
// Public API — Offer Builder
// ---------------------------------------------------------------------------

/**
 * Build a Karten-Angebot return payload (mode: "offer").
 *
 * Converts A11y-Tree nodes into a compact page tree, attaches card
 * annotations to the nodes where their clusters matched, and validates
 * the result through the Zod schema.
 *
 * @tokens max 2500
 * @param pageContext - Page title and URL from tab info
 * @param matches - Annotated match results (only matched cards, pre-filtered)
 * @param nodes - Raw A11y-Tree nodes for page tree construction
 * @returns Validated OperatorOfferReturn
 */
export function buildOfferReturn(
  pageContext: PageContext,
  matches: AnnotatedMatch[],
  nodes: AXNode[],
): OperatorOfferReturn {
  const pageState = buildPageState(pageContext, nodes);
  const pageTree = buildPageTree(nodes, matches);

  const result: OperatorOfferReturn = {
    mode: "offer",
    page_state: pageState,
    page_tree: pageTree,
    cards_found: matches.length,
    hint: OFFER_HINT_TEXT,
    schema_version: "1.0",
    source: "operator",
  };

  return OperatorOfferReturnSchema.parse(result) as OperatorOfferReturn;
}

// ---------------------------------------------------------------------------
// Public API — Result Builder
// ---------------------------------------------------------------------------

/**
 * Build a Karten-Ergebnis return payload (mode: "result").
 *
 * Creates a compact confirmation text with card name and parameters,
 * plus the new page state after execution.
 *
 * @tokens max 800
 * @param cardName - Name of the executed card
 * @param params - Parameters that were used for execution
 * @param stepsCompleted - Number of successfully completed steps
 * @param stepsTotal - Total number of steps in the execution sequence
 * @param pageContext - New page context after execution
 * @param nodes - New A11y-Tree nodes after execution (for page state)
 * @param error - Optional error description (only for partial execution)
 * @returns Validated OperatorResultReturn
 */
export function buildResultReturn(
  cardName: string,
  params: Record<string, string>,
  stepsCompleted: number,
  stepsTotal: number,
  pageContext: PageContext,
  nodes: AXNode[],
  error?: string,
): OperatorResultReturn {
  const pageState = buildPageState(pageContext, nodes);

  // Build execution summary
  const paramParts = Object.entries(params).map(([k, v]) => `${k}=${v}`);
  const paramStr = paramParts.length > 0 ? paramParts.join(", ") : "no params";

  let executionSummary: string;
  if (stepsCompleted >= stepsTotal) {
    executionSummary = `${cardName} completed: ${paramStr}`;
  } else {
    executionSummary = `${cardName} partial (${stepsCompleted}/${stepsTotal}): ${error ?? "unknown error"}`;
  }

  const result: OperatorResultReturn = {
    mode: "result",
    execution_summary: executionSummary,
    steps_completed: stepsCompleted,
    steps_total: stepsTotal,
    page_state: pageState,
    schema_version: "1.0",
    source: "operator",
  };

  // AC-5: error field present when steps_completed < steps_total.
  // H3 fix: auto-generate default error when partial but no error text provided.
  if (stepsCompleted < stepsTotal) {
    result.error = error || `Stopped after step ${stepsCompleted} of ${stepsTotal}`;
  }

  return OperatorResultReturnSchema.parse(result) as OperatorResultReturn;
}

// ---------------------------------------------------------------------------
// Internal — Page State Builder
// ---------------------------------------------------------------------------

/**
 * Build a PageState from page context and A11y-Tree nodes.
 * Derives state_summary from visible interactive elements and
 * hidden_sections from ignored/hidden nodes.
 */
function buildPageState(pageContext: PageContext, nodes: AXNode[]): PageState {
  const stateSummary = deriveStateSummary(nodes);
  const hiddenSections = deriveHiddenSections(nodes);

  const state: PageState = {
    title: pageContext.title,
    url: pageContext.url,
    state_summary: stateSummary,
  };

  if (hiddenSections.length > 0) {
    state.hidden_sections = hiddenSections;
  }

  return state;
}

/**
 * Derive a human-readable state summary from visible interactive elements.
 * Counts element types and finds headings/labels as state indicators.
 */
function deriveStateSummary(nodes: AXNode[]): string {
  const roleCounts = new Map<string, number>();
  let heading = "";

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value as string | undefined;
    if (!role) continue;

    // Capture first heading as state indicator
    if (role === "heading" && !heading && node.name?.value) {
      heading = String(node.name.value);
    }

    // Count interactive roles
    if (INTERACTIVE_ROLES.has(role)) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }

  // Build summary parts
  const parts: string[] = [];
  if (heading) {
    // Truncate long headings
    parts.push(heading.length > 50 ? heading.slice(0, 47) + "..." : heading);
  }

  // Summarize interactive element counts
  const interactiveParts: string[] = [];
  for (const [role, count] of roleCounts) {
    if (count > 1) {
      interactiveParts.push(`${count}x ${role}`);
    } else {
      interactiveParts.push(role);
    }
  }

  if (interactiveParts.length > 0) {
    parts.push(interactiveParts.join(", "));
  }

  return parts.length > 0 ? parts.join(" — ") : "empty page";
}

/**
 * Derive hidden sections from A11y-Tree nodes.
 * Looks for landmark/region nodes that are ignored (aria-hidden or display:none)
 * and extracts their names as hidden section identifiers.
 */
function deriveHiddenSections(nodes: AXNode[]): string[] {
  const hidden: string[] = [];
  const HIDDEN_DETECTABLE_ROLES: ReadonlySet<string> = new Set([
    "region", "form", "navigation", "complementary", "tabpanel",
    "dialog", "group",
  ]);

  for (const node of nodes) {
    if (!node.ignored) continue;
    const role = node.role?.value as string | undefined;
    if (!role || !HIDDEN_DETECTABLE_ROLES.has(role)) continue;

    const name = node.name?.value as string | undefined;
    if (name) {
      hidden.push(name);
    }
  }

  return hidden;
}

// ---------------------------------------------------------------------------
// Internal — Page Tree Builder
// ---------------------------------------------------------------------------

/**
 * Build a compact page tree from A11y-Tree nodes.
 * Only includes interactive elements + landmarks, with ref handles.
 * Attaches card annotations to nodes whose clusters match.
 */
function buildPageTree(nodes: AXNode[], matches: AnnotatedMatch[]): PageTreeNode[] {
  // Build node lookup by nodeId
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Build cluster-root → annotation mapping (C1: uses nodeMap for true root)
  const clusterAnnotations = buildClusterAnnotations(matches, nodeMap);

  // Build tree from root nodes (nodes without parentId or with unknown parentId)
  const rootNodeIds = findRootNodes(nodes, nodeMap);
  const tree = buildTreeRecursive(rootNodeIds, nodeMap, clusterAnnotations, 0);

  return tree;
}

/**
 * Build a map from cluster root nodeId to CardAnnotation.
 * For each matched card, finds the true root of the cluster (the node
 * with the shallowest depth) and keys the annotation by that nodeId.
 *
 * C1 fix: cluster.nodeIds order is arbitrary — we must find the actual
 * root by computing depth via parentId chains.
 */
function buildClusterAnnotations(
  matches: AnnotatedMatch[],
  nodeMap: Map<string, AXNode>,
): Map<string, CardAnnotation> {
  const annotations = new Map<string, CardAnnotation>();

  for (const match of matches) {
    if (!match.matchResult.matched) continue;

    const annotation: CardAnnotation = {
      name: match.cardInfo.name,
      description: match.cardInfo.description,
      parameters: match.cardInfo.parameters,
      why_this_card: formatWhyThisCard(match.matchResult),
    };

    // Find the true root: shallowest node in the cluster
    const rootNodeId = findClusterRoot(match.cluster.nodeIds, nodeMap);
    if (rootNodeId) {
      annotations.set(rootNodeId, annotation);
    }
  }

  return annotations;
}

/**
 * Find the cluster root — the node with the shallowest depth (fewest
 * parentId hops to the tree root). Ties broken by first occurrence.
 */
function findClusterRoot(nodeIds: string[], nodeMap: Map<string, AXNode>): string | undefined {
  if (nodeIds.length === 0) return undefined;
  if (nodeIds.length === 1) return nodeIds[0];

  let bestId: string | undefined;
  let bestDepth = Infinity;

  for (const nid of nodeIds) {
    const depth = computeDepth(nid, nodeMap);
    if (depth < bestDepth) {
      bestDepth = depth;
      bestId = nid;
    }
  }

  return bestId;
}

/**
 * Compute depth of a node by walking parentId chain.
 * Returns 0 for root nodes, guards against cycles with a max iteration limit.
 */
function computeDepth(nodeId: string, nodeMap: Map<string, AXNode>): number {
  let depth = 0;
  let current = nodeMap.get(nodeId);
  const MAX_DEPTH = 100; // cycle guard
  while (current?.parentId && nodeMap.has(current.parentId) && depth < MAX_DEPTH) {
    depth++;
    current = nodeMap.get(current.parentId);
  }
  return depth;
}

/**
 * Find root-level nodes (no parentId or parent not in the node set).
 */
function findRootNodes(nodes: AXNode[], nodeMap: Map<string, AXNode>): string[] {
  const roots: string[] = [];
  for (const node of nodes) {
    if (!node.parentId || !nodeMap.has(node.parentId)) {
      roots.push(node.nodeId);
    }
  }
  return roots;
}

/**
 * Recursively build tree nodes, filtering to interactive + landmark roles.
 * Stops at MAX_TREE_DEPTH. Attaches card annotations from cluster mapping.
 */
function buildTreeRecursive(
  nodeIds: string[],
  nodeMap: Map<string, AXNode>,
  clusterAnnotations: Map<string, CardAnnotation>,
  depth: number,
): PageTreeNode[] {
  if (depth >= MAX_TREE_DEPTH) return [];

  const result: PageTreeNode[] = [];

  for (const nodeId of nodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    // H4 fix: ignored containers are skipped as nodes, but their children
    // are still traversed so visible descendants are not lost.
    if (node.ignored) {
      const childIds = node.childIds ?? [];
      if (childIds.length > 0) {
        const promotedChildren = buildTreeRecursive(childIds, nodeMap, clusterAnnotations, depth);
        result.push(...promotedChildren);
      }
      continue;
    }

    const role = node.role?.value as string | undefined;
    if (!role) continue;

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isLandmark = LANDMARK_ROLES.has(role);

    // Get children
    const childIds = node.childIds ?? [];
    const childNodes = buildTreeRecursive(childIds, nodeMap, clusterAnnotations, depth + 1);

    // Check for card annotation on this node
    const card = clusterAnnotations.get(nodeId);

    // Include node if it's interactive, landmark, has children, or has a card
    if (isInteractive || isLandmark || childNodes.length > 0 || card) {
      const treeNode: PageTreeNode = {
        ref: nodeId,
        role,
      };

      const name = node.name?.value as string | undefined;
      if (name) {
        treeNode.name = name;
      }

      if (childNodes.length > 0) {
        treeNode.children = childNodes;
      }

      if (card) {
        treeNode.card = card;
      }

      result.push(treeNode);
    }
  }

  return result;
}
