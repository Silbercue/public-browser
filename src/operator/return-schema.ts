/**
 * Operator Return Schema — Zod validation for operator return payloads.
 *
 * Validates both return modes (offer/result) using a discriminated union.
 * All returns are parsed through this schema before serialization to
 * guarantee type safety and catch bugs early (AC-8).
 *
 * JSON field convention: snake_case throughout.
 * Schema naming convention: {Name}Schema (e.g. PageStateSchema).
 *
 * Module Boundaries:
 *   - MAY import: zod
 *   - Consumed by: return-builder.ts, return-serializer.ts, operator-tool.ts (Story 19.7)
 *   - MUST NOT import: src/tools/, src/scan/, src/cards/, src/cache/
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// ---------------------------------------------------------------------------

/**
 * Maximum character length for why_this_card audit string.
 * Derived from MAX_WHY_THIS_CARD_TOKENS (400) * ~4 chars/token.
 */
const MAX_WHY_THIS_CARD_CHARS = 1600;

// ---------------------------------------------------------------------------
// Sub-Schemas
// ---------------------------------------------------------------------------

/**
 * Compact page state: title, URL, visible summary, hidden sections.
 */
export const PageStateSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  state_summary: z.string().min(1),
  hidden_sections: z.array(z.string()).optional(),
}).strict();

/**
 * Card parameter schema entry — type, description, required flag.
 */
const CardParameterSchema = z.object({
  type: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
}).strict();

/**
 * Card annotation attached to a page tree node.
 * Contains name, description, parameter schema, and match audit.
 */
export const CardAnnotationSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), CardParameterSchema),
  why_this_card: z.string().max(MAX_WHY_THIS_CARD_CHARS),
}).strict();

/**
 * Explicit PageTreeNode interface for the recursive Zod type annotation.
 * Avoids TypeScript inference issues with z.lazy() + unknown[] depth.
 */
interface PageTreeNodeShape {
  ref: string;
  role: string;
  name?: string;
  children?: PageTreeNodeShape[];
  card?: z.infer<typeof CardAnnotationSchema>;
}

/**
 * Recursive page tree node — interactive elements + landmarks with ref handles.
 * Card annotation is optional (present only when a card matched this node).
 */
export const PageTreeNodeSchema: z.ZodType<PageTreeNodeShape> = z.lazy(() =>
  z.object({
    ref: z.string().min(1),
    role: z.string().min(1),
    name: z.string().optional(),
    children: z.array(PageTreeNodeSchema).optional(),
    card: CardAnnotationSchema.optional(),
  }).strict(),
);

// ---------------------------------------------------------------------------
// Return Mode Schemas (AC-1, AC-7)
// ---------------------------------------------------------------------------

/**
 * Karten-Angebot — mode: "offer".
 * Page state + annotated page tree + card count + escape-hatch hint.
 */
export const OperatorOfferReturnSchema = z.object({
  mode: z.literal("offer"),
  page_state: PageStateSchema,
  page_tree: z.array(PageTreeNodeSchema),
  cards_found: z.number().int().min(0),
  hint: z.string().min(1),
  schema_version: z.literal("1.0"),
  source: z.literal("operator"),
}).strict();

/**
 * Karten-Ergebnis — mode: "result".
 * Execution summary + step counts + new page state + optional error.
 */
export const OperatorResultReturnSchema = z.object({
  mode: z.literal("result"),
  execution_summary: z.string().min(1),
  steps_completed: z.number().int().min(0),
  steps_total: z.number().int().min(1),
  page_state: PageStateSchema,
  error: z.string().min(1).optional(),
  schema_version: z.literal("1.0"),
  source: z.literal("operator"),
}).strict();

// ---------------------------------------------------------------------------
// Discriminated Union (AC-1, AC-8)
// ---------------------------------------------------------------------------

/**
 * Top-level operator return schema — discriminated union on `mode` field.
 * Both modes share schema_version and source for forward-compatibility.
 */
export const OperatorReturnSchema = z.discriminatedUnion("mode", [
  OperatorOfferReturnSchema,
  OperatorResultReturnSchema,
]);

// ---------------------------------------------------------------------------
// Type Exports (AC-8)
// ---------------------------------------------------------------------------

/** TypeScript type inferred from the Zod schema. */
export type OperatorReturn = z.infer<typeof OperatorReturnSchema>;
export type OperatorOfferReturn = z.infer<typeof OperatorOfferReturnSchema>;
export type OperatorResultReturn = z.infer<typeof OperatorResultReturnSchema>;
export type PageState = z.infer<typeof PageStateSchema>;
export type CardAnnotation = z.infer<typeof CardAnnotationSchema>;
export type PageTreeNode = z.infer<typeof PageTreeNodeSchema>;
