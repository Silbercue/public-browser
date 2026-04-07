#!/usr/bin/env node
/**
 * SilbercueChrome Smoke Test — runs MCP tools against the live benchmark page.
 * Usage: node test-hardest/smoke-test.mjs
 * Requires: Chrome on port 9222, benchmark server on port 4242
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

let passed = 0;
let failed = 0;
const results = [];

function log(icon, name, ms, detail = "") {
  const d = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`  ${icon} ${name} ${DIM}(${ms}ms)${RESET}${d}`);
}

async function callTool(client, name, args = {}) {
  const t0 = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = res.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const hasImage = res.content?.some((c) => c.type === "image");
  return { text, hasImage, ms, isError: res.isError };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    results.push({ name, error: e.message });
    log(FAIL, name, 0, e.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── Main ──
console.log(`\n${BOLD}SilbercueChrome Smoke Test${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`${DIM}Connected — ${tools.tools.length} tools available${RESET}\n`);

// ── 1. Navigate to benchmark page ──
await test("navigate → localhost:4242", async () => {
  const r = await callTool(client, "navigate", { url: "http://localhost:4242" });
  assert(!r.isError, `navigate error: ${r.text}`);
  assert(r.text.includes("localhost:4242") || r.text.includes("Test Hardest"), `unexpected: ${r.text?.slice(0, 100)}`);
  log(PASS, "navigate → localhost:4242", r.ms);
});

// ── 2. tab_status (Epic 4, Story 4.1) ──
await test("tab_status — cached state", async () => {
  const r = await callTool(client, "tab_status");
  assert(!r.isError, `tab_status error: ${r.text}`);
  assert(r.text.includes("localhost:4242"), `URL not in status: ${r.text?.slice(0, 100)}`);
  log(PASS, "tab_status — cached state", r.ms, r.text?.split("\n")[0]);
});

// ── 3. read_page — accessibility tree ──
await test("read_page — a11y tree", async () => {
  const r = await callTool(client, "read_page");
  assert(!r.isError, `read_page error: ${r.text}`);
  assert(r.text.includes("SilbercueChrome") || r.text.includes("Test Hardest"), `page title missing`);
  const refCount = (r.text.match(/\[e\d+\]/g) || []).length;
  assert(refCount > 5, `too few refs: ${refCount}`);
  log(PASS, "read_page — a11y tree", r.ms, `${refCount} refs`);
});

// ── 4. virtual_desk (Epic 4, Story 4.3) — Story 15.6: Pro-Feature in Free-Tier ──
// Epic 9.9 / Story 15.6: virtual_desk is gated as Pro-Feature in the Free tier.
// The Free-Tier smoke-test expects a Pro-Feature error response (no crash).
await test("virtual_desk — Pro-Feature gated in Free tier", async () => {
  const r = await callTool(client, "virtual_desk");
  assert(r.isError, `expected Pro-Feature error, got success: ${r.text?.slice(0, 100)}`);
  assert(
    r.text?.includes("Pro-Feature"),
    `expected "Pro-Feature" in error text, got: ${r.text?.slice(0, 100)}`,
  );
  log(PASS, "virtual_desk — Pro-Feature gated in Free tier", r.ms);
});

// ── 5. screenshot ──
await test("screenshot — captures page", async () => {
  const r = await callTool(client, "screenshot");
  assert(!r.isError, `screenshot error: ${r.text}`);
  assert(r.hasImage, "no image in response");
  log(PASS, "screenshot — captures page", r.ms);
});

// ── 6. evaluate — JS execution ──
await test("evaluate — 2+2", async () => {
  const r = await callTool(client, "evaluate", { expression: "2 + 2" });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(r.text.includes("4"), `expected 4, got: ${r.text}`);
  log(PASS, "evaluate — 2+2", r.ms);
});

// ── 7. T1.1 — Click button (Benchmark Test) ──
await test("T1.1 — click button", async () => {
  // Click the T1.1 button by its ID
  const r2 = await callTool(client, "click", { selector: "#t1-1-btn" });
  assert(!r2.isError, `click error: ${r2.text}`);

  // Check result
  const r3 = await callTool(client, "evaluate", {
    expression: `document.getElementById('t1-1-result')?.textContent || document.getElementById('t1-1-status')?.textContent || 'NO_RESULT'`,
  });
  log(PASS, "T1.1 — click button", r2.ms, r3.text?.slice(0, 60));
});

// ── 8. evaluate — DOM query on benchmark ──
await test("evaluate — count test cards", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelectorAll('[data-test]').length`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  const count = parseInt(r.text);
  assert(count >= 20, `expected 20+ test cards, got: ${count}`);
  log(PASS, "evaluate — count test cards", r.ms, `${count} cards`);
});

// ── 9. switch_tab (Epic 4, Story 4.2) — Story 15.6: Pro-Feature in Free-Tier ──
// Epic 9.9 / Story 15.6: switch_tab is gated as Pro-Feature in the Free tier.
// The Free-Tier smoke-test expects a Pro-Feature error response (no crash).
await test("switch_tab — Pro-Feature gated in Free tier", async () => {
  const r1 = await callTool(client, "switch_tab", { action: "open", url: "about:blank" });
  assert(r1.isError, `expected Pro-Feature error, got success: ${r1.text?.slice(0, 100)}`);
  assert(
    r1.text?.includes("Pro-Feature"),
    `expected "Pro-Feature" in error text, got: ${r1.text?.slice(0, 100)}`,
  );
  log(PASS, "switch_tab — Pro-Feature gated in Free tier", r1.ms);
});

// ── 10. run_plan — batch execution (Epic 5, Story 5.1) ──
await test("run_plan — 3-step batch", async () => {
  const r = await callTool(client, "run_plan", {
    steps: [
      { tool: "evaluate", params: { expression: "'step1_ok'" } },
      { tool: "evaluate", params: { expression: "1 + 1" } },
      { tool: "evaluate", params: { expression: "document.title" } },
    ],
  });
  assert(!r.isError, `run_plan error: ${r.text}`);
  assert(r.text.includes("step1_ok"), `step1 missing in output`);
  assert(r.text.includes("2"), `step2 result missing`);
  log(PASS, "run_plan — 3-step batch", r.ms);
});

// ── 11. inspect_element (Epic 13, Story 13.1) — Story 15.6: Pro-Feature in Free-Tier ──
// Story 15.2 / 15.6: inspect_element is extracted to the Pro repo and is
// NOT registered in the Free-Tier tools/list. Calling it MUST fail with
// an "Unknown tool" MCP error. The Free-Tier smoke-test only verifies that
// the tool is absent from the listed tools.
await test("inspect_element — absent from Free tools/list", async () => {
  const listed = tools.tools.map((t) => t.name);
  assert(
    !listed.includes("inspect_element"),
    `inspect_element must NOT be in Free-Tier tools/list, got: ${listed.join(", ")}`,
  );
  log(PASS, "inspect_element — absent from Free tools/list", 0);
});

// ── 12. Visual Feedback nach evaluate (Epic 13, Story 13.3) — Story 15.6 ──
// Story 15.2 / 15.6: Visual Feedback (Geometry-Diff + Clip-Screenshot) is
// a Pro-Feature. In the Free-Tier the evaluate tool still runs style-change
// expressions, but the response MUST NOT contain a screenshot.
await test("evaluate style-change → NO screenshot in Free tier", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t1-1-btn').style.border = '3px solid red'`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(
    !r.hasImage,
    "Free tier evaluate style-change must NOT include a screenshot (Visual Feedback is Pro)",
  );
  log(PASS, "evaluate style-change → NO screenshot in Free tier", r.ms);
});

await test("evaluate no style-change → no screenshot", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t1-1-btn').textContent`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(!r.hasImage, "read-only evaluate should NOT include screenshot");
  log(PASS, "evaluate no style-change → no screenshot", r.ms);
});

await test("evaluate style-change (background) → NO screenshot in Free tier", async () => {
  const r = await callTool(client, "evaluate", {
    expression: `document.querySelector('#t1-1-btn').style.backgroundColor = 'yellow'`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(
    !r.hasImage,
    "Free tier evaluate style-change must NOT include a screenshot (Visual Feedback is Pro)",
  );
  log(PASS, "evaluate style-change (background) → NO screenshot in Free tier", r.ms);
});

await test("evaluate style-change (outline on body) → NO screenshot in Free tier", async () => {
  // document.body style-change — in Pro this would fall back to a viewport
  // screenshot; in Free the hook is not registered so no screenshot at all.
  const r = await callTool(client, "evaluate", {
    expression: `document.body.style.outline = '3px solid blue'`,
  });
  assert(!r.isError, `evaluate error: ${r.text}`);
  assert(
    !r.hasImage,
    "Free tier evaluate style-change must NOT include a screenshot (Visual Feedback is Pro)",
  );
  log(PASS, "evaluate style-change (outline on body) → NO screenshot in Free tier", r.ms);
});

// Restore original styles
await callTool(client, "evaluate", {
  expression: `(() => { const btn = document.getElementById('t1-1-btn'); btn.style.border = ''; btn.style.backgroundColor = ''; document.body.style.outline = ''; })()`,
});

// ── Summary ──
console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}  ${passed} passed, ${failed} failed${RESET}`);
if (results.length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  results.forEach((r) => console.log(`  ${FAIL} ${r.name}: ${r.error}`));
}
console.log();

await client.close();
process.exit(failed > 0 ? 1 : 0);
