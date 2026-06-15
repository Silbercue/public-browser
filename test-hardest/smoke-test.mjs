#!/usr/bin/env node
/**
 * Public Browser Smoke Test — runs MCP tools against the live benchmark page.
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
console.log(`\n${BOLD}Public Browser Smoke Test${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env },
});

const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const toolNames = tools.tools.map((t) => t.name);
console.log(`${DIM}Connected — ${tools.tools.length} tools available${RESET}\n`);

// ── 1. virtual_desk — must be called before navigate (session init gate) ──
await test("virtual_desk — session init", async () => {
  const r = await callTool(client, "virtual_desk");
  assert(!r.isError, `virtual_desk error: ${r.text}`);
  assert(typeof r.text === "string" && r.text.length > 0, `empty response`);
  assert(/Tab\s+\d+/.test(r.text), `expected tab list, got: ${r.text?.slice(0, 120)}`);
  log(PASS, "virtual_desk — session init", r.ms);
});

// ── 2. Navigate to benchmark page ──
await test("navigate → localhost:4242", async () => {
  const r = await callTool(client, "navigate", { url: "http://localhost:4242" });
  assert(!r.isError, `navigate error: ${r.text}`);
  assert(r.text.includes("localhost:4242") || r.text.includes("Test Hardest"), `unexpected: ${r.text?.slice(0, 100)}`);
  log(PASS, "navigate → localhost:4242", r.ms);
});

// ── 3. tab_status — present in tool set (free since Public Browser pivot) ──
await test("tab_status — present in tool set", async () => {
  assert(
    toolNames.includes("tab_status"),
    `tab_status must be in tool set (free since Epic 11), tools: ${toolNames.join(", ")}`,
  );
  log(PASS, "tab_status — present in tool set", 0);
});

// ── 4. view_page — accessibility tree ──
await test("view_page — a11y tree", async () => {
  const r = await callTool(client, "view_page");
  assert(!r.isError, `view_page error: ${r.text}`);
  assert(r.text.includes("Test Hardest") || r.text.includes("localhost"), `page title missing`);
  const refCount = (r.text.match(/\[e\d+\]/g) || []).length;
  assert(refCount > 5, `too few refs: ${refCount}`);
  log(PASS, "view_page — a11y tree", r.ms, `${refCount} refs`);
});

// ── 5. capture_image ──
await test("capture_image — captures page", async () => {
  const r = await callTool(client, "capture_image");
  assert(!r.isError, `capture_image error: ${r.text}`);
  assert(r.hasImage, "no image in response");
  log(PASS, "capture_image — captures page", r.ms);
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
  const r2 = await callTool(client, "click", { selector: "#t1-1-btn" });
  assert(!r2.isError, `click error: ${r2.text}`);

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

// ── 9. switch_tab — present in tool set (free since Public Browser pivot) ──
await test("switch_tab — present in tool set", async () => {
  assert(
    toolNames.includes("switch_tab"),
    `switch_tab must be in tool set (free since Epic 11), tools: ${toolNames.join(", ")}`,
  );
  log(PASS, "switch_tab — present in tool set", 0);
});

// ── 10. run_plan — batch execution ──
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

// ── 11. inspect_element — absent from Free tools/list ──
await test("inspect_element — absent from Free tools/list", async () => {
  assert(
    !toolNames.includes("inspect_element"),
    `inspect_element must NOT be in Free-Tier tools/list, got: ${toolNames.join(", ")}`,
  );
  log(PASS, "inspect_element — absent from Free tools/list", 0);
});

// ── 12. Visual Feedback nach evaluate — Free Tier ──
// Reset the evaluate-streak with a real page read first. These checks exercise
// Visual-Feedback gating (no screenshot in Free tier) — NOT the anti-spiral
// guard. view_page is a RESET_TOOL, mirroring a normal workflow where the agent
// re-reads the page between actions, so the streak stays well below Tier 3.
await callTool(client, "view_page");

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

// ── 13. evaluate-streak guard — must FIRE on a deliberate spiral (BUG-018/FR-045) ──
// This is the flip side of the checks above: the anti-spiral guard is a product
// feature. After a reset we drive a deliberate run of consecutive querySelector
// evaluates and assert that the Tier-3 guard kicks in with isError + a STOP
// message WHILE preserving the JS result (so the agent can still use it).
await test("evaluate-streak guard — STOP fires at threshold, result preserved", async () => {
  await callTool(client, "view_page"); // reset the streak to a known-zero baseline
  let guarded = null;
  for (let i = 1; i <= 10 && guarded === null; i++) {
    const r = await callTool(client, "evaluate", {
      expression: `document.querySelector('#t1-1-btn')?.textContent ?? 'spiral'`,
    });
    if (r.isError) guarded = r;
  }
  assert(guarded !== null, "guard never fired within 10 consecutive querySelector evaluates");
  assert(/STOP/.test(guarded.text), `expected STOP message, got: ${guarded.text?.slice(0, 140)}`);
  assert(
    /JS result:/.test(guarded.text),
    `Tier-3 must preserve the JS result, got: ${guarded.text?.slice(0, 200)}`,
  );
  log(PASS, "evaluate-streak guard — STOP fires at threshold, result preserved", guarded.ms);
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
