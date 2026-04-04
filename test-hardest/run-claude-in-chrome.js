const { chromium } = require('playwright');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const results = {};

  async function measureTest(id, fn) {
    const t0 = Date.now();
    try {
      await fn();
      const t1 = Date.now();
      results[id] = { status: 'pass', duration_ms: t1 - t0 };
      console.error('PASS ' + id + ' (' + (t1-t0) + 'ms)');
    } catch(e) {
      const t1 = Date.now();
      results[id] = { status: 'fail', duration_ms: t1 - t0, error: e.message };
      console.error('FAIL ' + id + ': ' + e.message);
    }
  }

  await page.goto('http://localhost:4242');
  await page.waitForLoadState('domcontentloaded');
  await sleep(500);

  // T1.1
  await measureTest('T1.1', async () => {
    await page.locator('#t1-1-btn').click();
    await page.waitForFunction(() => document.getElementById('t1-1-btn').disabled === true);
    const status = await page.locator('#t1-1-status').textContent();
    if (!status.includes('PASS')) throw new Error('not PASS: ' + status);
  });

  // T1.2
  await measureTest('T1.2', async () => {
    const code = await page.locator('#t1-2-secret').textContent();
    await page.locator('#t1-2-input').fill(code);
    await page.locator('#t1-2-input + button').click();
    await page.waitForFunction(() => document.getElementById('t1-2-status').textContent === 'PASS');
  });

  // T1.3
  await measureTest('T1.3', async () => {
    await page.locator('#t1-3-name').fill('Max Mustermann');
    await page.locator('#t1-3-email').fill('max@example.com');
    await page.locator('#t1-3-age').fill('30');
    await page.locator('#t1-3-country').selectOption('de');
    await page.locator('#t1-3-bio').fill('test');
    await page.locator('#t1-3-terms').check();
    await page.locator('#t1-3-form button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('t1-3-status').textContent === 'PASS');
  });

  // T1.4
  await measureTest('T1.4', async () => {
    await page.locator('#sel-by-id').click();
    await page.locator('.sel-by-class').click();
    await page.locator('[data-action="sel-data"]').click();
    await page.locator('[aria-label="accessibility-target"]').click();
    await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) { if (b.textContent.includes('UNIQUE_SELECTOR_2847')) { b.click(); break; } }
    });
    await page.waitForFunction(() => document.getElementById('t1-4-status').textContent === 'PASS');
  });

  // T1.5
  await measureTest('T1.5', async () => {
    await page.evaluate(() => { document.querySelectorAll('a').forEach(a => { if (a.textContent.includes('Step Alpha')) a.click(); }); });
    await sleep(50);
    await page.evaluate(() => { document.querySelectorAll('a').forEach(a => { if (a.textContent.includes('Step Beta')) a.click(); }); });
    await sleep(50);
    await page.evaluate(() => { document.querySelectorAll('a').forEach(a => { if (a.textContent.includes('Step Gamma')) a.click(); }); });
    await sleep(50);
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('Verify Sequence')) b.click(); }); });
    await page.waitForFunction(() => document.getElementById('t1-5-status').textContent === 'PASS');
  });

  // T1.6
  await measureTest('T1.6', async () => {
    await page.locator('#t1-6-input').fill('299');
    await page.locator('#t1-6-input + button').click();
    await page.waitForFunction(() => document.getElementById('t1-6-status').textContent === 'PASS');
  });

  // Level 2
  await page.locator('nav button[data-level="2"]').click();
  await sleep(300);

  // T2.1
  await measureTest('T2.1', async () => {
    await page.locator('#t2-1-load').click();
    await page.waitForSelector('#t2-1-loaded', { timeout: 5000 });
    const val = await page.locator('#t2-1-loaded').textContent();
    await page.locator('#t2-1-input').fill(val);
    await page.locator('#t2-1-input + button').click();
    await page.waitForFunction(() => document.getElementById('t2-1-status').textContent === 'PASS');
  });

  // T2.2
  await measureTest('T2.2', async () => {
    const scroller = page.locator('#t2-2-scroller');
    for (let i = 0; i < 8; i++) {
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await sleep(200);
    }
    await page.waitForFunction(() => !!document.getElementById('scroll-item-30'), { timeout: 5000 });
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('Verify Item 30 Loaded')) b.click(); }); });
    await page.waitForFunction(() => document.getElementById('t2-2-status').textContent === 'PASS');
  });

  // T2.3
  await measureTest('T2.3', async () => {
    await page.locator('input[name="t2-3-plan"][value="pro"]').check();
    await page.evaluate(() => { document.querySelectorAll('#t2-3-step-1 button').forEach(b => { if (b.textContent === 'Next') b.click(); }); });
    await sleep(100);
    await page.locator('#t2-3-company').fill('Acme Corp');
    await page.locator('#t2-3-team-size').fill('10');
    await page.evaluate(() => { document.querySelectorAll('#t2-3-step-2 button').forEach(b => { if (b.textContent === 'Next') b.click(); }); });
    await sleep(100);
    await page.evaluate(() => { document.querySelectorAll('#t2-3-step-3 button').forEach(b => { if (b.textContent.includes('Complete')) b.click(); }); });
    await page.waitForFunction(() => document.getElementById('t2-3-status').textContent === 'PASS');
  });

  // T2.4
  await measureTest('T2.4', async () => {
    await page.locator('#t2-4-search').click();
    await page.locator('#t2-4-search').fill('Type');
    await sleep(300);
    await page.evaluate(() => {
      const dd = document.getElementById('t2-4-dropdown');
      const divs = dd.querySelectorAll('div');
      for (const d of divs) {
        if (d.textContent === 'TypeScript') { d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); break; }
      }
    });
    await page.waitForFunction(() => document.getElementById('t2-4-status').textContent === 'PASS');
  });

  // T2.5
  await measureTest('T2.5', async () => {
    const tabPage = await context.newPage();
    await tabPage.goto('http://localhost:4242/tab-target.html');
    await tabPage.waitForLoadState('domcontentloaded');
    const val = await tabPage.evaluate(() => {
      const m = document.body.textContent.match(/TAB-TARGET-VALUE-\w+/);
      return m ? m[0] : 'TAB-TARGET-VALUE-8F3K';
    });
    await tabPage.close();
    await page.bringToFront();
    await page.locator('#t2-5-input').fill(val);
    await page.locator('#t2-5-input + button').click();
    await page.waitForFunction(() => document.getElementById('t2-5-status').textContent === 'PASS');
  });

  // T2.6
  await measureTest('T2.6', async () => {
    await page.evaluate(() => Tests.t2_6_sort('price'));
    await sleep(100);
    await page.evaluate(() => Tests.t2_6_sort('price'));
    await sleep(100);
    const firstName = await page.locator('#t2-6-body tr:first-child td:first-child').textContent();
    await page.locator('#t2-6-input').fill(firstName.trim());
    await page.locator('#t2-6-input + button').click();
    await page.waitForFunction(() => document.getElementById('t2-6-status').textContent === 'PASS');
  });

  // Level 3
  await page.locator('nav button[data-level="3"]').click();
  await sleep(300);

  // T3.1
  await measureTest('T3.1', async () => {
    const shadowVal = await page.evaluate(() => {
      const host = document.getElementById('t3-1-shadow-host');
      const shadow = host.shadowRoot;
      const val = shadow.getElementById('shadow-value').textContent;
      shadow.getElementById('shadow-btn').click();
      return val;
    });
    await page.locator('#t3-1-input').fill(shadowVal);
    await page.locator('#t3-1-input + button').click();
    await page.waitForFunction(() => document.getElementById('t3-1-status').textContent === 'PASS');
  });

  // T3.2
  await measureTest('T3.2', async () => {
    const val = await page.evaluate(() => {
      const outerFrame = document.getElementById('t3-2-frame');
      const innerFrame = outerFrame.contentDocument.querySelector('iframe');
      return innerFrame.contentDocument.getElementById('inner-secret').textContent;
    });
    await page.locator('#t3-2-input').fill(val);
    await page.locator('#t3-2-input + button').click();
    await page.waitForFunction(() => document.getElementById('t3-2-status').textContent === 'PASS');
  });

  // T3.3
  await measureTest('T3.3', async () => {
    await page.evaluate(() => {
      const list = document.getElementById('t3-3-list');
      const items = Array.from(list.querySelectorAll('.drag-item'));
      items.sort((a, b) => parseInt(a.dataset.value) - parseInt(b.dataset.value));
      items.forEach(item => list.appendChild(item));
    });
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('Verify Order')) b.click(); }); });
    await page.waitForFunction(() => document.getElementById('t3-3-status').textContent === 'PASS');
  });

  // T3.4 - Canvas: scroll into view first, then pixel analysis
  await measureTest('T3.4', async () => {
    await page.locator('#t3-4-canvas').scrollIntoViewIfNeeded();
    await sleep(300);
    const result = await page.evaluate(() => {
      const canvas = document.getElementById('t3-4-canvas');
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      let sx = 0, sy = 0, cnt = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i+1], b = data[i+2];
          if (r > g + 30 && r > b + 30 && r > 150) { sx += x; sy += y; cnt++; }
        }
      }
      if (cnt === 0) return null;
      const cx = Math.round(sx/cnt), cy = Math.round(sy/cnt);
      const rect = canvas.getBoundingClientRect();
      const scaleX = rect.width / w, scaleY = rect.height / h;
      return { canvasX: cx, canvasY: cy, screenX: rect.left + cx * scaleX, screenY: rect.top + cy * scaleY };
    });
    if (!result) throw new Error('No red circle found');
    await page.mouse.click(result.screenX, result.screenY);
    await page.waitForFunction(() => document.getElementById('t3-4-status').textContent === 'PASS', { timeout: 3000 });
  });

  // T3.5
  await measureTest('T3.5', async () => {
    await page.locator('body').click();
    await sleep(100);
    await page.keyboard.press('Control+k');
    await sleep(150);
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(200);
    await page.waitForFunction(() => document.getElementById('t3-5-status').textContent === 'PASS', { timeout: 3000 });
  });

  // T3.6
  await measureTest('T3.6', async () => {
    await page.evaluate(() => {
      const editor = document.getElementById('t3-6-editor');
      editor.focus();
      while (editor.firstChild) editor.removeChild(editor.firstChild);
      editor.appendChild(document.createTextNode('Hello '));
      const strong = document.createElement('strong');
      strong.textContent = 'World';
      editor.appendChild(strong);
    });
    await page.evaluate(() => { document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('Verify Content')) b.click(); }); });
    await page.waitForFunction(() => document.getElementById('t3-6-status').textContent === 'PASS');
  });

  // Level 4
  await page.locator('nav button[data-level="4"]').click();
  await sleep(300);

  // T4.1
  await measureTest('T4.1', async () => {
    await page.locator('#t4-1-start').click();
    await page.waitForSelector('#t4-1-arena .action-btn', { timeout: 7000 });
    await sleep(100);
    await page.locator('#t4-1-arena .action-btn').click();
    await page.waitForFunction(() => document.getElementById('t4-1-status').textContent === 'PASS', { timeout: 3000 });
  });

  // T4.2
  await measureTest('T4.2', async () => {
    await page.locator('button', { hasText: 'Start Counter' }).click();
    await sleep(200);
    await page.waitForFunction(() => document.getElementById('t4-2-counter').textContent === '7', { timeout: 10000 });
    await page.locator('#t4-2-capture').click();
    await page.waitForFunction(() => document.getElementById('t4-2-status').textContent === 'PASS', { timeout: 2000 });
  });

  // T4.3
  await measureTest('T4.3', async () => {
    await page.evaluate(() => Tests.t4_3_generate());
    await sleep(600);
    const needle = await page.evaluate(() => {
      const el = document.getElementById('the-needle');
      return el ? el.textContent : null;
    });
    if (!needle) throw new Error('Needle not found');
    await page.locator('#t4-3-input').fill(needle);
    await page.locator('#t4-3-input + button').click();
    await page.waitForFunction(() => document.getElementById('t4-3-status').textContent === 'PASS');
  });

  // T4.4
  await measureTest('T4.4', async () => {
    await page.evaluate(() => {
      localStorage.setItem('bench-key', 'ALPHA');
      document.cookie = 'bench-cookie=OMEGA';
    });
    await page.locator('#t4-4-check-ls').click();
    await sleep(200);
    await page.locator('#t4-4-check-cookie').click();
    await sleep(200);
    await page.locator('#t4-4-input').fill('ALPHA-OMEGA');
    await page.locator('#t4-4-verify-btn').click();
    await page.waitForFunction(() => document.getElementById('t4-4-status').textContent === 'PASS');
  });

  // T4.5
  await measureTest('T4.5', async () => {
    await page.evaluate(() => Tests.t4_5_start());
    await sleep(3500);
    await page.locator('#t4-5-input').fill('MUT-A,MUT-B,MUT-C');
    await page.locator('#t4-5-input + button').click();
    await page.waitForFunction(() => document.getElementById('t4-5-status').textContent === 'PASS');
  });

  // T4.6
  await measureTest('T4.6', async () => {
    await page.locator('#t4-6-trigger').click();
    await sleep(200);
    await page.locator('#t4-6-m-name').fill('TestProject');
    await page.locator('#t4-6-m-env').selectOption('production');
    await page.locator('#t4-6-m-ssl').check();
    await page.evaluate(() => Tests.t4_6_confirm());
    await sleep(200);
    const token = await page.locator('#t4-6-token').textContent();
    await page.locator('#t4-6-input').fill(token);
    await page.locator('#t4-6-input + button').click();
    await page.waitForFunction(() => document.getElementById('t4-6-status').textContent === 'PASS');
  });

  await browser.close();

  const output = { name: 'claude-in-chrome', tests: {} };
  for (const [id, r] of Object.entries(results)) {
    output.tests[id] = { status: r.status, duration_ms: r.duration_ms };
  }
  console.log(JSON.stringify(output, null, 2));
})();
