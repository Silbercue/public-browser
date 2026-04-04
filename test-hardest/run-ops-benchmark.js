#!/usr/bin/env node
/**
 * SilbercueChrome — Operations Mikro-Benchmark
 *
 * Misst die Latenz einzelner Browser-Operationen (click, type, navigate, etc.)
 * mit N Wiederholungen. Gibt Median / Min / Max aus.
 *
 * Usage:
 *   node run-ops-benchmark.js "Playwright MCP" [repeats=10]
 *   node run-ops-benchmark.js "SilbercueChrome" 20
 */

const { chromium } = require('playwright');
const fs = require('fs');

const RUN_NAME = process.argv[2] || 'Unnamed';
const REPEATS  = parseInt(process.argv[3] || '10');
const BASE_URL = 'http://localhost:4242/ops-benchmark.html';
const TAB_URL  = 'http://localhost:4242/tab-target.html';

// ── Helpers ──────────────────────────────────────────────────────────────────

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const median = s.length % 2 === 0
    ? Math.round((s[s.length/2-1] + s[s.length/2]) / 2)
    : s[Math.floor(s.length/2)];
  const mean   = Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  return { median, mean, min: s[0], max: s[s.length-1], samples: s };
}

async function measure(label, n, fn) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t = Date.now();
    await fn(i);
    times.push(Date.now() - t);
  }
  const r = stats(times);
  const bar = '█'.repeat(Math.min(Math.round(r.median / 20), 40));
  console.log(
    `  ${label.padEnd(26)} median:${String(r.median).padStart(5)}ms  min:${String(r.min).padStart(4)}ms  max:${String(r.max).padStart(4)}ms  ${bar}`
  );
  return r;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSilbercueChrome Ops Benchmark — "${RUN_NAME}"  (${REPEATS}x each)`);
  console.log('='.repeat(72));

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext();
  const page    = await ctx.newPage();

  const results = {};

  // ── Navigate ──────────────────────────────────────────────────────────────
  console.log('\n[Navigate]');

  results['navigate_cold'] = await measure('navigate (cold)', REPEATS, async () => {
    await page.goto(BASE_URL, { waitUntil: 'load' });
  });

  results['navigate_cached'] = await measure('navigate (cached)', REPEATS, async () => {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  });

  // Reset to clean state
  await page.goto(BASE_URL, { waitUntil: 'load' });

  // ── Snapshot / Read DOM ───────────────────────────────────────────────────
  console.log('\n[Read DOM / Snapshot]');

  results['read_text'] = await measure('read textContent', REPEATS, async () => {
    await page.textContent('#read-value-1');
  });

  results['read_attribute'] = await measure('read data-attribute', REPEATS, async () => {
    await page.getAttribute('#attr-target', 'data-bench');
  });

  results['evaluate_simple'] = await measure('evaluate (simple)', REPEATS, async () => {
    await page.evaluate(() => document.title);
  });

  results['evaluate_dom_count'] = await measure('evaluate (DOM count)', REPEATS, async () => {
    await page.evaluate(() => document.querySelectorAll('*').length);
  });

  // ── Click ─────────────────────────────────────────────────────────────────
  console.log('\n[Click]');

  results['click_by_id'] = await measure('click (by id)', REPEATS, async () => {
    await page.click('#btn-click-target');
  });

  results['click_by_text'] = await measure('click (by text)', REPEATS, async () => {
    await page.click('button:has-text("Button B")');
  });

  results['click_by_selector'] = await measure('click (css selector)', REPEATS, async () => {
    await page.click('#btn-click-c');
  });

  // ── Type ──────────────────────────────────────────────────────────────────
  console.log('\n[Type / Fill]');

  results['fill_short'] = await measure('fill short (10 chars)', REPEATS, async () => {
    await page.fill('#input-short', 'HelloTest!');
  });

  results['fill_long'] = await measure('fill long (100 chars)', REPEATS, async () => {
    await page.fill('#input-long', 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut');
  });

  results['type_slow'] = await measure('type char-by-char (20)', REPEATS, async () => {
    await page.click('#input-short');
    await page.selectAll?.();
    await page.type('#input-short', 'SilbercueChrome!!!!', { delay: 0 });
  });

  results['fill_textarea'] = await measure('fill textarea (50 chars)', REPEATS, async () => {
    await page.fill('#input-textarea', 'Benchmark textarea fill with 50 characters here!!');
  });

  // ── Select / Checkbox ─────────────────────────────────────────────────────
  console.log('\n[Select / Checkbox]');

  results['select_option'] = await measure('selectOption', REPEATS, async (i) => {
    const opts = ['alpha','beta','gamma','delta'];
    await page.selectOption('#select-target', opts[i % opts.length]);
  });

  results['checkbox_check'] = await measure('check checkbox', REPEATS, async (i) => {
    if (i % 2 === 0) await page.check('#checkbox-target');
    else await page.uncheck('#checkbox-target');
  });

  // ── Scroll ────────────────────────────────────────────────────────────────
  console.log('\n[Scroll]');

  results['scroll_to_bottom'] = await measure('scroll to bottom', REPEATS, async () => {
    await page.evaluate(() => {
      const s = document.getElementById('scroll-target');
      s.scrollTop = s.scrollHeight;
    });
  });

  results['scroll_to_top'] = await measure('scroll to top', REPEATS, async () => {
    await page.evaluate(() => {
      const s = document.getElementById('scroll-target');
      s.scrollTop = 0;
    });
  });

  results['scroll_into_view'] = await measure('scrollIntoView', REPEATS, async () => {
    await page.locator('#scroll-bottom-marker').scrollIntoViewIfNeeded();
  });

  // ── Wait For ──────────────────────────────────────────────────────────────
  console.log('\n[Wait / Async]');

  results['wait_for_visible'] = await measure('waitForSelector (50ms)', REPEATS, async () => {
    await page.evaluate(() => {
      const el = document.getElementById('async-element');
      el.style.display = 'none';
      setTimeout(() => { el.style.display = 'block'; }, 50);
    });
    await page.waitForSelector('#async-element:visible', { timeout: 2000 });
  });

  results['wait_for_text'] = await measure('waitForFunction (text)', REPEATS, async () => {
    const ts = Date.now();
    await page.evaluate((t) => {
      setTimeout(() => { document.getElementById('dynamic-text').textContent = 'ts-' + t; }, 30);
    }, ts);
    await page.waitForFunction(
      (t) => document.getElementById('dynamic-text').textContent === 'ts-' + t,
      ts, { timeout: 2000 }
    );
  });

  // ── Screenshot ────────────────────────────────────────────────────────────
  console.log('\n[Screenshot / Capture]');

  results['screenshot_viewport'] = await measure('screenshot (viewport)', REPEATS, async () => {
    await page.screenshot({ type: 'png' });
  });

  results['screenshot_element'] = await measure('screenshot (element)', REPEATS, async () => {
    await page.locator('.section').first().screenshot({ type: 'png' });
  });

  // ── Tab Operations ────────────────────────────────────────────────────────
  console.log('\n[Tab Operations]');

  results['tab_open_close'] = await measure('tab open + close', REPEATS, async () => {
    const tab = await ctx.newPage();
    await tab.goto(TAB_URL, { waitUntil: 'domcontentloaded' });
    await tab.close();
  });

  results['tab_open_read_close'] = await measure('tab open+read+close', REPEATS, async () => {
    const tab = await ctx.newPage();
    await tab.goto(TAB_URL, { waitUntil: 'domcontentloaded' });
    await tab.textContent('#tab-value');
    await tab.close();
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalMedian = Object.values(results).reduce((s, r) => s + r.median, 0);
  console.log('\n' + '='.repeat(72));
  console.log(`  Total median sum: ${totalMedian}ms across ${Object.keys(results).length} operations`);
  console.log('='.repeat(72));

  // Build output for Compare-Reiter (adapt to ops format)
  const output = {
    name: RUN_NAME,
    type: 'ops',
    timestamp: new Date().toISOString(),
    repeats: REPEATS,
    summary: {
      operations: Object.keys(results).length,
      total_median_ms: totalMedian
    },
    operations: {}
  };
  for (const [key, r] of Object.entries(results)) {
    output.operations[key] = { median_ms: r.median, mean_ms: r.mean, min_ms: r.min, max_ms: r.max };
  }

  const slug = RUN_NAME.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `ops-${slug}-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\n  Saved: ${filename}\n`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
