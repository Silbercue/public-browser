import { describe, it, expect } from "vitest";
import type { AXNode } from "../cache/a11y-tree.js";
import type { MatchResult, AggregatedCluster } from "../scan/match-types.js";
import type { Signal } from "../scan/signal-types.js";
import {
  buildOfferReturn,
  buildResultReturn,
  MAX_OFFER_TOKENS,
  MAX_RESULT_TOKENS,
} from "./return-builder.js";
import type { AnnotatedMatch, PageContext, CardInfo } from "./return-builder.js";

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

function makeAXNode(overrides: Partial<AXNode>): AXNode {
  return {
    nodeId: "node-1",
    ignored: false,
    ...overrides,
  };
}

function makePageContext(): PageContext {
  return {
    title: "MCP Test Benchmark",
    url: "http://localhost:4242",
  };
}

function makeLoginFormCardInfo(): CardInfo {
  return {
    id: "login-form",
    name: "Login Form",
    description: "Fills credentials and submits the form",
    parameters: {
      username: { type: "string", description: "Username or email", required: true },
      password: { type: "string", description: "Password", required: true },
    },
  };
}

function makeSearchCardInfo(): CardInfo {
  return {
    id: "search-result-list",
    name: "Search Result List",
    description: "Extracts search results from a list",
    parameters: {
      query: { type: "string", description: "Search query", required: false },
    },
  };
}

function makeMatchResult(overrides: Partial<MatchResult>): MatchResult {
  return {
    cardId: "login-form",
    cardName: "Login Form",
    matched: true,
    score: 0.85,
    threshold: 0.5,
    signal_breakdown: [
      { signal: "role:form", weight: 0.6, matched: true, found_count: 1 },
      { signal: "type:password", weight: 0.9, matched: true, found_count: 1 },
    ],
    counter_signal_checks: [],
    schema_version: "1.0",
    source: "a11y-tree",
    ...overrides,
  };
}

function makeCluster(nodeIds: string[]): AggregatedCluster {
  return {
    nodeIds,
    signals: nodeIds.map((nid) => ({
      type: "role" as const,
      signal: "role:form",
      nodeId: nid,
      weight: 0.6,
    })),
    dominantTypes: ["role"],
  };
}

function makeAnnotatedMatch(overrides?: {
  matchResult?: Partial<MatchResult>;
  cardInfo?: CardInfo;
  cluster?: AggregatedCluster;
}): AnnotatedMatch {
  return {
    matchResult: makeMatchResult(overrides?.matchResult ?? {}),
    cardInfo: overrides?.cardInfo ?? makeLoginFormCardInfo(),
    cluster: overrides?.cluster ?? makeCluster(["node-form"]),
  };
}

/**
 * Build a minimal A11y-Tree with a main landmark containing a form.
 */
function makeLoginFormNodes(): AXNode[] {
  return [
    makeAXNode({
      nodeId: "node-root",
      role: { type: "role", value: "WebArea" },
      name: { type: "string", value: "Test Page" },
      childIds: ["node-main"],
    }),
    makeAXNode({
      nodeId: "node-main",
      role: { type: "role", value: "main" },
      parentId: "node-root",
      childIds: ["node-form"],
    }),
    makeAXNode({
      nodeId: "node-form",
      role: { type: "role", value: "form" },
      name: { type: "string", value: "Login" },
      parentId: "node-main",
      childIds: ["node-user", "node-pass", "node-submit"],
    }),
    makeAXNode({
      nodeId: "node-user",
      role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Username" },
      parentId: "node-form",
    }),
    makeAXNode({
      nodeId: "node-pass",
      role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Password" },
      parentId: "node-form",
    }),
    makeAXNode({
      nodeId: "node-submit",
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Sign In" },
      parentId: "node-form",
    }),
  ];
}

/**
 * Build nodes with multiple sections — login form + search results.
 */
function makeMultiSectionNodes(): AXNode[] {
  return [
    makeAXNode({
      nodeId: "node-root",
      role: { type: "role", value: "WebArea" },
      name: { type: "string", value: "Multi Page" },
      childIds: ["node-main"],
    }),
    makeAXNode({
      nodeId: "node-main",
      role: { type: "role", value: "main" },
      parentId: "node-root",
      childIds: ["node-form", "node-search"],
    }),
    makeAXNode({
      nodeId: "node-form",
      role: { type: "role", value: "form" },
      name: { type: "string", value: "Login" },
      parentId: "node-main",
      childIds: ["node-user"],
    }),
    makeAXNode({
      nodeId: "node-user",
      role: { type: "role", value: "textbox" },
      name: { type: "string", value: "Username" },
      parentId: "node-form",
    }),
    makeAXNode({
      nodeId: "node-search",
      role: { type: "role", value: "search" },
      name: { type: "string", value: "Search Results" },
      parentId: "node-main",
      childIds: ["node-search-btn"],
    }),
    makeAXNode({
      nodeId: "node-search-btn",
      role: { type: "role", value: "button" },
      name: { type: "string", value: "Search" },
      parentId: "node-search",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Task 7 — Unit Tests Return Builder
// ---------------------------------------------------------------------------

describe("return-builder", () => {
  // Subtask 7.2: buildOfferReturn() haengt Karten-Annotation an die richtige Node
  describe("buildOfferReturn", () => {
    it("attaches card annotation to the form node, not root", () => {
      const nodes = makeLoginFormNodes();
      const match = makeAnnotatedMatch({
        cluster: makeCluster(["node-form"]),
      });

      const offer = buildOfferReturn(makePageContext(), [match], nodes);

      expect(offer.mode).toBe("offer");
      expect(offer.cards_found).toBe(1);

      // Find the form node in the tree
      const formNode = findNodeInTree(offer.page_tree, "node-form");
      expect(formNode).toBeDefined();
      expect(formNode!.card).toBeDefined();
      expect(formNode!.card!.name).toBe("Login Form");

      // Root should NOT have a card
      const mainNode = findNodeInTree(offer.page_tree, "node-main");
      if (mainNode) {
        expect(mainNode.card).toBeUndefined();
      }
    });

    // Subtask 7.3: Mehrere Karten an verschiedenen Nodes
    it("places multiple cards at different nodes", () => {
      const nodes = makeMultiSectionNodes();
      const loginMatch = makeAnnotatedMatch({
        matchResult: { cardId: "login-form", cardName: "Login Form" },
        cardInfo: makeLoginFormCardInfo(),
        cluster: makeCluster(["node-form"]),
      });
      const searchMatch = makeAnnotatedMatch({
        matchResult: { cardId: "search-result-list", cardName: "Search Result List" },
        cardInfo: makeSearchCardInfo(),
        cluster: makeCluster(["node-search"]),
      });

      const offer = buildOfferReturn(makePageContext(), [loginMatch, searchMatch], nodes);

      expect(offer.cards_found).toBe(2);

      const formNode = findNodeInTree(offer.page_tree, "node-form");
      const searchNode = findNodeInTree(offer.page_tree, "node-search");

      expect(formNode?.card?.name).toBe("Login Form");
      expect(searchNode?.card?.name).toBe("Search Result List");
    });

    // Subtask 7.4: Seite ohne Match → cards_found: 0
    it("returns cards_found: 0 when no cards match", () => {
      const nodes = makeLoginFormNodes();
      const offer = buildOfferReturn(makePageContext(), [], nodes);

      expect(offer.cards_found).toBe(0);

      // No card annotations anywhere in the tree
      const annotated = collectAllCards(offer.page_tree);
      expect(annotated).toHaveLength(0);
    });

    // Subtask 7.5: page_state enthaelt Titel und URL
    it("includes title and URL in page_state", () => {
      const ctx = makePageContext();
      const offer = buildOfferReturn(ctx, [], makeLoginFormNodes());

      expect(offer.page_state.title).toBe(ctx.title);
      expect(offer.page_state.url).toBe(ctx.url);
    });

    // Subtask 7.6: hidden_sections aus dem A11y-Tree
    it("derives hidden_sections from ignored landmark nodes", () => {
      const nodes = [
        ...makeLoginFormNodes(),
        makeAXNode({
          nodeId: "node-hidden-region",
          ignored: true,
          role: { type: "role", value: "region" },
          name: { type: "string", value: "Step 2 (company)" },
          parentId: "node-root",
        }),
        makeAXNode({
          nodeId: "node-hidden-dialog",
          ignored: true,
          role: { type: "role", value: "dialog" },
          name: { type: "string", value: "Confirmation Dialog" },
          parentId: "node-root",
        }),
      ];

      const offer = buildOfferReturn(makePageContext(), [], nodes);

      expect(offer.page_state.hidden_sections).toBeDefined();
      expect(offer.page_state.hidden_sections).toContain("Step 2 (company)");
      expect(offer.page_state.hidden_sections).toContain("Confirmation Dialog");
    });

    it("omits hidden_sections when none detected", () => {
      const offer = buildOfferReturn(makePageContext(), [], makeLoginFormNodes());
      expect(offer.page_state.hidden_sections).toBeUndefined();
    });

    it("includes schema_version and source", () => {
      const offer = buildOfferReturn(makePageContext(), [], makeLoginFormNodes());
      expect(offer.schema_version).toBe("1.0");
      expect(offer.source).toBe("operator");
    });

    it("includes hint text", () => {
      const offer = buildOfferReturn(makePageContext(), [], makeLoginFormNodes());
      expect(offer.hint).toBe("Full tree: call read_page");
    });
  });

  // Subtask 7.7-7.9: buildResultReturn()
  describe("buildResultReturn", () => {
    // Subtask 7.7: Voller Erfolg — kein error
    it("returns no error field on full success", () => {
      const result = buildResultReturn(
        "Login Form",
        { username: "test", password: "secret" },
        3,
        3,
        makePageContext(),
        makeLoginFormNodes(),
      );

      expect(result.mode).toBe("result");
      expect(result.steps_completed).toBe(3);
      expect(result.steps_total).toBe(3);
      expect(result.error).toBeUndefined();
    });

    // Subtask 7.8: Partieller Fehlschlag — error vorhanden
    it("includes error field on partial execution", () => {
      const result = buildResultReturn(
        "Login Form",
        { username: "test", password: "secret" },
        2,
        3,
        makePageContext(),
        makeLoginFormNodes(),
        "Step 3 failed: submit button not found",
      );

      expect(result.error).toBe("Step 3 failed: submit button not found");
      expect(result.steps_completed).toBe(2);
      expect(result.steps_total).toBe(3);
    });

    // Subtask 7.9: execution_summary enthaelt Kartenname und Parameter
    it("includes card name and parameters in execution_summary", () => {
      const result = buildResultReturn(
        "Login Form",
        { username: "test", password: "secret" },
        3,
        3,
        makePageContext(),
        makeLoginFormNodes(),
      );

      expect(result.execution_summary).toContain("Login Form");
      expect(result.execution_summary).toContain("username=test");
      expect(result.execution_summary).toContain("password=secret");
      expect(result.execution_summary).toContain("completed");
    });

    it("shows partial summary when steps incomplete", () => {
      const result = buildResultReturn(
        "Login Form",
        { username: "test" },
        1,
        3,
        makePageContext(),
        makeLoginFormNodes(),
        "timeout",
      );

      expect(result.execution_summary).toContain("partial");
      expect(result.execution_summary).toContain("1/3");
    });

    it("includes schema_version and source", () => {
      const result = buildResultReturn(
        "Login Form",
        {},
        1,
        1,
        makePageContext(),
        makeLoginFormNodes(),
      );

      expect(result.schema_version).toBe("1.0");
      expect(result.source).toBe("operator");
    });

    // M2 fix: partial execution without explicit error — must still have error field
    it("auto-generates error field when partial but no error provided", () => {
      const result = buildResultReturn(
        "Login Form",
        { username: "test" },
        2,
        5,
        makePageContext(),
        makeLoginFormNodes(),
        // no error argument
      );

      expect(result.steps_completed).toBe(2);
      expect(result.steps_total).toBe(5);
      // H3: error must always be present when partial
      expect(result.error).toBeDefined();
      expect(result.error).toContain("2");
      expect(result.error).toContain("5");
    });

    it("drops error field even when provided if steps are complete", () => {
      // AC-5: error only when steps_completed < steps_total
      const result = buildResultReturn(
        "Login Form",
        {},
        3,
        3,
        makePageContext(),
        makeLoginFormNodes(),
        "spurious error",
      );

      expect(result.error).toBeUndefined();
    });

    it("handles no params gracefully", () => {
      const result = buildResultReturn(
        "Article Reader",
        {},
        2,
        2,
        makePageContext(),
        makeLoginFormNodes(),
      );

      expect(result.execution_summary).toContain("no params");
    });
  });

  // H4: ignored containers with visible children
  describe("ignored container traversal", () => {
    it("promotes visible children of ignored containers into the tree", () => {
      const nodes: AXNode[] = [
        makeAXNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          childIds: ["ignored-container"],
        }),
        makeAXNode({
          nodeId: "ignored-container",
          ignored: true,
          role: { type: "role", value: "group" },
          parentId: "root",
          childIds: ["visible-button"],
        }),
        makeAXNode({
          nodeId: "visible-button",
          role: { type: "role", value: "button" },
          name: { type: "string", value: "Click Me" },
          parentId: "ignored-container",
        }),
      ];

      const offer = buildOfferReturn(makePageContext(), [], nodes);

      // The button should appear in the tree even though its parent is ignored
      const btn = findNodeInTree(offer.page_tree, "visible-button");
      expect(btn).toBeDefined();
      expect(btn!.role).toBe("button");
      expect(btn!.name).toBe("Click Me");
    });
  });

  // C1: cluster root determination
  describe("cluster root determination", () => {
    it("annotates the shallowest node in cluster, not the first in nodeIds", () => {
      const nodes: AXNode[] = [
        makeAXNode({
          nodeId: "root",
          role: { type: "role", value: "WebArea" },
          childIds: ["main"],
        }),
        makeAXNode({
          nodeId: "main",
          role: { type: "role", value: "main" },
          parentId: "root",
          childIds: ["form-node"],
        }),
        makeAXNode({
          nodeId: "form-node",
          role: { type: "role", value: "form" },
          name: { type: "string", value: "Login" },
          parentId: "main",
          childIds: ["user-input"],
        }),
        makeAXNode({
          nodeId: "user-input",
          role: { type: "role", value: "textbox" },
          name: { type: "string", value: "Username" },
          parentId: "form-node",
        }),
      ];

      // nodeIds has the deeper node first — C1 bug would annotate "user-input"
      const match = makeAnnotatedMatch({
        cluster: makeCluster(["user-input", "form-node"]),
      });

      const offer = buildOfferReturn(makePageContext(), [match], nodes);

      // The card should be on the form (shallowest), not the textbox
      const formNode = findNodeInTree(offer.page_tree, "form-node");
      expect(formNode).toBeDefined();
      expect(formNode!.card).toBeDefined();
      expect(formNode!.card!.name).toBe("Login Form");

      const userNode = findNodeInTree(offer.page_tree, "user-input");
      if (userNode) {
        expect(userNode.card).toBeUndefined();
      }
    });
  });

  describe("page state derivation", () => {
    it("derives state_summary from visible interactive elements", () => {
      const nodes = makeLoginFormNodes();
      const offer = buildOfferReturn(makePageContext(), [], nodes);

      // Should mention textbox and button types
      expect(offer.page_state.state_summary).toBeTruthy();
      expect(offer.page_state.state_summary.length).toBeGreaterThan(5);
    });

    it("produces 'empty page' for nodes with no interactive elements", () => {
      const nodes = [
        makeAXNode({
          nodeId: "node-root",
          role: { type: "role", value: "WebArea" },
        }),
      ];
      const offer = buildOfferReturn(makePageContext(), [], nodes);
      expect(offer.page_state.state_summary).toBe("empty page");
    });

    it("includes heading in state_summary when available", () => {
      const nodes = [
        makeAXNode({
          nodeId: "node-root",
          role: { type: "role", value: "WebArea" },
          childIds: ["node-heading"],
        }),
        makeAXNode({
          nodeId: "node-heading",
          role: { type: "role", value: "heading" },
          name: { type: "string", value: "Welcome to Dashboard" },
          parentId: "node-root",
        }),
      ];
      const offer = buildOfferReturn(makePageContext(), [], nodes);
      expect(offer.page_state.state_summary).toContain("Welcome to Dashboard");
    });
  });
});

// ---------------------------------------------------------------------------
// Tree Helper Utilities
// ---------------------------------------------------------------------------

type TreeNode = { ref: string; role: string; name?: string; children?: TreeNode[]; card?: unknown };

function findNodeInTree(tree: TreeNode[], ref: string): TreeNode | undefined {
  for (const node of tree) {
    if (node.ref === ref) return node;
    if (node.children) {
      const found = findNodeInTree(node.children, ref);
      if (found) return found;
    }
  }
  return undefined;
}

function collectAllCards(tree: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(nodes: TreeNode[]): void {
    for (const node of nodes) {
      if (node.card) result.push(node);
      if (node.children) walk(node.children);
    }
  }
  walk(tree);
  return result;
}
