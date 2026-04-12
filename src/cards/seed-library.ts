/**
 * Seed Library — lazy-loaded entrypoint for the built-in card collection.
 *
 * Caches the loaded card map after first call (server-start optimization).
 */

import path from "node:path";
import { loadAll } from "./card-loader.js";
import type { Card } from "./card-schema.js";

let cachedLibrary: Map<string, Card> | null = null;

/**
 * Load the seed card library from the project-level `cards/` directory.
 * Lazy-loads on first call; subsequent calls return the cached Map.
 */
export function loadSeedLibrary(): Map<string, Card> {
  if (cachedLibrary !== null) {
    return cachedLibrary;
  }

  // cards/ lives two levels up from build/cards/ (or src/cards/ in dev)
  const cardsDir = path.resolve(__dirname, "../../cards");
  cachedLibrary = loadAll(cardsDir);
  return cachedLibrary;
}

/**
 * Reset the cache — only for testing purposes.
 * @internal
 */
export function _resetSeedLibraryCache(): void {
  cachedLibrary = null;
}
