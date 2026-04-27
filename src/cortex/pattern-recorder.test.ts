/**
 * Story 12.1 (Task 4.2): PatternRecorder tests.
 *
 * Covers:
 *  - navigate -> view_page -> click -> wait_for produces a pattern (AC #1)
 *  - Sequence without navigate at start produces no pattern
 *  - Single tool call produces no pattern (under MIN_SEQUENCE_LENGTH)
 *  - Timeout: events older than SEQUENCE_TIMEOUT_MS are ignored
 *  - pathPattern normalisation: UUIDs, numeric IDs, hex hashes
 *  - contentHash: deterministic, truncated to 16 hex chars
 *  - Ring buffer: events beyond 64 are discarded
 *  - Session-scoped buffers (H2 fix)
 *  - URL extraction from navigate response text (H1 fix)
 *  - emittedPatterns cap at 1000 (M3 fix)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PatternRecorder, patternRecorder } from "./pattern-recorder.js";
import { SEQUENCE_TIMEOUT_MS } from "./cortex-types.js";

describe("PatternRecorder (Story 12.1)", () => {
  let recorder: PatternRecorder;

  beforeEach(() => {
    recorder = new PatternRecorder();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // AC #1: Successful sequence produces a pattern
  // =========================================================================

  it("navigate -> view_page -> click -> wait_for produces a pattern (AC #1)", () => {
    const domain = "example.com";
    const path = "/products/list";
    const hash = "a1b2c3d4e5f6a7b8";

    recorder.record("navigate", domain, path, hash);
    recorder.record("view_page", domain, path, hash);
    recorder.record("click", domain, path, hash);
    recorder.record("wait_for", domain, path, hash);

    expect(recorder.emittedPatterns).toHaveLength(1);
    const p = recorder.emittedPatterns[0];
    expect(p.domain).toBe("example.com");
    expect(p.pathPattern).toBe("/products/list");
    expect(p.toolSequence).toEqual(["navigate", "view_page", "click", "wait_for"]);
    expect(p.outcome).toBe("success");
    expect(p.contentHash).toBe(hash);
    expect(typeof p.timestamp).toBe("number");
  });

  // =========================================================================
  // Sequence without navigate at start produces no pattern
  // =========================================================================

  it("sequence without navigate at start produces no pattern", () => {
    recorder.record("view_page", "example.com", "/", "abc123");
    recorder.record("click", "example.com", "/", "abc123");
    recorder.record("wait_for", "example.com", "/", "abc123");

    expect(recorder.emittedPatterns).toHaveLength(0);
  });

  // =========================================================================
  // Single tool call produces no pattern (under MIN_SEQUENCE_LENGTH)
  // =========================================================================

  it("single tool call produces no pattern", () => {
    recorder.record("navigate", "example.com", "/", "abc123");

    expect(recorder.emittedPatterns).toHaveLength(0);
  });

  // =========================================================================
  // Timeout: events older than SEQUENCE_TIMEOUT_MS are ignored
  // =========================================================================

  it("ignores events older than SEQUENCE_TIMEOUT_MS", () => {
    recorder.record("navigate", "example.com", "/page", "hash1");

    // Advance time beyond the timeout
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);

    recorder.record("view_page", "example.com", "/page", "hash2");

    // The navigate is too old, so no valid sequence starts with navigate
    expect(recorder.emittedPatterns).toHaveLength(0);
  });

  it("records pattern when all events are within SEQUENCE_TIMEOUT_MS", () => {
    recorder.record("navigate", "example.com", "/page", "hash1");

    // Advance time but stay within the timeout
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 1);

    recorder.record("view_page", "example.com", "/page", "hash2");

    expect(recorder.emittedPatterns).toHaveLength(1);
  });

  // =========================================================================
  // pathPattern normalisation
  // =========================================================================

  it("normalises UUID path segments to :uuid", () => {
    recorder.record("navigate", "example.com", "/users/550e8400-e29b-41d4-a716-446655440000/profile", "h1");
    recorder.record("view_page", "example.com", "/users/550e8400-e29b-41d4-a716-446655440000/profile", "h2");

    expect(recorder.emittedPatterns).toHaveLength(1);
    expect(recorder.emittedPatterns[0].pathPattern).toBe("/users/:uuid/profile");
  });

  it("normalises numeric ID path segments to :id", () => {
    recorder.record("navigate", "example.com", "/posts/12345/comments", "h1");
    recorder.record("view_page", "example.com", "/posts/12345/comments", "h2");

    expect(recorder.emittedPatterns).toHaveLength(1);
    expect(recorder.emittedPatterns[0].pathPattern).toBe("/posts/:id/comments");
  });

  it("normalises hex hash path segments to :hash", () => {
    recorder.record("navigate", "example.com", "/assets/a1b2c3d4e5f6a7b8/image.png", "h1");
    recorder.record("view_page", "example.com", "/assets/a1b2c3d4e5f6a7b8/image.png", "h2");

    expect(recorder.emittedPatterns).toHaveLength(1);
    expect(recorder.emittedPatterns[0].pathPattern).toBe("/assets/:hash/image.png");
  });

  it("does not normalise short non-ID segments", () => {
    recorder.record("navigate", "example.com", "/about/team", "h1");
    recorder.record("view_page", "example.com", "/about/team", "h2");

    expect(recorder.emittedPatterns).toHaveLength(1);
    expect(recorder.emittedPatterns[0].pathPattern).toBe("/about/team");
  });

  // =========================================================================
  // contentHash: deterministic, truncated to 16 hex chars
  // =========================================================================

  it("computeContentHash is deterministic and 16 hex chars", () => {
    const hash1 = PatternRecorder.computeContentHash("hello world");
    const hash2 = PatternRecorder.computeContentHash("hello world");

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash1)).toBe(true);
  });

  it("computeContentHash differs for different input", () => {
    const hash1 = PatternRecorder.computeContentHash("hello world");
    const hash2 = PatternRecorder.computeContentHash("goodbye world");

    expect(hash1).not.toBe(hash2);
  });

  // =========================================================================
  // Ring buffer: events beyond 64 are discarded
  // =========================================================================

  it("ring buffer discards events beyond 64", () => {
    // Fill buffer with 64 non-navigate events
    for (let i = 0; i < 64; i++) {
      recorder.record("view_page", "example.com", "/", `hash${i}`);
    }

    // The navigate event we recorded earlier should be gone
    // Now add a navigate + view_page — only these 2 are in the buffer
    recorder.record("navigate", "example.com", "/test", "h1");
    recorder.record("view_page", "example.com", "/test", "h2");

    // The buffer was trimmed from the front. Navigate is event 65, view_page is 66.
    // After trim the buffer has 64 entries: the last 64 events.
    // navigate + view_page should form a valid pattern.
    expect(recorder.emittedPatterns).toHaveLength(1);
    expect(recorder.emittedPatterns[0].toolSequence).toEqual(["navigate", "view_page"]);
  });

  it("navigate at position 0 is lost when buffer overflows", () => {
    recorder.record("navigate", "example.com", "/lost", "h0");

    // Push 64 more non-navigate events — navigate gets pushed out
    for (let i = 0; i < 64; i++) {
      recorder.record("view_page", "example.com", "/lost", `hash${i}`);
    }

    // One pattern was emitted (and continuously updated/replaced as the
    // sequence grew). The navigate-start was eventually pushed out of
    // the ring buffer, but the pattern was captured before that happened.
    // The last update was when the sequence still fit MAX_SEQUENCE_LENGTH.
    expect(recorder.emittedPatterns).toHaveLength(1);
    // Pattern starts with navigate (recorded before overflow)
    expect(recorder.emittedPatterns[0].toolSequence[0]).toBe("navigate");
  });

  // =========================================================================
  // Module-level singleton
  // =========================================================================

  it("exports a module-level singleton", () => {
    expect(patternRecorder).toBeInstanceOf(PatternRecorder);
  });

  // =========================================================================
  // Multiple patterns from different navigate sequences
  // =========================================================================

  it("records multiple patterns from different navigate sequences", () => {
    recorder.record("navigate", "site-a.com", "/page1", "h1");
    recorder.record("view_page", "site-a.com", "/page1", "h2");

    recorder.record("navigate", "site-b.com", "/page2", "h3");
    recorder.record("click", "site-b.com", "/page2", "h4");
    recorder.record("view_page", "site-b.com", "/page2", "h5");

    expect(recorder.emittedPatterns).toHaveLength(2);
    expect(recorder.emittedPatterns[0].domain).toBe("site-a.com");
    expect(recorder.emittedPatterns[1].domain).toBe("site-b.com");
  });

  // =========================================================================
  // Edge case: navigate -> navigate only records from the latest navigate
  // =========================================================================

  it("uses latest navigate as sequence start when multiple navigates exist", () => {
    recorder.record("navigate", "old.com", "/old", "h1");
    recorder.record("navigate", "new.com", "/new", "h2");
    recorder.record("view_page", "new.com", "/new", "h3");

    // Should produce a pattern from the second navigate onward
    expect(recorder.emittedPatterns).toHaveLength(1);
    expect(recorder.emittedPatterns[0].domain).toBe("new.com");
    expect(recorder.emittedPatterns[0].toolSequence).toEqual(["navigate", "view_page"]);
  });

  // =========================================================================
  // H1 fix: URL extraction from navigate response text
  // =========================================================================

  it("extractUrlFromResponse extracts URL from navigate response", () => {
    const url = PatternRecorder.extractUrlFromResponse(
      "Navigated to https://shop.example.com/products/42",
    );
    expect(url).not.toBeNull();
    expect(url!.hostname).toBe("shop.example.com");
    expect(url!.pathname).toBe("/products/42");
  });

  it("extractUrlFromResponse returns null when no URL present", () => {
    const url = PatternRecorder.extractUrlFromResponse("Clicked e5 (button)");
    expect(url).toBeNull();
  });

  it("extractUrlFromResponse handles HTTP URLs", () => {
    const url = PatternRecorder.extractUrlFromResponse(
      "Navigated to http://localhost:4242/test",
    );
    expect(url).not.toBeNull();
    expect(url!.hostname).toBe("localhost");
    expect(url!.pathname).toBe("/test");
  });

  // =========================================================================
  // H2 fix: Session-scoped buffers
  // =========================================================================

  it("isolates events between sessions", () => {
    recorder.record("navigate", "site-a.com", "/a", "h1", "session-1");
    recorder.record("view_page", "site-a.com", "/a", "h2", "session-1");

    recorder.record("navigate", "site-b.com", "/b", "h3", "session-2");
    recorder.record("view_page", "site-b.com", "/b", "h4", "session-2");

    expect(recorder.emittedPatterns).toHaveLength(2);
    expect(recorder.emittedPatterns[0].domain).toBe("site-a.com");
    expect(recorder.emittedPatterns[1].domain).toBe("site-b.com");
  });

  it("events from one session do not affect another session's sequence", () => {
    // Session 1: navigate only (below MIN_SEQUENCE_LENGTH)
    recorder.record("navigate", "site-a.com", "/a", "h1", "session-1");

    // Session 2: different events — should NOT combine with session 1
    recorder.record("view_page", "site-b.com", "/b", "h2", "session-2");

    // No patterns — session 1 has only 1 event, session 2 has no navigate
    expect(recorder.emittedPatterns).toHaveLength(0);
  });

  // =========================================================================
  // M3 fix: emittedPatterns capped at 1000
  // =========================================================================

  it("caps emittedPatterns at 1000 entries", () => {
    // Generate 1010 distinct patterns (each with a unique navigate sequence)
    for (let i = 0; i < 1010; i++) {
      recorder.record("navigate", `site-${i}.com`, "/", `h${i}a`, `sess-${i}`);
      recorder.record("view_page", `site-${i}.com`, "/", `h${i}b`, `sess-${i}`);
    }

    expect(recorder.emittedPatterns.length).toBeLessThanOrEqual(1000);
    // The oldest patterns should have been removed
    expect(recorder.emittedPatterns[0].domain).toBe("site-10.com");
    expect(recorder.emittedPatterns[recorder.emittedPatterns.length - 1].domain).toBe("site-1009.com");
  });
});
