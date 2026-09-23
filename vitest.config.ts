import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Tests that drive the default onToolResult hook persist Cortex patterns
    // through the module singleton. Without this they write into the real
    // ~/.public-browser/cortex (overwriting patterns, leaving *.tmp files
    // when a worker is torn down mid-write).
    env: {
      PUBLIC_BROWSER_CORTEX_DIR: join(tmpdir(), "public-browser-vitest-cortex"),
    },
  },
});
