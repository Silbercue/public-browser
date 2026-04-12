/**
 * Card Loader — reads YAML card files and validates against CardSchema.
 *
 * YAML fields are snake_case; Zod .transform() produces camelCase Card objects.
 * Throws CardValidationError on structural invariant violations or Zod parse failures.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ZodError } from "zod";
import { CardSchema } from "./card-schema.js";
import type { Card } from "./card-schema.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CardValidationError extends Error {
  public readonly fileName: string;
  public readonly reason: string;
  public readonly zodErrors?: ZodError;

  constructor(fileName: string, reason: string, zodErrors?: ZodError) {
    super(`Card validation failed for '${fileName}': ${reason}`);
    this.name = "CardValidationError";
    this.fileName = fileName;
    this.reason = reason;
    this.zodErrors = zodErrors;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all .yaml card files from the given directory.
 * Returns an empty Map if the directory is empty (valid state at startup).
 * Throws CardValidationError on validation failures.
 */
export function loadAll(cardsDir: string): Map<string, Card> {
  if (!fs.existsSync(cardsDir)) {
    return new Map();
  }

  const files = fs
    .readdirSync(cardsDir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();

  const result = new Map<string, Card>();

  for (const file of files) {
    const filePath = path.join(cardsDir, file);
    const card = loadSingle(filePath);
    result.set(card.id, card);
  }

  return result;
}

/**
 * Load and validate a single YAML card file.
 * Throws CardValidationError on any validation failure.
 */
export function loadSingle(filePath: string): Card {
  const fileName = path.basename(filePath);
  const expectedId = fileName.replace(/\.yaml$/, "");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new CardValidationError(
      fileName,
      `Failed to read file: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new CardValidationError(
      fileName,
      `YAML parse error: ${(err as Error).message}`,
    );
  }

  let card: Card;
  try {
    card = CardSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      const details = err.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new CardValidationError(
        fileName,
        `Schema validation failed:\n${details}`,
        err,
      );
    }
    throw err;
  }

  // Filename-ID consistency check
  if (card.id !== expectedId) {
    throw new CardValidationError(
      fileName,
      `id field '${card.id}' does not match filename '${expectedId}'`,
    );
  }

  return card;
}
