#!/usr/bin/env node
/**
 * Tool-Definitions Token Counter
 * Starts an MCP server, calls listTools(), and reports per-tool token estimates.
 * Budget: 5000 tokens (NFR4). Exit 1 on budget exceeded.
 *
 * Flags:
 *   --cmd <command>   Command to start the MCP server (default: "node")
 *   --args "<a b c>"  Space-separated args (default: "build/index.js")
 *
 * Without --cmd the script measures this repo's own build and enforces the
 * budget. With --cmd it measures a foreign server and only prints the TOTAL —
 * no PASS/FAIL verdict, exit 0. Example:
 *   node scripts/token-count.mjs --cmd npx --args "-y @playwright/mcp@0.0.80"
 *   node scripts/token-count.mjs --cmd npx --args "-y chrome-devtools-mcp@1.8.0"
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUDGET = 5000;
const TIMEOUT_MS = 15_000;
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const cmdFlag = flag("cmd");
const argsFlag = flag("args");
const isForeign = cmdFlag !== undefined;
const command = cmdFlag ?? "node";
const args = argsFlag !== undefined
  ? argsFlag.split(/\s+/).filter(Boolean)
  : isForeign
    ? []
    : ["build/index.js"];
// Fremde Server (npx-Download, Chrome-Start) brauchen laenger als der eigene Build.
const timeoutMs = isForeign ? 120_000 : TIMEOUT_MS;

const timeoutTimer = setTimeout(() => {
  console.error(`ERROR: token-count timed out after ${Math.round(timeoutMs / 1000)} s (connect/listTools hung)`);
  process.exit(1);
}, timeoutMs);

const transport = new StdioClientTransport({
  command,
  args,
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "token-count", version: "1.0.0" });

try {
  await client.connect(transport);

  const { tools } = await client.listTools();

  clearTimeout(timeoutTimer);

  // Per-tool estimates (for display/sorting)
  const perTool = tools.map((t) => ({
    name: t.name,
    tokens: Math.ceil(
      JSON.stringify({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }).length / 4
    ),
  }));

  perTool.sort((a, b) => b.tokens - a.tokens);

  // Total on the full serialised array (includes array overhead)
  const total = Math.ceil(JSON.stringify(tools).length / 4);

  // Output
  console.log(`\n${BOLD}Tool-Definitions Token Count${RESET}`);
  console.log(`  measured: ${[command, ...args].join(" ")}`);
  console.log("\u2550".repeat(39));

  for (const t of perTool) {
    console.log(`  ${t.name.padEnd(22)} ~${String(t.tokens).padStart(4)} tokens`);
  }

  console.log("\u2500".repeat(39));
  console.log(`  ${"TOTAL".padEnd(22)} ~${String(total).padStart(4)} tokens`);

  // Das Budget gilt nur fuer den eigenen Server; fremde Server werden gemessen,
  // nicht bewertet.
  if (isForeign) {
    console.log("\u2550".repeat(39) + "\n");
    process.exit(0);
  }

  console.log(`  ${"BUDGET".padEnd(22)}  ${String(BUDGET).padStart(4)} tokens`);

  const pass = total < BUDGET;
  const statusText = pass
    ? `${GREEN}PASS \u2713${RESET}`
    : `${RED}FAIL \u2717${RESET}`;
  console.log(`  ${"STATUS".padEnd(22)}  ${statusText}`);
  console.log("\u2550".repeat(39) + "\n");

  process.exit(pass ? 0 : 1);
} finally {
  clearTimeout(timeoutTimer);
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
