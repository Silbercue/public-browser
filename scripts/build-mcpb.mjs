#!/usr/bin/env node
/**
 * MCPB Bundle Builder (Smithery, Claude Desktop)
 * Stages build/ + production node_modules + manifest.json and packs them into
 * dist/public-browser.mcpb. The bundle keeps the npm package layout
 * (package.json next to build/), so the server runs unchanged — no npx needed.
 *
 * Prerequisite: npm run build.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const outFile = join(repoRoot, "dist", "public-browser.mcpb");
const smitheryFile = join(repoRoot, "dist", "public-browser.smithery.mcpb");

if (!existsSync(join(repoRoot, "build/index.js"))) {
  console.error("build/index.js is missing. Run npm run build first.");
  process.exit(1);
}

const stage = mkdtempSync(join(tmpdir(), "public-browser-mcpb-"));

try {
  cpSync(join(repoRoot, "build"), join(stage, "build"), {
    recursive: true,
    filter: (src) => !src.endsWith(".d.ts") && !src.endsWith(".map"),
  });
  for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md"]) {
    cpSync(join(repoRoot, file), join(stage, file));
  }
  cpSync(join(repoRoot, ".github/assets/logo-400.png"), join(stage, "icon.png"));

  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stage,
    stdio: "inherit",
  });
  rmSync(join(stage, "package-lock.json"));

  // Tool-Liste kommt aus dem gestageten Server selbst — beweist nebenbei,
  // dass das Bundle ohne npx und ohne Repo-node_modules startet.
  const client = new Client({ name: "build-mcpb", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: [join(stage, "build/index.js")], cwd: stage }),
  );
  const { tools } = await client.listTools();
  await client.close();
  if (tools.length === 0) throw new Error("staged server returned no tools");

  const manifest = {
    manifest_version: "0.3",
    name: pkg.name,
    display_name: "Public Browser",
    version: pkg.version,
    description:
      "Provides Chrome browser automation over CDP with stable accessibility-tree refs, multi-step plans in one call and multi-tab.",
    long_description:
      "Public Browser is an MCP server that drives a real Chrome instance over the Chrome DevTools Protocol - no Playwright dependency, no extension bridge. Tools cover navigation, accessibility-tree reads, forms, tabs, downloads and server-side multi-step plans. MIT licensed, with an optional Python script API (`pip install publicbrowser`).",
    author: { name: "Julian Friedrich", url: "https://github.com/Silbercue" },
    repository: { type: "git", url: "https://github.com/Silbercue/public-browser" },
    homepage: "https://github.com/Silbercue/public-browser#readme",
    documentation: "https://github.com/Silbercue/public-browser#readme",
    support: "https://github.com/Silbercue/public-browser/issues",
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "build/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/build/index.js"] },
    },
    tools: tools.map((t) => ({ name: t.name, description: (t.description ?? "").split("\n")[0] })),
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
    keywords: ["browser automation", "chrome", "cdp", "devtools protocol", "web scraping", "playwright alternative"],
    license: pkg.license,
  };
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync("npx", ["-y", MCPB_CLI, "validate", join(stage, "manifest.json")], { stdio: "inherit" });
  execFileSync("npx", ["-y", MCPB_CLI, "pack", stage, outFile], { stdio: "inherit" });

  // Smithery uebernimmt `tools` unveraendert als Server-Card und verlangt je Tool ein
  // inputSchema (sonst 400). Das MCPB-Schema verbietet das Feld, `mcpb pack` bricht damit
  // ab — deshalb eine zweite Archiv-Variante, in der nur manifest.json ersetzt wird.
  manifest.tools = tools.map((t, i) => ({ ...manifest.tools[i], inputSchema: t.inputSchema }));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  cpSync(outFile, smitheryFile);
  execFileSync("zip", ["-q", "-j", smitheryFile, join(stage, "manifest.json")]);

  console.log(`\n${outFile} (${tools.length} tools, v${pkg.version})\n${smitheryFile}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
