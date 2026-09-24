import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// B5: resetAll() restarts the ref numbering at e1 — only tests may call it.
// Production code resets with reset(), which keeps counting, so an old ref
// can never silently name a new node.
const SRC = fileURLToPath(new URL("..", import.meta.url));

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("resetAll() stays test-only (B5)", () => {
  it("B5: no production file under src/ calls resetAll()", () => {
    const callers = productionFiles(SRC).filter((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .some((line) => !/^\s*(\/\/|\*)/.test(line) && /\.resetAll\(/.test(line)),
    );

    expect(callers.map((file) => relative(SRC, file))).toEqual([]);
  });
});
