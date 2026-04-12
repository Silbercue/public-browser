/**
 * Operator Return Serializer — text serialization for MCP tool responses.
 *
 * Produces the Variante-C text format that the LLM receives as tool output.
 * Two entry points:
 *   - serializeOfferReturn()  — Karten-Angebot text format
 *   - serializeResultReturn() — Karten-Ergebnis text format
 *
 * Both serializers enforce token budgets and truncate gracefully when
 * the payload would exceed the limit.
 *
 * Module Boundaries:
 *   - MAY import: return-schema.ts (types only)
 *   - MUST NOT import: src/tools/, src/scan/, src/cards/, src/cache/
 */

import type {
  OperatorOfferReturn,
  OperatorResultReturn,
  PageTreeNode,
} from "./return-schema.js";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit)
// M3 fix: budget constants are self-contained, no import from return-builder.
// ---------------------------------------------------------------------------

/** Maximum token budget for the offer return payload (~4 chars/token). */
export const MAX_OFFER_TOKENS = 2500;

/** Maximum token budget for the result return payload (~4 chars/token). */
export const MAX_RESULT_TOKENS = 800;

/** Chars-per-token estimate for budget calculations. */
const CHARS_PER_TOKEN = 4;

/** Maximum chars for offer serialization. */
const MAX_OFFER_CHARS = MAX_OFFER_TOKENS * CHARS_PER_TOKEN;

/** Maximum chars for result serialization. */
const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * CHARS_PER_TOKEN;

// ---------------------------------------------------------------------------
// Public API — Offer Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a Karten-Angebot into the Variante-C text format.
 *
 * Format:
 * ```
 * === OPERATOR ===
 * Page: {title}
 * State: {state_summary}
 * Hidden: {hidden_sections}
 *
 * Cards:
 *   [{ref}] {card_name} ({card_description})
 *     params: {param_name} ({type}, {required?}), ...
 *     match: {why_this_card}
 *
 * Full tree: call read_page
 * ================
 * ```
 *
 * @param offer - Validated OperatorOfferReturn
 * @returns Text string for MCP tool response content block
 */
export function serializeOfferReturn(offer: OperatorOfferReturn): string {
  const lines: string[] = [];

  // Header
  lines.push("=== OPERATOR ===");
  lines.push(`Page: ${offer.page_state.title}`);
  lines.push(`State: ${offer.page_state.state_summary}`);

  if (offer.page_state.hidden_sections && offer.page_state.hidden_sections.length > 0) {
    lines.push(`Hidden: ${offer.page_state.hidden_sections.join(", ")}`);
  }

  // Cards section — collect annotated nodes from the tree
  const annotatedNodes = collectAnnotatedNodes(offer.page_tree);

  if (annotatedNodes.length > 0) {
    lines.push("");
    lines.push("Cards:");
    for (const node of annotatedNodes) {
      if (!node.card) continue;

      lines.push(`  [${node.ref}] ${node.card.name} (${node.card.description})`);

      // Parameter schema
      const paramParts: string[] = [];
      for (const [key, schema] of Object.entries(node.card.parameters)) {
        const reqStr = schema.required ? "required" : "optional";
        paramParts.push(`${key} (${schema.type}, ${reqStr})`);
      }
      if (paramParts.length > 0) {
        lines.push(`    params: ${paramParts.join(", ")}`);
      }

      // Match audit (compact — truncate long why_this_card)
      const why = node.card.why_this_card;
      // Only take the first line of the audit for compactness
      const firstLine = why.split("\n")[0] ?? why;
      lines.push(`    match: ${firstLine}`);
    }
  } else if (offer.cards_found === 0) {
    lines.push("");
    lines.push("No cards matched this page.");
  }

  // Escape hatch
  lines.push("");
  lines.push(offer.hint);
  lines.push("================");

  let text = lines.join("\n");

  // Token budget enforcement: truncate tree section if over budget
  if (text.length > MAX_OFFER_CHARS) {
    text = truncateOfferText(text);
  }

  // H1 fix: hard cap — if still over budget after phase-based truncation,
  // cut the text and append a truncation marker.
  if (text.length > MAX_OFFER_CHARS) {
    text = hardTruncate(text, MAX_OFFER_CHARS);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Public API — Result Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a Karten-Ergebnis into compact text format.
 *
 * Format:
 * ```
 * === OPERATOR RESULT ===
 * {execution_summary}
 * Steps: {steps_completed}/{steps_total}
 * State: {state_summary}
 * Error: {error}  (only if present)
 * ========================
 * ```
 *
 * @param result - Validated OperatorResultReturn
 * @returns Text string for MCP tool response content block
 */
export function serializeResultReturn(result: OperatorResultReturn): string {
  const lines: string[] = [];

  lines.push("=== OPERATOR RESULT ===");
  lines.push(result.execution_summary);
  lines.push(`Steps: ${result.steps_completed}/${result.steps_total}`);
  lines.push(`State: ${result.page_state.state_summary}`);

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  lines.push("========================");

  let text = lines.join("\n");

  // H2 fix: truncate all variable-length fields, not just state_summary.
  if (text.length > MAX_RESULT_CHARS) {
    text = truncateResultText(lines, result, MAX_RESULT_CHARS);
  }

  return text;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all nodes that have a card annotation, depth-first.
 */
function collectAnnotatedNodes(tree: PageTreeNode[]): PageTreeNode[] {
  const result: PageTreeNode[] = [];

  function walk(nodes: PageTreeNode[]): void {
    for (const node of nodes) {
      if (node.card) {
        result.push(node);
      }
      if (node.children) {
        walk(node.children);
      }
    }
  }

  walk(tree);
  return result;
}

/**
 * Truncate the offer text to stay within token budget.
 * Strategy: remove card match audit lines (lowest value) first,
 * then parameter lines if still over budget.
 * L1 fix: removed unused `offer` parameter.
 */
function truncateOfferText(text: string): string {
  const lines = text.split("\n");
  let totalChars = text.length;

  // Phase 1: Remove match lines (least important)
  for (let i = lines.length - 1; i >= 0 && totalChars > MAX_OFFER_CHARS; i--) {
    if (lines[i]!.trimStart().startsWith("match:")) {
      totalChars -= lines[i]!.length + 1; // +1 for newline
      lines.splice(i, 1);
    }
  }

  if (totalChars <= MAX_OFFER_CHARS) {
    return lines.join("\n");
  }

  // Phase 2: Remove params lines
  for (let i = lines.length - 1; i >= 0 && totalChars > MAX_OFFER_CHARS; i--) {
    if (lines[i]!.trimStart().startsWith("params:")) {
      totalChars -= lines[i]!.length + 1;
      lines.splice(i, 1);
    }
  }

  // Phase 3: Remove card description lines (entire card entries, from bottom)
  for (let i = lines.length - 1; i >= 0 && totalChars > MAX_OFFER_CHARS; i--) {
    if (lines[i]!.trimStart().startsWith("[")) {
      totalChars -= lines[i]!.length + 1;
      lines.splice(i, 1);
    }
  }

  return lines.join("\n");
}

/**
 * H2 fix: Truncate result text by shortening variable-length fields.
 * Strategy: truncate error first, then execution_summary, then state_summary.
 */
function truncateResultText(
  lines: string[],
  result: OperatorResultReturn,
  maxChars: number,
): string {
  // Work with mutable copies of the field values
  let text = lines.join("\n");

  // Phase 1: Truncate error line if present
  if (result.error && text.length > maxChars) {
    const errorLine = `Error: ${result.error}`;
    const overhead = text.length - errorLine.length;
    const available = maxChars - overhead - 10; // 10 for "Error: ..."
    if (available > 20) {
      const shortened = `Error: ${result.error.slice(0, available - 3)}...`;
      text = text.replace(errorLine, shortened);
    } else {
      // Remove error line entirely
      text = text.replace(`\n${errorLine}`, "");
    }
  }

  // Phase 2: Truncate execution_summary
  if (text.length > maxChars) {
    const summaryLine = result.execution_summary;
    const overhead = text.length - summaryLine.length;
    const available = maxChars - overhead;
    if (available > 20) {
      const shortened = summaryLine.slice(0, available - 3) + "...";
      text = text.replace(summaryLine, shortened);
    }
  }

  // Phase 3: Truncate state_summary
  if (text.length > maxChars) {
    const stateLine = `State: ${result.page_state.state_summary}`;
    const overhead = text.length - stateLine.length;
    const available = maxChars - overhead - 7; // 7 for "State: "
    if (available > 20) {
      const shortened = `State: ${result.page_state.state_summary.slice(0, available - 3)}...`;
      text = text.replace(stateLine, shortened);
    }
  }

  // Hard cap as final safety net
  if (text.length > maxChars) {
    text = hardTruncate(text, maxChars);
  }

  return text;
}

/**
 * Hard truncation safety net: cuts text at maxChars and appends
 * a TRUNCATED marker so the LLM knows the output was cut.
 */
function hardTruncate(text: string, maxChars: number): string {
  const MARKER = "\n[TRUNCATED]";
  return text.slice(0, maxChars - MARKER.length) + MARKER;
}
