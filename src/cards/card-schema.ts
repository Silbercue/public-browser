/**
 * Card Data Model — Zod Schema + Type Export
 *
 * Defines the canonical schema for Operator cards (YAML → TypeScript).
 * YAML fields are snake_case; the Zod .transform() converts to camelCase.
 *
 * Pattern Invariants (Invariante 2 — Struktur-Invariante):
 *   Signals and targets must be structural identifiers (roles, tags, ARIA
 *   attributes), never URLs, domain names, or literal content strings.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Named Constants — Invariante 5 (Solo-Pflegbarkeit): keine Magic Regexes
// ---------------------------------------------------------------------------

/** Matches http:// or https:// URLs */
export const URL_PATTERN = /https?:\/\//i;

/** Matches domain-like strings: word.tld or sub.word.tld, optionally with path suffix */
export const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

/**
 * Matches content strings — literal text that belongs to page content,
 * not structural identifiers. A structural identifier uses a prefix pattern
 * (role:xxx, tag:xxx, type:xxx, autocomplete:xxx) whereas content strings
 * are natural-language phrases (>= 2 words with spaces, >= 4 chars total).
 *
 * Excludes strings containing CSS-selector characters ([ ] # > ~) which are
 * valid targets in execution_sequence, and excludes colon-prefixed structural
 * identifiers (e.g. "role:form", "type:password").
 */
export const CONTENT_STRING_PATTERN = /^(?!.*[[\]#>~])(?!^\w+:\S+$)(?=.*\s).{4,}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validates a signal string is structural, not content/URL/domain. */
function isStructuralSignal(value: string): boolean {
  if (URL_PATTERN.test(value)) return false;
  if (DOMAIN_PATTERN.test(value)) return false;
  if (CONTENT_STRING_PATTERN.test(value)) return false;
  return true;
}

/** Validates a target string is structural (CSS selector or ref pattern). */
function isStructuralTarget(value: string): boolean {
  if (URL_PATTERN.test(value)) return false;
  if (DOMAIN_PATTERN.test(value)) return false;
  // Targets are CSS selectors or ref patterns — content strings rejected
  if (CONTENT_STRING_PATTERN.test(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Sub-Schemas (snake_case input → camelCase output)
// ---------------------------------------------------------------------------

const StructureSignalRawSchema = z.object({
  signal: z.string().min(1),
  weight: z.number().min(0).max(1),
});

const CounterSignalRawSchema = z.object({
  signal: z.string().min(1),
  level: z.enum(["required", "strong", "soft"]),
});

const ParameterRawSchema = z.object({
  type: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean(),
});

const ExecutionStepRawSchema = z.object({
  action: z.string().min(1),
  target: z.string().min(1),
  value: z.string().optional().transform((v) => (v === "" ? undefined : v)),
  param_ref: z.string().optional().transform((v) => (v === "" ? undefined : v)),
});

// ---------------------------------------------------------------------------
// Card Raw Schema (snake_case — matches YAML fields)
// ---------------------------------------------------------------------------

const CardRawSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case"),
    name: z.string().min(1),
    description: z.string().min(1),
    structure_signature: z.array(StructureSignalRawSchema).min(2),
    counter_signals: z.array(CounterSignalRawSchema).min(1),
    parameters: z.record(z.string(), ParameterRawSchema),
    execution_sequence: z.array(ExecutionStepRawSchema).min(1),
    schema_version: z.literal("1.0").default("1.0"),
    source: z.literal("seed").default("seed"),
    version: z.string().min(1),
    author: z.string().min(1),
    harvest_count: z.literal(0).default(0),
    test_cases: z.array(z.string()).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Refine: Pattern Invariants (Invariante 2)
// ---------------------------------------------------------------------------

const CardRefinedSchema = CardRawSchema
  .refine(
    (card) =>
      card.structure_signature.every((s) => isStructuralSignal(s.signal)),
    {
      message:
        "structure_signature contains a URL, domain, or content string — only structural identifiers allowed",
      path: ["structure_signature"],
    },
  )
  .refine(
    (card) =>
      card.counter_signals.every((s) => isStructuralSignal(s.signal)),
    {
      message:
        "counter_signals contains a URL, domain, or content string — only structural identifiers allowed",
      path: ["counter_signals"],
    },
  )
  .refine(
    (card) =>
      card.execution_sequence.every((s) => isStructuralTarget(s.target)),
    {
      message:
        "execution_sequence.target contains a URL, domain, or content string — only structural targets allowed",
      path: ["execution_sequence"],
    },
  );

// ---------------------------------------------------------------------------
// Transform: snake_case → camelCase
// ---------------------------------------------------------------------------

export const CardSchema = CardRefinedSchema.transform((raw) => ({
  id: raw.id,
  name: raw.name,
  description: raw.description,
  structureSignature: raw.structure_signature.map((s) => ({
    signal: s.signal,
    weight: s.weight,
  })),
  counterSignals: raw.counter_signals.map((s) => ({
    signal: s.signal,
    level: s.level as "required" | "strong" | "soft",
  })),
  parameters: Object.fromEntries(
    Object.entries(raw.parameters).map(([key, val]) => [
      key,
      {
        type: val.type,
        description: val.description,
        required: val.required,
      },
    ]),
  ),
  executionSequence: raw.execution_sequence.map((s) => ({
    action: s.action,
    target: s.target,
    value: s.value,
    paramRef: s.param_ref,
  })),
  schemaVersion: raw.schema_version,
  source: raw.source,
  version: raw.version,
  author: raw.author,
  harvestCount: raw.harvest_count,
  testCases: raw.test_cases,
}));

// ---------------------------------------------------------------------------
// Type Export
// ---------------------------------------------------------------------------

export type Card = z.infer<typeof CardSchema>;

/**
 * Input type — the raw snake_case shape that YAML files must provide.
 * Useful for tests that construct card objects directly.
 */
export type CardInput = z.input<typeof CardSchema>;
