/**
 * Story 12.1 / 12a.2: Cortex Type Definitions.
 *
 * Defines the core data structures for the Cortex subsystem's pattern
 * recording. These types are consumed by `PatternRecorder` and persisted
 * by the Merkle Log (Story 12.2).
 *
 * Story 12a.2: Patterns are keyed by pageType (seitentyp-basiert) instead
 * of domain/pathPattern. The pageType is determined by the page-classifier
 * (Story 12a.1) from the A11y-Tree — privacy-preserving because "login"
 * reveals less than "accounts.google.com".
 *
 * Privacy (NFR21): Patterns contain ONLY pageType, tool sequence, outcome,
 * content-hash, and timestamp. Domain is kept as optional debugging
 * metadata. No full URLs, no query parameters, no auth tokens, no page
 * content. The content-hash is a truncated SHA-256 — not reversible.
 */

/**
 * A recorded successful tool-interaction pattern.
 *
 * Represents a sequence of tool calls that achieved a successful outcome
 * on a specific page type. Used by the Cortex to learn from repeated
 * interactions across domains.
 *
 * Story 12a.2: Primary key is `pageType` (e.g. "login", "data_table").
 * The domain is kept as optional metadata for debugging — never used
 * for matching. The old `pathPattern` field has been removed; the page
 * type replaces path-based assignment.
 */
export interface CortexPattern {
  /** Page type classification (e.g. "login", "data_table", "search_results"). Primary key for pattern matching. */
  pageType: string;
  /** Domain where the pattern was observed (optional debugging metadata, not used for matching). */
  domain?: string;
  /** Ordered list of tool names that formed the successful sequence. */
  toolSequence: string[];
  /** Outcome of the sequence — only successful sequences are recorded. */
  outcome: "success";
  /** Truncated SHA-256 hash (16 hex chars) of the response content. */
  contentHash: string;
  /** Unix timestamp (ms) when the pattern was emitted. */
  timestamp: number;
}

/**
 * Internal buffer entry for tracking individual tool-call events.
 *
 * The `PatternRecorder` maintains a ring-buffer of these events and
 * checks after each new event whether a recordable sequence has formed.
 *
 * Story 12a.2: Events track pageType instead of domain/path — the page
 * type is determined by the page-classifier from the A11y-Tree.
 */
export interface ToolCallEvent {
  /** Name of the tool that was called (e.g. "navigate", "click"). */
  toolName: string;
  /** Unix timestamp (ms) when the event was recorded. */
  timestamp: number;
  /** Page type classification from the page-classifier (e.g. "login", "unknown"). */
  pageType: string;
  /** Truncated SHA-256 hash (16 hex chars) of the tool response content. */
  contentHash: string;
}

/**
 * Story 12.2: Merkle Log Types.
 *
 * Defines data structures for the append-only Merkle log that provides
 * cryptographic integrity for stored patterns. RFC-6962-compatible.
 */

/** A node in the Merkle hash tree (used internally for tree construction). */
export interface MerkleNode {
  /** SHA-256 hash of this node (hex-encoded). */
  hash: string;
  /** Left child (null for leaf nodes). */
  left: MerkleNode | null;
  /** Right child (null for leaf nodes). */
  right: MerkleNode | null;
}

/**
 * RFC-6962 Section 2.1.1 Inclusion Proof.
 *
 * Contains the sibling hashes needed to recompute the path from a leaf
 * to the tree root. Allows verifying a single entry without knowing the
 * entire tree.
 */
export interface MerkleInclusionProof {
  /** Zero-based index of the leaf in the log. */
  leafIndex: number;
  /** Total number of leaves in the tree when this proof was generated. */
  treeSize: number;
  /** Ordered sibling hashes from leaf to root (hex-encoded). */
  hashes: string[];
}

/**
 * RFC-6962 Section 3.5 Signed Tree Head (simplified for local use).
 *
 * In Phase 1 there is no PKI signature — the locally stored tree head
 * provides integrity verification for the append-only log.
 */
export interface SignedTreeHead {
  /** Total number of leaves in the tree. */
  treeSize: number;
  /** SHA-256 Merkle root hash (hex-encoded, empty string for empty tree). */
  rootHash: string;
  /** Unix timestamp in milliseconds when the tree head was written. */
  timestamp: number;
}

/** Configuration options for the LocalStore. */
export interface LocalStoreOptions {
  /**
   * Directory where the Merkle log files are stored.
   * Default: `~/.public-browser/cortex/`
   */
  dataDir?: string;
}

/**
 * Story 12a.4: Cortex Hint Types (PageType-based).
 *
 * A hint derived from Markov transition predictions, delivered to the
 * LLM agent via `_meta.cortex` in navigate/view_page responses.
 *
 * Story 12a.4: Replaced domain/pathPattern/successRate with pageType
 * and predictions (Markov-based). toolSequence kept for backward
 * compatibility (top-3 predicted tools in descending probability).
 */
export interface CortexHint {
  /** Page type classification (e.g. "login", "data_table"). */
  pageType: string;
  /** Markov-based predictions: next tool with normalised probability (0-1). */
  predictions: Array<{ tool: string; probability: number }>;
  /** Top-3 predicted tools in descending probability (backward compat). */
  toolSequence: string[];
  /** Number of aggregated transitions (Phase 1: local count). */
  installationCount: number;
}

/**
 * Container for hint-matcher results.
 */
export interface HintMatchResult {
  /** Matched hints (empty array if no match). */
  hints: CortexHint[];
  /** Number of patterns that matched (0 if none). */
  matchCount: number;
}

/**
 * Story 12.5: Telemetry Upload Types.
 *
 * Defines data structures for the opt-in telemetry upload that sends
 * anonymised pattern entries to a collection endpoint.
 * Privacy (NFR21): ONLY the whitelisted fields below are included.
 */

/**
 * Anonymised payload sent to the collection endpoint.
 *
 * Uses an explicit whitelist of fields — no spread from CortexPattern.
 * This prevents accidental leakage of future fields (NFR21).
 */
export interface TelemetryPayload {
  /** Domain where the pattern was observed (e.g. "example.com"). */
  domain: string;
  /** Normalised URL path pattern (e.g. "/users/:id/profile"). */
  pathPattern: string;
  /** Ordered list of tool names in the successful sequence. */
  toolSequence: string[];
  /** Fraction of patterns that succeeded (0-1). Phase 1: always 1.0. */
  successRate: number;
  /** Truncated SHA-256 content hash (16 hex chars). */
  contentHash: string;
  /** Unix timestamp (ms) when the pattern was emitted. */
  timestamp: number;
}

/**
 * Configuration for the telemetry uploader.
 */
export interface TelemetryConfig {
  /** Whether telemetry upload is enabled. Default: false. */
  enabled: boolean;
  /** HTTPS endpoint for pattern collection. */
  endpoint: string;
  /** Minimum interval (ms) between uploads for the same pattern key. */
  rateLimitMs: number;
}

/** Rate limit: at most 1 upload per minute per pattern key (AC #4). */
export const TELEMETRY_RATE_LIMIT_MS = 60_000;

/** Minimum number of tools in a sequence to be considered recordable. */
export const MIN_SEQUENCE_LENGTH = 2;

/** Maximum number of tools in a single recorded sequence. */
export const MAX_SEQUENCE_LENGTH = 20;

/**
 * Time window (ms) within which all events must fall to form a valid
 * sequence. Events older than this are ignored during pattern detection.
 */
export const SEQUENCE_TIMEOUT_MS = 60_000;

// ─── Story 12a.3: Markov Transition Table Types ─────────────────────

/**
 * A single transition entry in the Markov table.
 *
 * `weight` is the current (possibly decay-adjusted) weighting,
 * `count` is the absolute observation frequency (never changed by decay),
 * `lastSeen` is the Unix timestamp (ms) of the most recent observation.
 */
export interface MarkovTransition {
  /** Tool name that this transition leads to. */
  tool: string;
  /** Current weight (decay-adjusted). */
  weight: number;
  /** Absolute observation count (unaffected by decay). */
  count: number;
  /** Unix timestamp (ms) of the last observation. */
  lastSeen: number;
}

/**
 * JSON export format for community bundles (~10KB).
 *
 * Three-level nested object: pageType → lastTool → nextTool → weight.
 * Only normalised weights (0-1), no count or lastSeen — this is the
 * format distributed via OCI in Epic 13.
 */
export interface MarkovTableJSON {
  [pageType: string]: {
    [lastTool: string]: {
      [nextTool: string]: number;
    };
  };
}

/** ACO decay factor per week (weight multiplier). */
export const MARKOV_DECAY_FACTOR = 0.95;

/** Decay interval: 1 week in milliseconds. */
export const MARKOV_DECAY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum age: entries older than 30 days are removed entirely. */
export const MARKOV_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
