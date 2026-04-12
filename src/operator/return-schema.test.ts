import { describe, it, expect } from "vitest";
import {
  OperatorReturnSchema,
  OperatorOfferReturnSchema,
  OperatorResultReturnSchema,
  PageStateSchema,
  CardAnnotationSchema,
  PageTreeNodeSchema,
} from "./return-schema.js";
import type {
  OperatorOfferReturn,
  OperatorResultReturn,
} from "./return-schema.js";
import { ZodError } from "zod";

// ---------------------------------------------------------------------------
// Fixture Helpers
// ---------------------------------------------------------------------------

function makePageState() {
  return {
    title: "MCP Test Benchmark",
    url: "http://localhost:4242",
    state_summary: "Step 1/3 — 3x radio, button",
  };
}

function makeCardAnnotation() {
  return {
    name: "Login Form",
    description: "Fills credentials and submits the form",
    parameters: {
      username: { type: "string", description: "Username or email", required: true },
      password: { type: "string", description: "Password", required: true },
    },
    why_this_card: "Login Form (login-form): score 0.85 (threshold: 0.50) → MATCH\nmatched: role:form (0.6), type:password (0.9)",
  };
}

function makePageTreeNode(overrides?: Partial<ReturnType<typeof makeTreeNodeBase>>) {
  return { ...makeTreeNodeBase(), ...overrides };
}

function makeTreeNodeBase() {
  return {
    ref: "e12",
    role: "form",
    name: "Login",
  };
}

function makeValidOffer(): OperatorOfferReturn {
  return {
    mode: "offer",
    page_state: makePageState(),
    page_tree: [
      {
        ref: "e1",
        role: "main",
        children: [
          {
            ...makePageTreeNode(),
            card: makeCardAnnotation(),
          },
        ],
      },
    ],
    cards_found: 1,
    hint: "Full tree: call read_page",
    schema_version: "1.0",
    source: "operator",
  };
}

function makeValidResult(): OperatorResultReturn {
  return {
    mode: "result",
    execution_summary: "Login Form completed: username=test, password=secret",
    steps_completed: 3,
    steps_total: 3,
    page_state: {
      title: "Dashboard",
      url: "http://localhost:4242/dashboard",
      state_summary: "Welcome page — button, 2x link",
    },
    schema_version: "1.0",
    source: "operator",
  };
}

// ---------------------------------------------------------------------------
// Task 6 — Unit Tests Return Schema
// ---------------------------------------------------------------------------

describe("return-schema", () => {
  // Subtask 6.1: Valides Offer-Objekt parst fehlerfrei
  describe("OperatorOfferReturnSchema", () => {
    it("parses a valid offer object without errors", () => {
      const offer = makeValidOffer();
      const parsed = OperatorOfferReturnSchema.parse(offer);
      expect(parsed.mode).toBe("offer");
      expect(parsed.cards_found).toBe(1);
      expect(parsed.schema_version).toBe("1.0");
      expect(parsed.source).toBe("operator");
    });

    it("parses an offer with no cards and no hidden sections", () => {
      const offer = makeValidOffer();
      offer.page_tree = [];
      offer.cards_found = 0;
      const parsed = OperatorOfferReturnSchema.parse(offer);
      expect(parsed.cards_found).toBe(0);
      expect(parsed.page_tree).toEqual([]);
    });

    it("parses an offer with hidden_sections", () => {
      const offer = makeValidOffer();
      offer.page_state.hidden_sections = ["Step 2 (#company)", "Step 3 (complete)"];
      const parsed = OperatorOfferReturnSchema.parse(offer);
      expect(parsed.page_state.hidden_sections).toHaveLength(2);
    });
  });

  // Subtask 6.2: Valides Result-Objekt parst fehlerfrei
  describe("OperatorResultReturnSchema", () => {
    it("parses a valid result object without errors", () => {
      const result = makeValidResult();
      const parsed = OperatorResultReturnSchema.parse(result);
      expect(parsed.mode).toBe("result");
      expect(parsed.steps_completed).toBe(3);
      expect(parsed.steps_total).toBe(3);
    });

    it("parses a result with error field (partial execution)", () => {
      const result = makeValidResult();
      result.steps_completed = 2;
      result.error = "Step 3 failed: element not found";
      const parsed = OperatorResultReturnSchema.parse(result);
      expect(parsed.error).toBe("Step 3 failed: element not found");
      expect(parsed.steps_completed).toBe(2);
    });
  });

  // Subtask 6.3: Discriminator unterscheidet korrekt
  describe("OperatorReturnSchema (discriminated union)", () => {
    it("discriminates offer from result via mode field", () => {
      const offer = makeValidOffer();
      const result = makeValidResult();

      const parsedOffer = OperatorReturnSchema.parse(offer);
      const parsedResult = OperatorReturnSchema.parse(result);

      expect(parsedOffer.mode).toBe("offer");
      expect(parsedResult.mode).toBe("result");

      // Type narrowing via mode
      if (parsedOffer.mode === "offer") {
        expect(parsedOffer.cards_found).toBe(1);
      }
      if (parsedResult.mode === "result") {
        expect(parsedResult.execution_summary).toContain("Login Form");
      }
    });

    it("rejects an object with invalid mode", () => {
      const invalid = { ...makeValidOffer(), mode: "unknown" };
      expect(() => OperatorReturnSchema.parse(invalid)).toThrow(ZodError);
    });
  });

  // Subtask 6.4: Fehlendes Pflichtfeld wirft ZodError
  describe("missing required fields", () => {
    it("throws ZodError when page_state is missing from offer", () => {
      const offer = makeValidOffer();
      const { page_state: _, ...offerWithout } = offer;
      expect(() => OperatorOfferReturnSchema.parse(offerWithout)).toThrow(ZodError);
    });

    it("throws ZodError when execution_summary is missing from result", () => {
      const result = makeValidResult();
      const { execution_summary: _, ...resultWithout } = result;
      expect(() => OperatorResultReturnSchema.parse(resultWithout)).toThrow(ZodError);
    });

    it("throws ZodError when title is missing from page_state", () => {
      const state = makePageState();
      const { title: _, ...stateWithout } = state;
      expect(() => PageStateSchema.parse(stateWithout)).toThrow(ZodError);
    });

    it("throws ZodError when ref is missing from page tree node", () => {
      const node = makePageTreeNode();
      const { ref: _, ...nodeWithout } = node;
      expect(() => PageTreeNodeSchema.parse(nodeWithout)).toThrow(ZodError);
    });
  });

  // Subtask 6.5: schema_version und source sind Pflichtfelder
  describe("schema_version and source are required", () => {
    it("throws ZodError when schema_version is missing", () => {
      const offer = makeValidOffer();
      const { schema_version: _, ...offerWithout } = offer;
      expect(() => OperatorOfferReturnSchema.parse(offerWithout)).toThrow(ZodError);
    });

    it("throws ZodError when source is missing", () => {
      const result = makeValidResult();
      const { source: _, ...resultWithout } = result;
      expect(() => OperatorResultReturnSchema.parse(resultWithout)).toThrow(ZodError);
    });

    it("rejects wrong schema_version value", () => {
      const offer = { ...makeValidOffer(), schema_version: "2.0" };
      expect(() => OperatorOfferReturnSchema.parse(offer)).toThrow(ZodError);
    });

    it("rejects wrong source value", () => {
      const result = { ...makeValidResult(), source: "custom" };
      expect(() => OperatorResultReturnSchema.parse(result)).toThrow(ZodError);
    });
  });

  // Subtask 6.6: error-Feld in Result ist optional — abwesend bei Erfolg
  describe("error field optionality", () => {
    it("result without error field parses successfully", () => {
      const result = makeValidResult();
      expect(result.error).toBeUndefined();
      const parsed = OperatorResultReturnSchema.parse(result);
      expect(parsed.error).toBeUndefined();
    });

    it("result with error field parses successfully", () => {
      const result = { ...makeValidResult(), steps_completed: 1, error: "timeout on step 2" };
      const parsed = OperatorResultReturnSchema.parse(result);
      expect(parsed.error).toBe("timeout on step 2");
    });

    it("rejects empty string as error (min length 1)", () => {
      const result = { ...makeValidResult(), error: "" };
      expect(() => OperatorResultReturnSchema.parse(result)).toThrow(ZodError);
    });
  });

  // Subtask 6.7: card-Feld an PageTreeNode ist optional
  describe("card field optionality on PageTreeNode", () => {
    it("tree node without card field parses successfully", () => {
      const node = makePageTreeNode();
      const parsed = PageTreeNodeSchema.parse(node);
      expect(parsed.card).toBeUndefined();
    });

    it("tree node with card field parses successfully", () => {
      const node = { ...makePageTreeNode(), card: makeCardAnnotation() };
      const parsed = PageTreeNodeSchema.parse(node);
      expect(parsed.card).toBeDefined();
      expect(parsed.card!.name).toBe("Login Form");
    });
  });

  // Subtask 6.8: Rekursive children bis Tiefe 3
  describe("recursive children in PageTreeNode", () => {
    it("handles depth 3 recursion", () => {
      const depth3Node = {
        ref: "e3",
        role: "button",
        name: "Submit",
      };
      const depth2Node = {
        ref: "e2",
        role: "group",
        children: [depth3Node],
      };
      const depth1Node = {
        ref: "e1",
        role: "form",
        children: [depth2Node],
      };

      const parsed = PageTreeNodeSchema.parse(depth1Node);
      expect(parsed.children).toHaveLength(1);
      expect(parsed.children![0]!.children).toHaveLength(1);
      expect(parsed.children![0]!.children![0]!.ref).toBe("e3");
    });

    it("handles empty children array", () => {
      const node = { ...makePageTreeNode(), children: [] };
      const parsed = PageTreeNodeSchema.parse(node);
      expect(parsed.children).toEqual([]);
    });
  });

  // Additional schema strictness tests
  describe("strict mode rejects unknown fields", () => {
    it("rejects unknown field on PageState", () => {
      const state = { ...makePageState(), extra_field: "nope" };
      expect(() => PageStateSchema.parse(state)).toThrow(ZodError);
    });

    it("rejects unknown field on CardAnnotation", () => {
      const card = { ...makeCardAnnotation(), score: 0.9 };
      expect(() => CardAnnotationSchema.parse(card)).toThrow(ZodError);
    });

    it("rejects unknown field on OperatorOfferReturn", () => {
      const offer = { ...makeValidOffer(), extra: true };
      expect(() => OperatorOfferReturnSchema.parse(offer)).toThrow(ZodError);
    });
  });
});
