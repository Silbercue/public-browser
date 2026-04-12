/**
 * Operator Return Types — Re-exports from Zod Schema.
 *
 * M4 fix: This file re-exports all types from return-schema.ts (the Zod-inferred
 * source of truth) to prevent drift between manually-written interfaces and
 * Zod-inferred types. Consumers that only need types can import from either file.
 *
 * Module Boundaries:
 *   - MAY import: return-schema.ts (types only)
 *   - Consumed by: operator-tool.ts (Story 19.7), external consumers
 *   - MUST NOT import: src/tools/, src/scan/, src/cards/, src/cache/
 */

export type {
  PageState,
  CardAnnotation,
  PageTreeNode,
  OperatorOfferReturn,
  OperatorResultReturn,
  OperatorReturn,
} from "./return-schema.js";
