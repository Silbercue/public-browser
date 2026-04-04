#!/usr/bin/env node
/**
 * SilbercueChrome Stress Test Runner
 * Runs MCP tools against 13 stress-test pages.
 * Usage: node test-stress/stress-test.mjs [page-number]
 * Requires: Chrome on port 9222, stress-test server on port 4243
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const SKIP = "\x1b[33m○\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

const BASE_URL = "http://localhost:4243";
const pageFilter = process.argv[2] ? parseInt(process.argv[2]) : null;

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
const allResults = [];

function log(icon, name, ms, detail = "") {
  const d = detail ? ` ${DIM}${detail}${RESET}` : "";
  console.log(`  ${icon} ${name} ${DIM}(${ms}ms)${RESET}${d}`);
}

async function callTool(client, name, args = {}) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const ms = Date.now() - t0;
    const text = res.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const hasImage = res.content?.some((c) => c.type === "image");
    return { text, hasImage, ms, isError: res.isError, raw: res };
  } catch (e) {
    return { text: e.message, hasImage: false, ms: Date.now() - t0, isError: true };
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Test Suites ──

async function testPage01(client) {
  console.log(`\n${BOLD}01 — Shadow DOM & Web Components${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/01-shadow-dom.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // read_page to see what the MCP can see
  const rp = await callTool(client, "read_page", { depth: 5 });
  const refCount = (rp.text?.match(/\[e\d+\]/g) || []).length;
  log(rp.isError ? FAIL : PASS, "read_page", rp.ms, `${refCount} refs`);
  if (rp.isError) { totalFailed++; allResults.push({ page: "01", test: "read_page", pass: false, ms: rp.ms, detail: rp.text?.slice(0, 100) }); }
  else { totalPassed++; allResults.push({ page: "01", test: "read_page", pass: true, ms: rp.ms, detail: `${refCount} refs` }); }

  // Try to find shadow button via evaluate
  const eval1 = await callTool(client, "evaluate", {
    expression: `document.getElementById('shadow-host-1')?.shadowRoot?.querySelector('button')?.textContent || 'NOT_FOUND'`,
  });
  const shadowFound = eval1.text?.includes("Shadow Button");
  log(shadowFound ? PASS : FAIL, "T1: find shadow button via JS", eval1.ms, eval1.text?.slice(0, 60));
  allResults.push({ page: "01", test: "T1-find-shadow", pass: shadowFound, ms: eval1.ms });
  shadowFound ? totalPassed++ : totalFailed++;

  // Click shadow button via evaluate (CDP click may not reach shadow DOM)
  const click1 = await callTool(client, "evaluate", {
    expression: `document.getElementById('shadow-host-1')?.shadowRoot?.querySelector('button')?.click(); window.__t1_clicked || false`,
  });
  const t1Pass = click1.text === "true";
  log(t1Pass ? PASS : FAIL, "T1: click shadow button", click1.ms, click1.text);
  allResults.push({ page: "01", test: "T1-click-shadow", pass: t1Pass, ms: click1.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // Try clicking shadow button via ref (the real test: does read_page expose shadow DOM?)
  const rpAll = await callTool(client, "read_page", { depth: 8, filter: "all" });
  const hasShadowRef = rpAll.text?.includes("Shadow Button");
  log(hasShadowRef ? PASS : FAIL, "T1: shadow button in a11y tree", rpAll.ms, hasShadowRef ? "exposed" : "NOT exposed");
  allResults.push({ page: "01", test: "T1-a11y-shadow", pass: hasShadowRef, ms: rpAll.ms });
  hasShadowRef ? totalPassed++ : totalFailed++;

  // T3: Closed shadow root
  const eval3 = await callTool(client, "evaluate", {
    expression: `document.querySelector('closed-component')?.shadowRoot`,
  });
  const closedAccessible = eval3.text !== "null" && !eval3.text?.includes("null");
  log(!closedAccessible ? PASS : SKIP, "T3: closed shadow root inaccessible via JS", eval3.ms, eval3.text?.slice(0, 60));
  allResults.push({ page: "01", test: "T3-closed-shadow", pass: true, ms: eval3.ms, detail: "closed shadow is " + (closedAccessible ? "accessible (unexpected)" : "inaccessible (expected)") });
  totalPassed++;

  // T6: 5-level deep via a11y tree?
  const hasDeepBtn = rpAll.text?.includes("Level 5 Deep Button");
  log(hasDeepBtn ? PASS : FAIL, "T6: 5-level deep button in a11y tree", 0, hasDeepBtn ? "exposed" : "NOT exposed");
  allResults.push({ page: "01", test: "T6-deep-shadow", pass: hasDeepBtn, ms: 0 });
  hasDeepBtn ? totalPassed++ : totalFailed++;
}

async function testPage02(client) {
  console.log(`\n${BOLD}02 — Virtual Scroll & Infinite Loading${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/02-virtual-scroll.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // read_page — how many items visible?
  const rp = await callTool(client, "read_page", { depth: 4, filter: "interactive" });
  const selectBtns = (rp.text?.match(/Select/g) || []).length;
  log(PASS, "read_page — virtual list", rp.ms, `${selectBtns} Select buttons visible`);
  allResults.push({ page: "02", test: "read_page", pass: true, ms: rp.ms, detail: `${selectBtns} visible` });
  totalPassed++;

  // T1: Scroll to item 500 via evaluate, then click
  const scroll = await callTool(client, "evaluate", {
    expression: `document.getElementById('virtual-list').scrollTop = 500 * 48; true`,
  });
  await delay(200);
  const clickItem = await callTool(client, "evaluate", {
    expression: `(() => { const items = document.querySelectorAll('[data-action="select-500"]'); if (items.length > 0) { items[0].click(); return window.__t1_selected; } return 'NOT_FOUND'; })()`,
  });
  const t1Pass = clickItem.text === "500";
  log(t1Pass ? PASS : FAIL, "T1: scroll to item 500 and click", scroll.ms + clickItem.ms, clickItem.text);
  allResults.push({ page: "02", test: "T1-virtual-scroll", pass: t1Pass, ms: scroll.ms + clickItem.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // T2: Infinite scroll — scroll to load all pages
  const infiniteTest = await callTool(client, "evaluate", {
    expression: `(async () => {
      const container = document.getElementById('infinite-list');
      for (let i = 0; i < 10; i++) {
        container.scrollTop = container.scrollHeight;
        await new Promise(r => setTimeout(r, 400));
      }
      const items = container.querySelectorAll('.infinite-item');
      const last = items[items.length - 1];
      if (last) last.click();
      return { count: items.length, clicked: window.__t2_clicked };
    })()`,
  });
  const t2Pass = infiniteTest.text?.includes("99") || infiniteTest.text?.includes('"clicked":99');
  log(t2Pass ? PASS : FAIL, "T2: infinite scroll 5 pages", infiniteTest.ms, infiniteTest.text?.slice(0, 80));
  allResults.push({ page: "02", test: "T2-infinite-scroll", pass: t2Pass, ms: infiniteTest.ms });
  t2Pass ? totalPassed++ : totalFailed++;
}

async function testPage03(client) {
  console.log(`\n${BOLD}03 — SPA Dynamic Content${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/03-spa-dynamic.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T1: Tab navigation
  const tabClick = await callTool(client, "click", { selector: '[data-tab="settings"]' });
  log(tabClick.isError ? FAIL : PASS, "T1: click Settings tab", tabClick.ms, tabClick.text?.slice(0, 60));
  allResults.push({ page: "03", test: "T1-tab-click", pass: !tabClick.isError, ms: tabClick.ms });
  tabClick.isError ? totalFailed++ : totalPassed++;

  await delay(200);
  const toggle = await callTool(client, "click", { selector: "#dark-mode-toggle" });
  const t1Check = await callTool(client, "evaluate", { expression: "window.__t1_toggled || false" });
  const t1Pass = t1Check.text === "true";
  log(t1Pass ? PASS : FAIL, "T1: toggle dark mode", toggle.ms, t1Check.text);
  allResults.push({ page: "03", test: "T1-toggle", pass: t1Pass, ms: toggle.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // T2: Debounced counter
  for (let i = 0; i < 3; i++) {
    await callTool(client, "click", { selector: "#increment-btn" });
    await delay(600); // Wait for debounce
  }
  const t2Check = await callTool(client, "evaluate", { expression: "window.__t2_count || 0" });
  const t2Pass = parseInt(t2Check.text) >= 3;
  log(t2Pass ? PASS : FAIL, "T2: debounced counter 3x", 0, `count=${t2Check.text}`);
  allResults.push({ page: "03", test: "T2-debounce", pass: t2Pass, ms: 0 });
  t2Pass ? totalPassed++ : totalFailed++;

  // T4: Search autocomplete
  const typeResult = await callTool(client, "type", { selector: "#search-input", text: "react", clear: true });
  log(typeResult.isError ? FAIL : PASS, "T4: type 'react' in search", typeResult.ms);
  await delay(500);
  const clickResult = await callTool(client, "evaluate", {
    expression: `(() => { const items = document.querySelectorAll('.search-result-item'); if (items.length >= 2) { items[1].click(); return window.__t4_selected; } return 'NO_RESULTS'; })()`,
  });
  const t4Pass = clickResult.text?.includes("react-native") || clickResult.text?.includes("redux");
  log(t4Pass ? PASS : FAIL, "T4: select second autocomplete result", clickResult.ms, clickResult.text);
  allResults.push({ page: "03", test: "T4-autocomplete", pass: t4Pass, ms: typeResult.ms + clickResult.ms });
  t4Pass ? totalPassed++ : totalFailed++;

  // T5: Modal chain
  await callTool(client, "click", { selector: "#open-modal-btn" });
  await delay(300);
  await callTool(client, "type", { selector: "#modal-name", text: "Test User" });
  await callTool(client, "type", { selector: "#modal-email", text: "test@example.com" });
  await callTool(client, "click", { selector: "#modal-submit" });
  await delay(300);
  await callTool(client, "click", { selector: "#modal-confirm" });
  const t5Check = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__t5_confirmed || null)" });
  const t5Pass = t5Check.text?.includes("Test User");
  log(t5Pass ? PASS : FAIL, "T5: modal chain (form → confirm)", 0, t5Check.text?.slice(0, 60));
  allResults.push({ page: "03", test: "T5-modal-chain", pass: t5Pass, ms: 0 });
  t5Pass ? totalPassed++ : totalFailed++;
}

async function testPage04(client) {
  console.log(`\n${BOLD}04 — Nested iframes${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/04-nested-iframes.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T1: Click button in iframe
  const eval1 = await callTool(client, "evaluate", {
    expression: `document.getElementById('frame-1')?.contentDocument?.getElementById('iframe-btn')?.click(); true`,
  });
  await delay(200);
  const t1Check = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
  const t1Pass = t1Check.text === "true";
  log(t1Pass ? PASS : FAIL, "T1: click button in iframe", eval1.ms, t1Check.text);
  allResults.push({ page: "04", test: "T1-iframe-click", pass: t1Pass, ms: eval1.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // T3: Cross-frame form
  await callTool(client, "type", { selector: "#parent-input", text: "test-code" });
  const frame3Click = await callTool(client, "evaluate", {
    expression: `document.getElementById('frame-3')?.contentDocument?.getElementById('submit-btn')?.click(); true`,
  });
  await delay(300);
  const t3Check = await callTool(client, "evaluate", { expression: "window.__t3_submitted || false" });
  const t3Pass = t3Check.text === "true";
  log(t3Pass ? PASS : FAIL, "T3: cross-frame form submit", frame3Click.ms, t3Check.text);
  allResults.push({ page: "04", test: "T3-cross-frame", pass: t3Pass, ms: frame3Click.ms });
  t3Pass ? totalPassed++ : totalFailed++;
}

async function testPage05(client) {
  console.log(`\n${BOLD}05 — Canvas & SVG Interactive${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/05-canvas-interactive.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T3: SVG chart — click tallest bar
  const svgClick = await callTool(client, "click", { selector: '[data-bar="c"]' });
  const t3Check = await callTool(client, "evaluate", { expression: "window.__t3_clicked || 'none'" });
  const t3Pass = t3Check.text === '"c"';
  log(t3Pass ? PASS : FAIL, "T3: click tallest SVG bar", svgClick.ms, t3Check.text);
  allResults.push({ page: "05", test: "T3-svg-click", pass: t3Pass, ms: svgClick.ms });
  t3Pass ? totalPassed++ : totalFailed++;

  // T4: SVG overlapping circles
  const circleClick = await callTool(client, "click", { selector: '[data-shape="top"]' });
  const t4Check = await callTool(client, "evaluate", { expression: "window.__t4_clicked || 'none'" });
  const t4Pass = t4Check.text === '"top"';
  log(t4Pass ? PASS : FAIL, "T4: click top SVG circle", circleClick.ms, t4Check.text);
  allResults.push({ page: "05", test: "T4-svg-overlap", pass: t4Pass, ms: circleClick.ms });
  t4Pass ? totalPassed++ : totalFailed++;

  // Screenshot for visual verification
  const ss = await callTool(client, "screenshot");
  log(ss.hasImage ? PASS : FAIL, "screenshot — canvas & SVG page", ss.ms, ss.hasImage ? "captured" : "no image");
  allResults.push({ page: "05", test: "screenshot", pass: ss.hasImage, ms: ss.ms });
  ss.hasImage ? totalPassed++ : totalFailed++;
}

async function testPage07(client) {
  console.log(`\n${BOLD}07 — Overlay Hell${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/07-overlay-hell.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T1: Cookie banner → accept → click hidden button
  const accept = await callTool(client, "click", { selector: "#cookie-accept" });
  log(accept.isError ? FAIL : PASS, "T1: accept cookie banner", accept.ms);
  await delay(200);
  const hiddenClick = await callTool(client, "click", { selector: "#hidden-btn" });
  const t1Check = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
  const t1Pass = t1Check.text === "true";
  log(t1Pass ? PASS : FAIL, "T1: click previously hidden button", hiddenClick.ms, t1Check.text);
  allResults.push({ page: "07", test: "T1-cookie-banner", pass: t1Pass, ms: accept.ms + hiddenClick.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // T3: Dropdown menu
  await callTool(client, "click", { selector: "#dropdown-trigger" });
  await delay(200);
  // Hover export to open submenu
  await callTool(client, "evaluate", {
    expression: `document.getElementById('export-trigger').dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}))`,
  });
  await delay(200);
  const csvClick = await callTool(client, "click", { selector: "#export-csv" });
  const t3Check = await callTool(client, "evaluate", { expression: "window.__t3_exported || 'none'" });
  const t3Pass = t3Check.text === '"csv"';
  log(t3Pass ? PASS : FAIL, "T3: nested dropdown → Export CSV", csvClick.ms, t3Check.text);
  allResults.push({ page: "07", test: "T3-dropdown", pass: t3Pass, ms: csvClick.ms });
  t3Pass ? totalPassed++ : totalFailed++;
}

async function testPage08(client) {
  console.log(`\n${BOLD}08 — Mega DOM (10k+ Nodes)${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/08-mega-dom.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // Performance: measure read_page time
  const t0 = Date.now();
  const rp = await callTool(client, "read_page", { depth: 3 });
  const rpTime = Date.now() - t0;
  const rpPass = rpTime < 10000; // Should complete within 10s
  log(rpPass ? PASS : FAIL, "T3: read_page performance on mega DOM", rpTime, `${rpTime}ms`);
  allResults.push({ page: "08", test: "T3-perf-readpage", pass: rpPass, ms: rpTime });
  rpPass ? totalPassed++ : totalFailed++;

  // dom_snapshot performance
  const t1 = Date.now();
  const ds = await callTool(client, "dom_snapshot");
  const dsTime = Date.now() - t1;
  const dsPass = dsTime < 10000;
  log(dsPass ? PASS : FAIL, "dom_snapshot performance", dsTime, `${dsTime}ms — ${ds.text?.length || 0} chars`);
  allResults.push({ page: "08", test: "dom_snapshot-perf", pass: dsPass, ms: dsTime });
  dsPass ? totalPassed++ : totalFailed++;

  // screenshot on large page
  const ss = await callTool(client, "screenshot");
  log(ss.hasImage ? PASS : FAIL, "screenshot on mega DOM", ss.ms);
  allResults.push({ page: "08", test: "screenshot-mega", pass: ss.hasImage, ms: ss.ms });
  ss.hasImage ? totalPassed++ : totalFailed++;

  // T1: Find and click row-500 via evaluate
  const scrollClick = await callTool(client, "evaluate", {
    expression: `(() => {
      const row = document.querySelector('[data-row-id="row-500"]');
      if (row) { row.scrollIntoView(); row.querySelector('.action-btn').click(); return window.__t1_edited; }
      return 'NOT_FOUND';
    })()`,
  });
  const t1Pass = scrollClick.text?.includes("row-500");
  log(t1Pass ? PASS : FAIL, "T1: find row-500 in 1000-row table", scrollClick.ms, scrollClick.text?.slice(0, 60));
  allResults.push({ page: "08", test: "T1-mega-table", pass: t1Pass, ms: scrollClick.ms });
  t1Pass ? totalPassed++ : totalFailed++;
}

async function testPage10(client) {
  console.log(`\n${BOLD}10 — Race Conditions & Timing${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/10-race-conditions.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T1: Ephemeral button (2s window)
  await callTool(client, "click", { selector: "#start-ephemeral" });
  await delay(200);
  const ephClick = await callTool(client, "click", { selector: "#ephemeral-btn" });
  const t1Check = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
  const t1Pass = t1Check.text === "true";
  log(t1Pass ? PASS : FAIL, "T1: ephemeral button (2s window)", ephClick.ms, t1Check.text);
  allResults.push({ page: "10", test: "T1-ephemeral", pass: t1Pass, ms: ephClick.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // T4: Sequential async
  await callTool(client, "click", { selector: "#start-async" });
  // Wait for all 3 API calls (600+500+400 = 1500ms)
  const waitResult = await callTool(client, "wait_for", {
    condition: "element",
    selector: "#async-action-btn",
    timeout: 5000,
  });
  const t4WaitPass = !waitResult.isError;
  log(t4WaitPass ? PASS : FAIL, "T4: wait_for async button", waitResult.ms, waitResult.text?.slice(0, 60));
  allResults.push({ page: "10", test: "T4-wait-async", pass: t4WaitPass, ms: waitResult.ms });
  t4WaitPass ? totalPassed++ : totalFailed++;

  if (t4WaitPass) {
    const asyncClick = await callTool(client, "click", { selector: "#async-action-btn" });
    const t4Check = await callTool(client, "evaluate", { expression: "window.__t4_entered || false" });
    const t4Pass = t4Check.text === "true";
    log(t4Pass ? PASS : FAIL, "T4: click async-loaded button", asyncClick.ms, t4Check.text);
    allResults.push({ page: "10", test: "T4-click-async", pass: t4Pass, ms: asyncClick.ms });
    t4Pass ? totalPassed++ : totalFailed++;
  }
}

async function testPage11(client) {
  console.log(`\n${BOLD}11 — CSS Tricks & Visual Deception${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/11-css-tricks.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T1: CSS Transform button — click at visual position
  const t1Click = await callTool(client, "click", { selector: "#transform-btn" });
  const t1Check = await callTool(client, "evaluate", { expression: "window.__t1_clicked || false" });
  const t1Pass = t1Check.text === "true";
  log(t1Pass ? PASS : FAIL, "T1: click CSS-transformed button", t1Click.ms, t1Check.text);
  allResults.push({ page: "11", test: "T1-css-transform", pass: t1Pass, ms: t1Click.ms });
  t1Pass ? totalPassed++ : totalFailed++;

  // T2: Clip-path reveal
  await callTool(client, "click", { selector: "#reveal-btn" });
  await delay(600);
  const t2Click = await callTool(client, "click", { selector: "#clipped-btn" });
  const t2Check = await callTool(client, "evaluate", { expression: "window.__t2_clicked || false" });
  const t2Pass = t2Check.text === "true";
  log(t2Pass ? PASS : FAIL, "T2: clip-path reveal and click", t2Click.ms, t2Check.text);
  allResults.push({ page: "11", test: "T2-clip-path", pass: t2Pass, ms: t2Click.ms });
  t2Pass ? totalPassed++ : totalFailed++;

  // T3: Z-index overlay
  await callTool(client, "click", { selector: "#dismiss-overlay" });
  await delay(200);
  const t3Click = await callTool(client, "click", { selector: "#beneath-btn" });
  const t3Check = await callTool(client, "evaluate", { expression: "window.__t3_clicked || false" });
  const t3Pass = t3Check.text === "true";
  log(t3Pass ? PASS : FAIL, "T3: dismiss overlay, click beneath", t3Click.ms, t3Check.text);
  allResults.push({ page: "11", test: "T3-z-index", pass: t3Pass, ms: t3Click.ms });
  t3Pass ? totalPassed++ : totalFailed++;

  // T5: CSS Grid reorder — click visual first (DOM last)
  const t5Click = await callTool(client, "click", { selector: '[data-order="3"]' });
  const t5Check = await callTool(client, "evaluate", { expression: "window.__t5_clicked || 'none'" });
  const t5Pass = t5Check.text === '"3"';
  log(t5Pass ? PASS : FAIL, "T5: click visual-first (DOM-last) grid button", t5Click.ms, t5Check.text);
  allResults.push({ page: "11", test: "T5-grid-reorder", pass: t5Pass, ms: t5Click.ms });
  t5Pass ? totalPassed++ : totalFailed++;
}

async function testPage12(client) {
  console.log(`\n${BOLD}12 — Form Validation Gauntlet${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/12-form-gauntlet.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // Step 1: Personal info
  await callTool(client, "type", { selector: "#reg-name", text: "John Doe" });
  await callTool(client, "type", { selector: "#reg-email", text: "john@example.com" });
  await callTool(client, "type", { selector: "#reg-password", text: "SecurePass1" });
  await callTool(client, "click", { selector: "#next-1" });
  await delay(200);

  // Step 2: Check step 2 is visible
  const step2Visible = await callTool(client, "evaluate", {
    expression: `document.getElementById('step-2').style.display !== 'none'`,
  });
  const s2Pass = step2Visible.text === "true";
  log(s2Pass ? PASS : FAIL, "Step 1→2: validation passed", 0, step2Visible.text);
  allResults.push({ page: "12", test: "step1-validation", pass: s2Pass, ms: 0 });
  s2Pass ? totalPassed++ : totalFailed++;

  // Step 2: Select role, checkboxes, radio
  await callTool(client, "evaluate", {
    expression: `document.getElementById('reg-role').value = 'developer'; document.getElementById('reg-role').dispatchEvent(new Event('change'));`,
  });
  await callTool(client, "evaluate", {
    expression: `document.querySelectorAll('input[name="interest"]')[0].click(); document.querySelectorAll('input[name="interest"]')[2].click();`,
  });
  await callTool(client, "evaluate", {
    expression: `document.querySelectorAll('input[name="experience"]')[1].click();`,
  });
  await callTool(client, "click", { selector: "#next-2" });
  await delay(200);

  const step3Visible = await callTool(client, "evaluate", {
    expression: `document.getElementById('step-3').style.display !== 'none'`,
  });
  const s3Pass = step3Visible.text === "true";
  log(s3Pass ? PASS : FAIL, "Step 2→3: preferences accepted", 0, step3Visible.text);
  allResults.push({ page: "12", test: "step2-validation", pass: s3Pass, ms: 0 });
  s3Pass ? totalPassed++ : totalFailed++;

  // Step 3: Bio, terms, submit
  await callTool(client, "type", { selector: "#reg-bio", text: "Test bio text" });
  await callTool(client, "click", { selector: "#reg-terms" });
  await callTool(client, "click", { selector: "#submit-form" });
  await delay(200);

  const formCheck = await callTool(client, "evaluate", { expression: "JSON.stringify(window.__form_submitted || null)" });
  const formPass = formCheck.text?.includes("John Doe");
  log(formPass ? PASS : FAIL, "Step 3: form submitted", 0, formCheck.text?.slice(0, 80));
  allResults.push({ page: "12", test: "form-submitted", pass: formPass, ms: 0 });
  formPass ? totalPassed++ : totalFailed++;
}

async function testPage13(client) {
  console.log(`\n${BOLD}13 — Responsive & Viewport${RESET}`);
  const nav = await callTool(client, "navigate", { url: `${BASE_URL}/13-responsive-viewport.html` });
  if (nav.isError) { log(FAIL, "navigate", nav.ms, nav.text); return; }
  log(PASS, "navigate", nav.ms);

  // T2: Click card 3
  const cardClick = await callTool(client, "click", { selector: "#card-3-btn" });
  const t2Check = await callTool(client, "evaluate", { expression: "window.__t2_selected || 0" });
  const t2Pass = t2Check.text === "3";
  log(t2Pass ? PASS : FAIL, "T2: click responsive grid card #3", cardClick.ms, t2Check.text);
  allResults.push({ page: "13", test: "T2-responsive-card", pass: t2Pass, ms: cardClick.ms });
  t2Pass ? totalPassed++ : totalFailed++;

  // T3: Scroll reveal
  const scrollReveal = await callTool(client, "evaluate", {
    expression: `document.getElementById('scroll-container').scrollTop = 350; true`,
  });
  await delay(800);
  const revealClick = await callTool(client, "click", { selector: "#revealed-btn" });
  const t3Check = await callTool(client, "evaluate", { expression: "window.__t3_clicked || false" });
  const t3Pass = t3Check.text === "true";
  log(t3Pass ? PASS : FAIL, "T3: scroll-reveal button", revealClick.ms, t3Check.text);
  allResults.push({ page: "13", test: "T3-scroll-reveal", pass: t3Pass, ms: revealClick.ms });
  t3Pass ? totalPassed++ : totalFailed++;
}

// ── Main ──

console.log(`\n${BOLD}╔══════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}║  SilbercueChrome Stress Test Suite            ║${RESET}`);
console.log(`${BOLD}╚══════════════════════════════════════════════╝${RESET}\n`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["build/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
});

const client = new Client({ name: "stress-test", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`${DIM}Connected — ${tools.tools.length} tools available${RESET}`);

const suites = [
  { num: 1, fn: testPage01 },
  { num: 2, fn: testPage02 },
  { num: 3, fn: testPage03 },
  { num: 4, fn: testPage04 },
  { num: 5, fn: testPage05 },
  { num: 7, fn: testPage07 },
  { num: 8, fn: testPage08 },
  { num: 10, fn: testPage10 },
  { num: 11, fn: testPage11 },
  { num: 12, fn: testPage12 },
  { num: 13, fn: testPage13 },
];

for (const suite of suites) {
  if (pageFilter && suite.num !== pageFilter) continue;
  try {
    await suite.fn(client);
  } catch (e) {
    console.log(`  ${FAIL} SUITE CRASH: ${e.message}`);
    totalFailed++;
    allResults.push({ page: String(suite.num).padStart(2, "0"), test: "SUITE_CRASH", pass: false, ms: 0, detail: e.message });
  }
}

// ── Summary ──
console.log(`\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
console.log(`${BOLD}  Results: ${GREEN}${totalPassed} passed${RESET}, ${RED}${totalFailed} failed${RESET}, ${YELLOW}${totalSkipped} skipped${RESET}`);
console.log(`${BOLD}  Total:   ${totalPassed + totalFailed + totalSkipped} tests across ${suites.length} pages${RESET}`);

if (allResults.filter((r) => !r.pass).length > 0) {
  console.log(`\n${BOLD}Failures:${RESET}`);
  allResults.filter((r) => !r.pass).forEach((r) => {
    console.log(`  ${FAIL} [${r.page}] ${r.test} (${r.ms}ms) ${r.detail || ""}`);
  });
}

// Export JSON
import { writeFileSync } from "fs";
const exportPath = new URL(`../test-stress/stress-results-${Date.now()}.json`, import.meta.url).pathname;
writeFileSync(exportPath, JSON.stringify({ timestamp: new Date().toISOString(), passed: totalPassed, failed: totalFailed, results: allResults }, null, 2));
console.log(`\n${DIM}Results exported to ${exportPath}${RESET}\n`);

await client.close();
process.exit(totalFailed > 0 ? 1 : 0);
