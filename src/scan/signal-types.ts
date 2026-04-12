/**
 * Signal Types — shared type definitions for the Scan-Match-Pipeline.
 *
 * Used by: signal-extractor.ts, aggregator.ts (Story 19.4), matcher.ts (Story 19.4).
 *
 * Signal Convention: The `signal` field uses the prefix:value format that matches
 * the Card `structure_signature` entries (e.g. "role:form", "type:password",
 * "autocomplete:username"). The Matcher (Story 19.4) compares these strings
 * directly against card signatures — format consistency is critical.
 */

// ---------------------------------------------------------------------------
// Signal Categories
// ---------------------------------------------------------------------------

/**
 * The four signal categories extracted from A11y-Tree nodes.
 * Extensible for future signal sources (e.g. "visual", "network").
 */
export type SignalType = "role" | "attribute" | "structure" | "name-pattern";

// ---------------------------------------------------------------------------
// Signal Interface
// ---------------------------------------------------------------------------

/**
 * A single extracted signal from an AXNode.
 *
 * Invariante 2: `signal` must be a structural identifier (prefix:value),
 * never a URL, domain, or content string.
 */
export interface Signal {
  /** Signal category */
  type: SignalType;
  /** Structural identifier in prefix:value format (e.g. "role:form") */
  signal: string;
  /** Reference to the originating AXNode (nodeId or parentNodeId for structure signals) */
  nodeId: string;
  /** Base confidence weight 0-1 */
  weight: number;
  /** Number of occurrences after deduplication (default: 1) */
  count?: number;
}

// ---------------------------------------------------------------------------
// Extraction Result
// ---------------------------------------------------------------------------

/**
 * Complete result of a signal extraction run.
 */
export interface ExtractionResult {
  /** Deduplicated, weight-sorted signal list */
  signals: Signal[];
  /** Extraction metadata for diagnostics */
  metadata: {
    /** Total number of AXNodes processed (including skipped/ignored) */
    nodeCount: number;
    /** Wall-clock extraction time in milliseconds */
    extractionTimeMs: number;
    /** Number of signals after deduplication and capping */
    signalCount: number;
  };
}
