import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PAGE_DIR = join(ROOT, 'fixtures/runtime-page');

type App = { url: string; stop: () => Promise<void>; eventsFile: string };

async function startApp(opts: { activate?: string; noBugs?: boolean }): Promise<App> {
  process.env.CODER_PARCOURS_PUBLIC_DIR = 'fixtures/bugs';
  const { spawnAppServer } = await import(pathToFileURL(join(ROOT, 'server/spawn.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'cp-runtime-'));
  const eventsFile = join(dir, 'events.jsonl');
  const app = await spawnAppServer({ seed: 2601, eventsFile, staticDir: PAGE_DIR, ...opts });
  return { url: app.url, stop: app.stop, eventsFile };
}

function bugLines(file: string): Array<{ bug?: string; event: string }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'bug');
}

async function waitForBugLines(file: string, n: number) {
  await expect.poll(() => bugLines(file).length, { timeout: 5000 }).toBeGreaterThanOrEqual(n);
  return bugLines(file);
}

const height = (page: Page, sel: string) => page.$eval(sel, (el) => Math.round(el.getBoundingClientRect().height));

/** Starts a throwaway bug in the page through the runtime, with the width of the given media query. */
const runTest = (page: Page, media: string, body: string) => page.evaluate(
  `window.__sw.run('0123abcd', { station: 'cart', width: ${media ? "'phone'" : "'all'"}, media: ${JSON.stringify(media)}, section: '[data-section="cart"]' }, function (api) { ${body} })`,
);

test.describe('css and clicks with the fixture catalog', () => {
  let app: App;
  test.beforeAll(async () => { app = await startApp({ activate: 'F01@cart:phone,F03@schedule:all' }); });
  test.afterAll(async () => { await app.stop(); });

  test('css bug acts at 390 only and follows a live resize', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.url);
    expect(await height(page, '.c')).toBe(44);
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await height(page, '.c')).toBe(18);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await height(page, '.c')).toBe(44);
  });

  test('the first click is swallowed, the second goes through, both are logged', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.url);
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('idle');
    expect((await waitForBugLines(app.eventsFile, 1)).map((l) => l.event)).toEqual(['reached']);
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 1');
    const lines = await waitForBugLines(app.eventsFile, 2);
    expect(lines.map((l) => `${l.bug}:${l.event}`)).toEqual(['F03:reached', 'F03:passed']);
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 2');
  });

  test('a redrawn button swallows its first click again', async ({ page }) => {
    await page.goto(app.url);
    await page.click('.s');
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 1');
    await page.click('#regen');
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 1');
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 2');
  });

  test('a trap click sends no further request after its single beacon', async ({ page }) => {
    const posts: string[] = [];
    const others: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/api/metrics')) posts.push(r.postData() ?? '');
      else if (r.url().includes('/api/')) others.push(r.url());
    });
    await page.goto(app.url);
    await page.click('.s'); // swallowed
    await expect.poll(() => posts.length).toBe(1);
    await page.waitForTimeout(600);
    expect(posts.length, 'no late second post after the swallowed click').toBe(1);
    await page.click('.s'); // goes through
    await expect.poll(() => posts.length).toBe(2);
    await page.waitForTimeout(600);
    expect(posts.length, 'no late third post after the second click').toBe(2);
    expect(others, 'the clicks trigger no other API call').toEqual([]);
  });

  test('each click sends exactly one metrics post of the same neutral form, never the event words', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/metrics')) posts.push(r.postData() ?? ''); });
    await page.goto(app.url);
    await page.click('.s'); // swallowed: reached
    await expect.poll(() => posts.length).toBe(1);
    await page.click('.s'); // passed
    await expect.poll(() => posts.length).toBe(2);
    await page.click('#regen'); // neutral
    await expect.poll(() => posts.length).toBe(3);
    for (const p of posts) {
      expect(p).toMatch(/^\{"b":"[0-9a-f]{8}","e":"[0-9a-f]{8}"\}$/);
      expect(p).not.toMatch(/reached|passed/);
    }
  });

  test('the two trap beacons of two clicks carry different b, no constant', async ({ page }) => {
    const posts: Array<{ b: string; e: string }> = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/metrics')) posts.push(JSON.parse(r.postData() ?? '{}')); });
    await page.goto(app.url);
    await page.click('.s'); // reached
    await page.click('.s'); // passed
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[0].b).not.toBe(posts[1].b);
    expect(posts[0].e).not.toBe(posts[1].e);
    const lines = await waitForBugLines(app.eventsFile, 2);
    expect(lines.slice(-2).map((l) => l.event)).toEqual(['reached', 'passed']);
  });
});

test.describe('client api on a throwaway bug', () => {
  let app: App;
  test.beforeAll(async () => { app = await startApp({ noBugs: true }); });
  test.afterAll(async () => { await app.stop(); });

  test('patch hits new elements again and honours live width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.url);
    await runTest(page, '(max-width: 600px)', `api.patch('[data-section="cart"] button', function (el) { el.dataset.p = String((+el.dataset.p || 0) + 1); });`);
    await expect(page.locator('.c').first()).not.toHaveAttribute('data-p', /.*/);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator('.c').first()).toHaveAttribute('data-p', '1');
    await expect(page.locator('.c').nth(1)).toHaveAttribute('data-p', '1');
    await page.evaluate(() => { (document.getElementById('regen') as HTMLElement).click(); });
    await expect(page.locator('.c').first()).toHaveAttribute('data-p', '1');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    await expect(page.locator('.c').first()).toHaveAttribute('data-p', '1');
  });

  test('onSection fires for every new section element', async ({ page }) => {
    await page.goto(app.url);
    await runTest(page, '', `window.__seen = 0; api.onSection('cart', function () { window.__seen += 1; });`);
    await expect.poll(() => page.evaluate('window.__seen')).toBe(1);
    await page.click('#regen');
    await expect.poll(() => page.evaluate('window.__seen')).toBe(2);
  });

  test('fetch can delay and replace answers; other calls are untouched', async ({ page }) => {
    await page.goto(app.url);
    const timed = (url: string) => page.evaluate(async (u) => {
      const t = performance.now();
      const res = await fetch(u);
      return { ms: performance.now() - t, status: res.status, text: await res.text() };
    }, url);
    expect((await timed('/api/classes')).ms).toBeLessThan(1000);
    await runTest(page, '', `api.fetch(function (url) { if (url.indexOf('/api/classes') >= 0) return { delayMs: 1500 }; if (url.indexOf('/api/me') >= 0) return { status: 503, body: { error: 'x' } }; });`);
    const slow = await timed('/api/classes');
    expect(slow.ms).toBeGreaterThanOrEqual(1450);
    expect(slow.status).toBe(200);
    const fake = await timed('/api/me');
    expect(fake.status).toBe(503);
    expect(JSON.parse(fake.text)).toEqual({ error: 'x' });
    expect((await timed('/api/settings')).ms).toBeLessThan(1000);
  });

  test('pushState and popstate each send one neutral beacon', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/metrics')) posts.push(r.postData() ?? ''); });
    await page.goto(app.url);
    await page.evaluate(() => history.pushState({}, '', '#a'));
    await expect.poll(() => posts.length).toBe(1);
    await page.evaluate(() => history.back());
    await expect.poll(() => posts.length).toBe(2);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p).toMatch(/^\{"b":"[0-9a-f]{8}","e":"[0-9a-f]{8}"\}$/);
  });

  test('swallowFirstClick only acts inside its width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.url);
    await runTest(page, '(max-width: 600px)', `api.swallowFirstClick('.s');`);
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 1');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.click('#regen');
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 1');
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 2');
  });

  test('fetch hook only acts inside its width', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(app.url);
    await runTest(page, '(max-width: 600px)', `api.fetch(function () { return { status: 503, body: {} }; });`);
    const status = () => page.evaluate(async () => (await fetch('/api/classes')).status);
    expect(await status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await status()).toBe(503);
  });

  test('fetch hook never touches the metrics endpoint, and sees the url of a Request object', async ({ page }) => {
    await page.goto(app.url);
    await runTest(page, '', `api.fetch(function (url) { if (url.indexOf('/api/') >= 0) return { status: 503, body: { error: 'x' } }; });`);
    const metrics = await page.evaluate(async () => (await fetch('/api/metrics', { method: 'POST', body: '{"b":"00000000","e":"00000000"}' })).status);
    expect(metrics, 'the beacon endpoint is passed through untouched').toBe(204);
    const asString = await page.evaluate(async () => (await fetch('/api/classes')).status);
    expect(asString, 'positive: another url is faked by the same hook').toBe(503);
    const asRequest = await page.evaluate(async () => (await fetch(new Request('/api/classes'))).status);
    expect(asRequest, 'a Request object is matched by its url').toBe(503);
  });

  test('beacon accepts only the two events', async ({ page }) => {
    await page.goto(app.url);
    const msg = await page.evaluate(`(function () { var out = ''; window.__sw.run('0123abcd', { station: 'cart', width: 'all', media: '', section: 'x' }, function (api) { try { api.beacon('nope'); } catch (e) { out = String(e.message); } }); return out; })()`);
    expect(msg).toMatch(/beacon/i);
  });

  test('a normal click without an active bug posts one metrics call and logs no bug line', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/metrics')) posts.push(r.postData() ?? ''); });
    await page.goto(app.url);
    await page.click('.s');
    await expect(page.locator('#out')).toHaveText('booked 1');
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatch(/^\{"b":"[0-9a-f]{8}","e":"[0-9a-f]{8}"\}$/);
    await page.waitForTimeout(300);
    expect(bugLines(app.eventsFile)).toEqual([]);
  });
});
