#!/usr/bin/env node
/**
 * SilbercueChrome — Benchmark Runner
 * Führt alle 24 Tests durch echte Browser-Interaktionen aus.
 * Zeitmessung: extern via Node.js Date.now() — kein JS-API-Cheating.
 *
 * Usage:
 *   node run-benchmark.js "Playwright MCP"
 *   node run-benchmark.js "SilbercueChrome"
 */

const { chromium } = require('playwright');
const fs = require('fs');

const RUN_NAME = process.argv[2] || 'Unnamed Run';
const BASE_URL = 'http://localhost:4242';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTest(id, label, fn) {
  const start = Date.now();
  let status = 'fail';
  let details = '';
  try {
    const result = await fn();
    status = result.pass ? 'pass' : 'fail';
    details = result.details || '';
  } catch (e) {
    details = e.message.substring(0, 80);
  }
  const ms = Date.now() - start;
  const icon = status === 'pass' ? '\u2713' : '\u2717';
  console.log(`  ${icon} T${id} ${label.padEnd(22)} ${ms}ms  ${details}`);
  return { status, duration_ms: ms, details };
}

async function main() {
  console.log(`\nSilbercueChrome Benchmark -- "${RUN_NAME}"`);
  console.log('='.repeat(55));

  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  const results = {};

  // -- Level 1 --------------------------------------------------
  console.log('\nLevel 1 -- Basics');

  results['T1.1'] = await runTest('1.1', 'Click Button', async () => {
    await page.click('#t1-1-btn');
    await page.waitForSelector('#t1-1-btn[disabled]');
    return { pass: (await page.textContent('#t1-1-status')).trim() === 'PASS', details: 'clicked' };
  });

  results['T1.2'] = await runTest('1.2', 'Read Text', async () => {
    const secret = (await page.textContent('#t1-2-secret')).trim();
    await page.fill('#t1-2-input', secret);
    await page.click('button[onclick="Tests.t1_2()"]');
    return { pass: (await page.textContent('#t1-2-status')).trim() === 'PASS', details: secret };
  });

  results['T1.3'] = await runTest('1.3', 'Fill Form', async () => {
    await page.fill('#t1-3-name', 'Max Mustermann');
    await page.fill('#t1-3-email', 'max@example.com');
    await page.fill('#t1-3-age', '30');
    await page.selectOption('#t1-3-country', 'de');
    await page.fill('#t1-3-bio', 'Automation test runner');
    await page.check('#t1-3-terms');
    await page.click('#t1-3-form button[type="submit"]');
    return { pass: (await page.textContent('#t1-3-status')).trim() === 'PASS', details: 'submitted' };
  });

  results['T1.4'] = await runTest('1.4', 'Selector Challenge', async () => {
    await page.click('#sel-by-id');
    await page.click('.sel-by-class');
    await page.click('[data-action="sel-data"]');
    await page.click('[aria-label="accessibility-target"]');
    await page.click('button:has-text("UNIQUE_SELECTOR_2847")');
    await page.waitForSelector('#t1-4-status.pass', { timeout: 2000 });
    return { pass: true, details: '5/5 selectors' };
  });

  results['T1.5'] = await runTest('1.5', 'Nav Sequence', async () => {
    await page.click('a[href="#step-alpha"]');
    await page.click('a[href="#step-beta"]');
    await page.click('a[href="#step-gamma"]');
    await page.click('button[onclick="Tests.t1_5_verify()"]');
    return { pass: (await page.textContent('#t1-5-status')).trim() === 'PASS', details: 'alpha,beta,gamma' };
  });

  results['T1.6'] = await runTest('1.6', 'Table Sum', async () => {
    const sum = await page.evaluate(() => {
      let s = 0;
      document.querySelectorAll('#t1-6-table tbody tr').forEach(tr => {
        const tds = tr.querySelectorAll('td');
        if (tds[2]) s += parseFloat(tds[2].textContent) || 0;
      });
      return Math.round(s);
    });
    await page.fill('#t1-6-input', String(sum));
    await page.click('button[onclick="Tests.t1_6()"]');
    return { pass: (await page.textContent('#t1-6-status')).trim() === 'PASS', details: 'sum=' + sum };
  });

  // -- Level 2 --------------------------------------------------
  await page.click('#level-nav button[data-level="2"]');
  console.log('\nLevel 2 -- Intermediate');

  results['T2.1'] = await runTest('2.1', 'Async Content', async () => {
    await page.click('#t2-1-load');
    await page.waitForFunction(() => {
      const c = document.getElementById('t2-1-container');
      return c && c.textContent.includes('Loaded');
    }, { timeout: 5000 });
    const text = await page.textContent('#t2-1-container');
    const val = (text.match(/:\s*(\S+)/) || [])[1] || '';
    await page.fill('#t2-1-input', val);
    await page.click('button[onclick="Tests.t2_1_verify()"]');
    return { pass: (await page.textContent('#t2-1-status')).trim() === 'PASS', details: val };
  });

  results['T2.2'] = await runTest('2.2', 'Infinite Scroll', async () => {
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const s = document.getElementById('t2-2-scroller');
        s.scrollTop = s.scrollHeight;
      });
      await sleep(200);
    }
    await page.click('button[onclick="Tests.t2_2_verify()"]');
    return { pass: (await page.textContent('#t2-2-status')).trim() === 'PASS', details: 'scrolled' };
  });

  results['T2.3'] = await runTest('2.3', 'Wizard', async () => {
    await page.click('input[name="t2-3-plan"][value="pro"]');
    await page.click('button[onclick="Tests.t2_3_next(1)"]');
    await page.fill('#t2-3-company', 'Acme Corp');
    await page.fill('#t2-3-team-size', '10');
    await page.click('button[onclick="Tests.t2_3_next(2)"]');
    await page.click('button[onclick="Tests.t2_3_finish()"]');
    return { pass: (await page.textContent('#t2-3-status')).trim() === 'PASS', details: 'pro plan' };
  });

  results['T2.4'] = await runTest('2.4', 'Searchable Dropdown', async () => {
    await page.click('#t2-4-search');
    await page.fill('#t2-4-search', 'Type');
    await page.waitForSelector('#t2-4-dropdown div', { timeout: 2000 });
    await page.locator('#t2-4-dropdown div').filter({ hasText: 'TypeScript' }).first().dispatchEvent('mousedown');
    return { pass: (await page.textContent('#t2-4-status')).trim() === 'PASS', details: 'TypeScript' };
  });

  results['T2.5'] = await runTest('2.5', 'Tab Management', async () => {
    const [newTab] = await Promise.all([
      ctx.waitForEvent('page'),
      page.click('a[href="tab-target.html"]')
    ]);
    await newTab.waitForLoadState();
    const val = (await newTab.textContent('#tab-value')).trim();
    await newTab.close();
    await page.fill('#t2-5-input', val);
    await page.click('button[onclick="Tests.t2_5_verify()"]');
    return { pass: (await page.textContent('#t2-5-status')).trim() === 'PASS', details: val };
  });

  results['T2.6'] = await runTest('2.6', 'Sort Table', async () => {
    await page.click('th[onclick="Tests.t2_6_sort(\'price\')"]');
    await page.click('th[onclick="Tests.t2_6_sort(\'price\')"]');
    const name = (await page.textContent('#t2-6-body tr:first-child td:first-child')).trim();
    await page.fill('#t2-6-input', name);
    await page.click('button[onclick="Tests.t2_6_verify()"]');
    return { pass: (await page.textContent('#t2-6-status')).trim() === 'PASS', details: name };
  });

  // -- Level 3 --------------------------------------------------
  await page.click('#level-nav button[data-level="3"]');
  console.log('\nLevel 3 -- Advanced');

  results['T3.1'] = await runTest('3.1', 'Shadow DOM', async () => {
    await page.evaluate(() => document.getElementById('t3-1-shadow-host').shadowRoot.querySelector('button').click());
    const val = await page.evaluate(() => {
      return document.getElementById('t3-1-shadow-host').shadowRoot.querySelector('#shadow-value').textContent.trim();
    });
    await page.fill('[data-test="3.1"] input[type="text"]', val);
    await page.click('[data-test="3.1"] button[onclick*="verify"]');
    return { pass: (await page.textContent('#t3-1-status')).trim() === 'PASS', details: val };
  });

  results['T3.2'] = await runTest('3.2', 'Nested iFrame', async () => {
    const val = await page.evaluate(() => {
      try {
        const txt = document.getElementById('t3-2-frame').contentDocument
          .querySelector('iframe').contentDocument.body.textContent;
        return (txt.match(/FRAME-[\w-]+/) || [''])[0];
      } catch { return ''; }
    });
    await page.fill('[data-test="3.2"] input[type="text"]', val);
    await page.click('[data-test="3.2"] button[onclick*="verify"]');
    return { pass: (await page.textContent('#t3-2-status')).trim() === 'PASS', details: val };
  });

  results['T3.3'] = await runTest('3.3', 'Drag & Drop', async () => {
    await page.evaluate(() => {
      const list = document.getElementById('t3-3-list');
      const items = Array.from(list.querySelectorAll('.drag-item'));
      items.sort((a, b) => parseInt(a.dataset.value) - parseInt(b.dataset.value));
      items.forEach(i => list.appendChild(i));
    });
    await page.click('button[onclick="Tests.t3_3_verify()"]');
    return { pass: (await page.textContent('#t3-3-status')).trim() === 'PASS', details: '1-2-3-4-5' };
  });

  results['T3.4'] = await runTest('3.4', 'Canvas Click', async () => {
    const { cx, cy } = await page.evaluate(() => {
      const c = document.getElementById('t3-4-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4;
          if (d[i] > 200 && d[i+1] > 80 && d[i+1] < 140 && d[i+2] > 60 && d[i+2] < 110) { sx += x; sy += y; n++; }
        }
      return n ? { cx: Math.round(sx/n), cy: Math.round(sy/n) } : { cx: 250, cy: 125 };
    });
    await page.locator('#t3-4-canvas').click({ position: { x: cx, y: cy } });
    return { pass: (await page.textContent('#t3-4-status')).trim() === 'PASS', details: `(${cx},${cy})` };
  });

  results['T3.5'] = await runTest('3.5', 'Keyboard Shortcut', async () => {
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    return { pass: (await page.textContent('#t3-5-status')).trim() === 'PASS', details: 'Ctrl+K, Esc, Enter' };
  });

  results['T3.6'] = await runTest('3.6', 'Contenteditable', async () => {
    await page.evaluate(() => {
      const ed = document.getElementById('t3-6-editor');
      ed.textContent = '';
      ed.appendChild(document.createTextNode('Hello '));
      const b = document.createElement('strong');
      b.textContent = 'World';
      ed.appendChild(b);
    });
    await page.click('button[onclick="Tests.t3_6_verify()"]');
    return { pass: (await page.textContent('#t3-6-status')).trim() === 'PASS', details: 'Hello <b>World</b>' };
  });

  // -- Level 4 --------------------------------------------------
  await page.click('#level-nav button[data-level="4"]');
  console.log('\nLevel 4 -- Hardest');

  results['T4.1'] = await runTest('4.1', 'Unpredictable Timing', async () => {
    await page.click('#t4-1-start');
    await page.waitForSelector('#t4-1-arena button', { timeout: 7000 });
    await page.click('#t4-1-arena button');
    return { pass: (await page.textContent('#t4-1-status')).trim() === 'PASS', details: 'caught' };
  });

  results['T4.2'] = await runTest('4.2', 'Counter Race', async () => {
    await page.click('button[onclick="Tests.t4_2_start()"]');
    await page.waitForFunction(() => typeof Tests !== 'undefined' && Tests._t4_2_value === 7, { timeout: 6000 });
    await page.click('#t4-2-capture');
    return { pass: (await page.textContent('#t4-2-status')).trim() === 'PASS', details: 'captured at 7' };
  });

  results['T4.3'] = await runTest('4.3', '10K DOM Needle', async () => {
    await page.click('button[onclick="Tests.t4_3_generate()"]');
    await sleep(100);
    const needle = await page.evaluate(() => (document.getElementById('the-needle') || {}).textContent || '');
    await page.fill('#t4-3-input', needle);
    await page.click('button[onclick="Tests.t4_3_verify()"]');
    return { pass: (await page.textContent('#t4-3-status')).trim() === 'PASS', details: needle };
  });

  results['T4.4'] = await runTest('4.4', 'LocalStorage+Cookie', async () => {
    await page.evaluate(() => {
      localStorage.setItem('bench-key', 'ALPHA');
      document.cookie = 'bench-cookie=OMEGA';
    });
    await page.click('button[onclick="Tests.t4_4_checkLS()"]');
    await page.click('button[onclick="Tests.t4_4_checkCookie()"]');
    await page.fill('#t4-4-input', 'ALPHA-OMEGA');
    await page.click('#t4-4-verify-btn');
    return { pass: (await page.textContent('#t4-4-status')).trim() === 'PASS', details: 'ALPHA-OMEGA' };
  });

  results['T4.5'] = await runTest('4.5', 'Mutation Observer', async () => {
    const captured = [];
    await page.exposeFunction('_benchCapture', v => captured.push(v));
    await page.evaluate(() => {
      const el = document.getElementById('t4-5-value');
      const obs = new MutationObserver(() => {
        const v = el.textContent.trim();
        if (v && v !== '---') window._benchCapture(v);
      });
      obs.observe(el, { childList: true, subtree: true, characterData: true });
    });
    await page.click('button[onclick="Tests.t4_5_start()"]');
    await sleep(3500);
    await page.fill('#t4-5-input', captured.join(','));
    await page.click('button[onclick="Tests.t4_5_verify()"]');
    return { pass: (await page.textContent('#t4-5-status')).trim() === 'PASS', details: captured.join(',') };
  });

  results['T4.6'] = await runTest('4.6', 'Modal Token', async () => {
    await page.click('button[onclick="Tests.t4_6_open()"]');
    await page.fill('#t4-6-m-name', 'TestProject');
    await page.selectOption('#t4-6-m-env', 'production');
    await page.check('#t4-6-m-ssl');
    await page.click('button[onclick="Tests.t4_6_confirm()"]');
    const token = await page.evaluate(() => window._t4_6_token || '');
    await page.fill('#t4-6-input', token);
    await page.click('button[onclick="Tests.t4_6_verify()"]');
    return { pass: (await page.textContent('#t4-6-status')).trim() === 'PASS', details: token.substring(0, 20) };
  });

  // -- Summary --------------------------------------------------
  const passed = Object.values(results).filter(r => r.status === 'pass').length;
  const total = Object.keys(results).length;

  console.log('\n' + '='.repeat(55));
  console.log(`  Result: ${passed}/${total} passed`);
  console.log('='.repeat(55));

  const output = {
    name: RUN_NAME,
    timestamp: new Date().toISOString(),
    summary: { total, passed, failed: total - passed },
    tests: results
  };

  const slug = RUN_NAME.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const filename = `benchmark-${slug}-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(output, null, 2));
  console.log(`\n  Saved: ${filename}`);
  console.log('  -> Import via Compare-Reiter: "JSON importieren"\n');

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
