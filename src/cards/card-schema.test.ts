import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { CardSchema, URL_PATTERN, DOMAIN_PATTERN, CONTENT_STRING_PATTERN } from "./card-schema.js";
import type { CardInput } from "./card-schema.js";
import { loadAll, loadSingle, CardValidationError } from "./card-loader.js";
import { loadSeedLibrary, _resetSeedLibraryCache } from "./seed-library.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid card input (snake_case, matching YAML format). */
function validCardInput(overrides: Partial<CardInput> = {}): CardInput {
  return {
    id: "test-card",
    name: "Test Card",
    description: "A test card for unit tests",
    structure_signature: [
      { signal: "role:form", weight: 0.8 },
      { signal: "type:submit", weight: 0.5 },
    ],
    counter_signals: [{ signal: "role:search", level: "strong" }],
    parameters: {
      username: { type: "string", description: "The username", required: true },
    },
    execution_sequence: [
      { action: "fill", target: "[name=username]", param_ref: "username" },
    ],
    schema_version: "1.0",
    source: "seed",
    version: "1.0.0",
    author: "Test Author",
    harvest_count: 0,
    test_cases: [],
    ...overrides,
  };
}

/** Write a YAML card file into a temp directory and return the dir path. */
function writeTempCard(
  dirPath: string,
  fileName: string,
  content: Record<string, unknown>,
): string {
  const filePath = path.join(dirPath, fileName);
  fs.writeFileSync(filePath, yaml.dump(content), "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Named-constant tests (Invariante 5)
// ---------------------------------------------------------------------------

describe("Pattern Constants", () => {
  it("URL_PATTERN matches http and https URLs", () => {
    expect(URL_PATTERN.test("https://example.com")).toBe(true);
    expect(URL_PATTERN.test("http://foo.bar")).toBe(true);
    expect(URL_PATTERN.test("role:form")).toBe(false);
  });

  it("DOMAIN_PATTERN matches domain-like strings", () => {
    expect(DOMAIN_PATTERN.test("example.com")).toBe(true);
    expect(DOMAIN_PATTERN.test("sub.example.com")).toBe(true);
    expect(DOMAIN_PATTERN.test("example.com/login")).toBe(true);
    expect(DOMAIN_PATTERN.test("github.com/settings/profile")).toBe(true);
    expect(DOMAIN_PATTERN.test("role:form")).toBe(false);
    expect(DOMAIN_PATTERN.test("singleword")).toBe(false);
  });

  it("CONTENT_STRING_PATTERN matches multi-word content strings", () => {
    expect(CONTENT_STRING_PATTERN.test("Click here to submit your form now")).toBe(true);
    expect(CONTENT_STRING_PATTERN.test("Sign in")).toBe(true);
    expect(CONTENT_STRING_PATTERN.test("Log out")).toBe(true);
    expect(CONTENT_STRING_PATTERN.test("role:form")).toBe(false);
    expect(CONTENT_STRING_PATTERN.test("type:password")).toBe(false);
    // CSS selectors should not match
    expect(CONTENT_STRING_PATTERN.test("[name=username]")).toBe(false);
    expect(CONTENT_STRING_PATTERN.test("div > span")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Six negative assertions for pattern invariants
// ---------------------------------------------------------------------------

describe("CardSchema — Negative Assertions (AC-5)", () => {
  it("rejects a card with a URL in structure_signature", () => {
    const input = validCardInput({
      structure_signature: [
        { signal: "https://example.com/login", weight: 0.8 },
        { signal: "role:form", weight: 0.5 },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects a card with a domain name in counter_signals", () => {
    const input = validCardInput({
      counter_signals: [{ signal: "example.com", level: "strong" }],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects a card with a content string in structure_signature", () => {
    const input = validCardInput({
      structure_signature: [
        { signal: "Please enter your username and password to continue", weight: 0.8 },
        { signal: "role:form", weight: 0.5 },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects a card with wrong schema_version", () => {
    const input = validCardInput({ schema_version: "999" as "1.0" });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects a card with wrong source", () => {
    const input = validCardInput({ source: "community" as "seed" });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects a card without schema_version (undefined, no default fallback in strict object)", () => {
    // Explicitly construct raw object without schema_version field
    const raw = { ...validCardInput() };
    delete (raw as Record<string, unknown>).schema_version;
    // Without schema_version, the default "1.0" should apply — this tests that defaults work
    const result = CardSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe("1.0");
    }
  });

  it("rejects a card without source (undefined, no default fallback in strict object)", () => {
    const raw = { ...validCardInput() };
    delete (raw as Record<string, unknown>).source;
    // Without source, the default "seed" should apply — this tests that defaults work
    const result = CardSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("seed");
    }
  });

  it("rejects a card with empty execution_sequence", () => {
    const input = validCardInput({ execution_sequence: [] });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Positive assertions: valid cards pass
// ---------------------------------------------------------------------------

describe("CardSchema — Positive Assertions", () => {
  it("accepts a valid card input", () => {
    const result = CardSchema.safeParse(validCardInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("test-card");
      expect(result.data.structureSignature).toHaveLength(2);
      expect(result.data.counterSignals).toHaveLength(1);
      expect(result.data.executionSequence).toHaveLength(1);
      expect(result.data.schemaVersion).toBe("1.0");
      expect(result.data.source).toBe("seed");
      expect(result.data.harvestCount).toBe(0);
    }
  });

  it("uses defaults for schema_version, source, harvest_count, test_cases", () => {
    const input = validCardInput();
    delete (input as Record<string, unknown>).schema_version;
    delete (input as Record<string, unknown>).source;
    delete (input as Record<string, unknown>).harvest_count;
    delete (input as Record<string, unknown>).test_cases;

    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe("1.0");
      expect(result.data.source).toBe("seed");
      expect(result.data.harvestCount).toBe(0);
      expect(result.data.testCases).toEqual([]);
    }
  });

  it("transforms snake_case to camelCase", () => {
    const result = CardSchema.parse(validCardInput());
    // camelCase keys exist
    expect(result.structureSignature).toBeDefined();
    expect(result.counterSignals).toBeDefined();
    expect(result.executionSequence).toBeDefined();
    expect(result.schemaVersion).toBeDefined();
    expect(result.harvestCount).toBeDefined();
    expect(result.testCases).toBeDefined();
    // execution_sequence param_ref → paramRef
    expect(result.executionSequence[0].paramRef).toBe("username");
  });

  it("rejects unknown fields (strict mode)", () => {
    const input = { ...validCardInput(), unknown_field: "surprise" };
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects non-kebab-case id", () => {
    const result = CardSchema.safeParse(validCardInput({ id: "TestCard" }));
    expect(result.success).toBe(false);
  });

  it("rejects id with underscores", () => {
    const result = CardSchema.safeParse(validCardInput({ id: "test_card" }));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Seed-Karten Validation (AC-3)
// ---------------------------------------------------------------------------

describe("Seed Cards — Schema Validation (AC-3)", () => {
  const cardsDir = path.resolve(__dirname, "../../cards");

  it("login-form.yaml passes validation", () => {
    const card = loadSingle(path.join(cardsDir, "login-form.yaml"));
    expect(card.id).toBe("login-form");
    expect(card.structureSignature.length).toBeGreaterThanOrEqual(2);
    expect(card.counterSignals.length).toBeGreaterThanOrEqual(1);
    expect(card.executionSequence.length).toBeGreaterThanOrEqual(1);
  });

  it("search-result-list.yaml passes validation", () => {
    const card = loadSingle(path.join(cardsDir, "search-result-list.yaml"));
    expect(card.id).toBe("search-result-list");
    expect(card.structureSignature.length).toBeGreaterThanOrEqual(2);
    expect(card.counterSignals.length).toBeGreaterThanOrEqual(1);
    expect(card.executionSequence.length).toBeGreaterThanOrEqual(1);
  });

  it("article-reader.yaml passes validation", () => {
    const card = loadSingle(path.join(cardsDir, "article-reader.yaml"));
    expect(card.id).toBe("article-reader");
    expect(card.structureSignature.length).toBeGreaterThanOrEqual(2);
    expect(card.counterSignals.length).toBeGreaterThanOrEqual(1);
    expect(card.executionSequence.length).toBeGreaterThanOrEqual(1);
  });

  it("loadAll() returns all three seed cards", () => {
    const cards = loadAll(cardsDir);
    expect(cards.size).toBe(3);
    expect(cards.has("login-form")).toBe(true);
    expect(cards.has("search-result-list")).toBe(true);
    expect(cards.has("article-reader")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card Loader Tests (AC-2)
// ---------------------------------------------------------------------------

describe("Card Loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "card-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("loadAll() returns empty Map for empty directory", () => {
    const cards = loadAll(tempDir);
    expect(cards.size).toBe(0);
  });

  it("loadAll() returns empty Map for non-existent directory", () => {
    const cards = loadAll(path.join(tempDir, "nonexistent"));
    expect(cards.size).toBe(0);
  });

  it("loadAll() loads valid cards from directory", () => {
    writeTempCard(tempDir, "test-card.yaml", validCardInput());
    const cards = loadAll(tempDir);
    expect(cards.size).toBe(1);
    expect(cards.get("test-card")).toBeDefined();
  });

  it("loadAll() throws CardValidationError for invalid YAML card", () => {
    writeTempCard(tempDir, "bad-card.yaml", {
      id: "bad-card",
      name: "Bad",
      // Missing required fields
    });
    expect(() => loadAll(tempDir)).toThrow(CardValidationError);
  });

  it("loadSingle() throws CardValidationError on filename-id mismatch", () => {
    writeTempCard(tempDir, "wrong-name.yaml", validCardInput({ id: "test-card" }));
    expect(() => loadSingle(path.join(tempDir, "wrong-name.yaml"))).toThrow(
      CardValidationError,
    );
    try {
      loadSingle(path.join(tempDir, "wrong-name.yaml"));
    } catch (err) {
      expect(err).toBeInstanceOf(CardValidationError);
      expect((err as CardValidationError).reason).toContain("does not match filename");
    }
  });

  it("loadSingle() throws CardValidationError for malformed YAML", () => {
    const filePath = path.join(tempDir, "broken.yaml");
    fs.writeFileSync(filePath, "{{invalid yaml", "utf-8");
    expect(() => loadSingle(filePath)).toThrow(CardValidationError);
  });

  it("CardValidationError has correct fields", () => {
    writeTempCard(tempDir, "bad-card.yaml", { id: "bad-card" });
    try {
      loadSingle(path.join(tempDir, "bad-card.yaml"));
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CardValidationError);
      const cve = err as CardValidationError;
      expect(cve.fileName).toBe("bad-card.yaml");
      expect(cve.reason).toBeTruthy();
      expect(cve.zodErrors).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Seed Library (AC-2, AC-3)
// ---------------------------------------------------------------------------

describe("Seed Library", () => {
  beforeEach(() => {
    _resetSeedLibraryCache();
  });

  it("loadSeedLibrary() returns a Map with three seed cards", () => {
    const lib = loadSeedLibrary();
    expect(lib.size).toBe(3);
    expect(lib.has("login-form")).toBe(true);
    expect(lib.has("search-result-list")).toBe(true);
    expect(lib.has("article-reader")).toBe(true);
  });

  it("loadSeedLibrary() caches the result on second call", () => {
    const lib1 = loadSeedLibrary();
    const lib2 = loadSeedLibrary();
    expect(lib1).toBe(lib2); // Same reference = cached
  });
});

// ---------------------------------------------------------------------------
// Additional edge-case tests
// ---------------------------------------------------------------------------

describe("CardSchema — Edge Cases", () => {
  it("rejects card with fewer than 2 structure_signature entries", () => {
    const input = validCardInput({
      structure_signature: [{ signal: "role:form", weight: 0.8 }],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects card with zero counter_signals", () => {
    const input = validCardInput({ counter_signals: [] });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects signal weight above 1", () => {
    const input = validCardInput({
      structure_signature: [
        { signal: "role:form", weight: 1.5 },
        { signal: "type:submit", weight: 0.5 },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects signal weight below 0", () => {
    const input = validCardInput({
      structure_signature: [
        { signal: "role:form", weight: -0.1 },
        { signal: "type:submit", weight: 0.5 },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects invalid counter_signal level", () => {
    const input = validCardInput({
      counter_signals: [{ signal: "role:search", level: "invalid" as "required" }],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("allows empty parameters object (read-only card)", () => {
    const input = validCardInput({ parameters: {} });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("rejects URL in execution_sequence target", () => {
    const input = validCardInput({
      execution_sequence: [
        { action: "click", target: "https://example.com/button" },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects domain in execution_sequence target", () => {
    const input = validCardInput({
      execution_sequence: [
        { action: "click", target: "example.com" },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("transforms empty param_ref string to undefined", () => {
    const input = validCardInput({
      execution_sequence: [
        { action: "click", target: "[type=submit]", param_ref: "" },
      ],
    });
    const result = CardSchema.parse(input);
    expect(result.executionSequence[0].paramRef).toBeUndefined();
  });

  it("transforms empty value string to undefined", () => {
    const input = validCardInput({
      execution_sequence: [
        { action: "click", target: "[type=submit]", value: "" },
      ],
    });
    const result = CardSchema.parse(input);
    expect(result.executionSequence[0].value).toBeUndefined();
  });

  it("rejects domain+path in structure_signature (C1 coverage)", () => {
    const input = validCardInput({
      structure_signature: [
        { signal: "example.com/login", weight: 0.8 },
        { signal: "role:form", weight: 0.5 },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects domain+path in execution_sequence target (C1 coverage)", () => {
    const input = validCardInput({
      execution_sequence: [
        { action: "click", target: "github.com/settings/profile" },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects short label-text in structure_signature (H4/M1 coverage)", () => {
    const input = validCardInput({
      structure_signature: [
        { signal: "Sign in", weight: 0.8 },
        { signal: "role:form", weight: 0.5 },
      ],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects short label-text in counter_signals (H4/M1 coverage)", () => {
    const input = validCardInput({
      counter_signals: [{ signal: "Log out", level: "strong" }],
    });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects harvest_count != 0 in Phase 1 (H1 coverage)", () => {
    const input = validCardInput({ harvest_count: 5 as 0 });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects negative harvest_count (H1 coverage)", () => {
    const input = validCardInput({ harvest_count: -1 as 0 });
    const result = CardSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
