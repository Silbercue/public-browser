// Public catalog part 2 (P09-P17) and decoys: each bug acts where it should (station, width), not elsewhere,
// not in the healthy app; traps log reached/passed; capture targets fail only in the broken variant.
// Node part: the whole public catalog (17 bugs), decoys and the stratified run configuration of every seed.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'app/dist');
const MAYA = { email: 'maya@stillwater.test', password: 'lotus-breath-26' };
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const DESKTOP = { width: 1440, height: 900 };

const load = (rel: string) => import(pathToFileURL(join(ROOT, rel)).href);

type App = { url: string; eventsFile: string; stop: () => Promise<void> };
type StartOpts = { activate?: string; noBugs?: boolean; seed?: number; session?: 'explore' | 'capture'; variant?: 'healthy' | 'broken' };

async function start(opts: StartOpts): Promise<App> {
  process.env.CODER_PARCOURS_PUBLIC_DIR = 'bugs/public';
  const { spawnAppServer } = await load('server/spawn.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cp-behavior-'));
  const eventsFile = join(dir, 'events.jsonl');
  const srv = await spawnAppServer({ seed: 2601, session: 'explore', eventsFile, staticDir: DIST, ...opts });
  return { url: srv.url.replace(/\/$/, ''), eventsFile, stop: srv.stop };
}

async function withApp(opts: StartOpts, fn: (app: App) => Promise<void>) {
  const app = await start(opts);
  try { await fn(app); } finally { await app.stop(); }
}

type Line = { type: string; bug?: string; event?: string; route?: string };
const lines = (file: string): Line[] => (existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);
const trapEvents = (file: string, id: string) => lines(file).filter((l) => l.type === 'bug' && l.bug === id).map((l) => l.event);

async function go(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

async function apiLogin(page: Page, url: string) {
  const r = await page.request.post(`${url}/api/auth/login`, { data: MAYA });
  expect(r.status()).toBe(200);
}

async function addToCart(page: Page, url: string, classId: string, spots = 1) {
  const r = await page.request.post(`${url}/api/cart/items`, { data: { classId, spots } });
  expect(r.status()).toBe(200);
}

const overflowPx = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const style = (page: Page, sel: string, prop: string) =>
  page.$eval(sel, (el, p) => (getComputedStyle(el) as any)[p] as string, prop);
const truncatedCount = (page: Page, sel: string) =>
  page.$$eval(sel, (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);

/** Finds a seed (from 1 up) whose capture target is `id`. */
async function seedWithCaptureTarget(id: string): Promise<number> {
  const { loadCatalog } = await load('catalog/load.mjs');
  const { buildRunConfig } = await load('harness/seed.mjs');
  const catalog = await loadCatalog({ publicDir: 'bugs/public' });
  for (let seed = 1; seed < 500; seed++) {
    if (buildRunConfig({ seed, sessionType: 'capture', catalog }).capture?.bugId === id) return seed;
  }
  throw new Error(`no seed has ${id} as capture target`);
}

// --- P09 layout, phone only ----------------------------------------------------------------------
test.describe('P09', () => {
  test('schedule: page scrolls sideways at 390 only, healthy app does not', async ({ page }) => {
    await withApp({ activate: 'P09@schedule:phone' }, async (app) => {
      await page.setViewportSize(PHONE);
      await go(page, `${app.url}/schedule`);
      expect(await overflowPx(page)).toBeGreaterThan(20);
      expect(await style(page, '.day-tabs', 'gridTemplateColumns')).toBe('64px 64px 64px 64px 64px 64px 64px');
      await page.setViewportSize(TABLET);
      expect(await overflowPx(page)).toBeLessThanOrEqual(0);
      expect(await style(page, '.day-tabs', 'gridTemplateColumns')).not.toContain('64px');
    });
    await withApp({ noBugs: true }, async (app) => {
      await page.setViewportSize(PHONE);
      await go(page, `${app.url}/schedule`);
      expect(await overflowPx(page)).toBeLessThanOrEqual(0);
    });
  });

  test('cart: page scrolls sideways at 390 only, healthy app does not', async ({ page }) => {
    await withApp({ activate: 'P09@cart:phone' }, async (app) => {
      await addToCart(page, app.url, 'c12');
      await page.setViewportSize(PHONE);
      await go(page, `${app.url}/cart`);
      await expect(page.getByLabel('Coupon code')).toBeVisible();
      expect(await overflowPx(page)).toBeGreaterThan(20);
      expect(await style(page, '#coupon-code', 'width')).toBe('320px');
      await page.setViewportSize(TABLET);
      expect(await overflowPx(page)).toBeLessThanOrEqual(0);
      expect(await style(page, '#coupon-code', 'width')).not.toBe('320px');
    });
    await withApp({ noBugs: true }, async (app) => {
      await addToCart(page, app.url, 'c12');
      await page.setViewportSize(PHONE);
      await go(page, `${app.url}/cart`);
      await expect(page.getByLabel('Coupon code')).toBeVisible();
      expect(await overflowPx(page)).toBeLessThanOrEqual(0);
    });
  });
});

// --- P10 layout, tablet only ---------------------------------------------------------------------
test.describe('P10', () => {
  for (const [station, path, sel] of [['schedule', '/schedule?day=Sat', '.class-name'], ['home', '/', '.card-list h3']] as const) {
    test(`${station}: class names cut off at 768 only, healthy app shows them whole`, async ({ page }) => {
      await withApp({ activate: `P10@${station}:tablet` }, async (app) => {
        await page.setViewportSize(TABLET);
        await go(page, `${app.url}${path}`);
        await expect(page.locator(sel).first()).toBeVisible();
        expect(await truncatedCount(page, sel)).toBeGreaterThan(0);
        expect(await style(page, sel, 'whiteSpace')).toBe('nowrap');
        await page.setViewportSize(DESKTOP);
        expect(await truncatedCount(page, sel)).toBe(0);
        expect(await style(page, sel, 'whiteSpace')).not.toBe('nowrap');
      });
      await withApp({ noBugs: true }, async (app) => {
        await page.setViewportSize(TABLET);
        await go(page, `${app.url}${path}`);
        await expect(page.locator(sel).first()).toBeVisible();
        expect(await truncatedCount(page, sel)).toBe(0);
      });
    });
  }
});

// --- P11 function, change + capture: phone number is lost after reload ---------------------------
/** The capture flow of P11: true when a saved phone number is still there after a reload. */
async function phoneSurvivesReload(page: Page, app: App): Promise<boolean> {
  await apiLogin(page, app.url);
  await go(page, `${app.url}/profile`);
  await page.getByLabel('Phone').fill('555 0101');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved.' })).toBeVisible();
  await go(page, `${app.url}/profile`);
  await expect(page.getByLabel('Name')).toHaveValue('Maya Lind');
  return (await page.getByLabel('Phone').inputValue()) === '555 0101';
}

test.describe('P11', () => {
  test('active: save says saved, but the phone is gone after reload; the name stays', async ({ page }) => {
    await withApp({ activate: 'P11@profile:all' }, async (app) => {
      expect(await phoneSurvivesReload(page, app)).toBe(false);
      const r = await page.request.get(`${app.url}/api/profile`);
      expect((await r.json()).phone).toBe('');
    });
  });
  test('healthy: the phone stays after reload', async ({ page }) => {
    await withApp({ noBugs: true }, async (app) => { expect(await phoneSurvivesReload(page, app)).toBe(true); });
  });
  test('capture: healthy variant passes the flow, broken variant fails it', async ({ page, browser }) => {
    const seed = await seedWithCaptureTarget('P11');
    await withApp({ seed, session: 'capture', variant: 'healthy' }, async (app) => {
      expect(await phoneSurvivesReload(page, app)).toBe(true);
    });
    const ctx = await browser.newContext();
    const page2 = await ctx.newPage();
    await withApp({ seed, session: 'capture', variant: 'broken' }, async (app) => {
      expect(await phoneSurvivesReload(page2, app)).toBe(false);
    });
    await ctx.close();
  });
});

// --- P12 function, change + capture: cart total ignores the number of spots ----------------------
/** The capture flow of P12: true when 3 spots of a $23 class make a $69 total in cart and checkout. */
async function totalCountsSpots(page: Page, app: App): Promise<boolean> {
  await addToCart(page, app.url, 'c12', 3);
  await go(page, `${app.url}/cart`);
  await expect(page.locator('.line-total')).toHaveText('$69');
  return (await page.getByTestId('total').textContent()) === '$69';
}

test.describe('P12', () => {
  test('active: line shows $69 but subtotal and total show $23, also at checkout', async ({ page }) => {
    await withApp({ activate: 'P12@cart:all' }, async (app) => {
      expect(await totalCountsSpots(page, app)).toBe(false);
      await expect(page.getByTestId('subtotal')).toHaveText('$23');
      await apiLogin(page, app.url);
      await go(page, `${app.url}/checkout`);
      await expect(page.getByTestId('total')).toHaveText('$23');
    });
  });
  test('active with coupon: the discount is taken from the wrong subtotal', async ({ page }) => {
    await withApp({ activate: 'P12@cart:all' }, async (app) => {
      await addToCart(page, app.url, 'c12', 2);
      const r = await page.request.post(`${app.url}/api/cart/coupon`, { data: { code: 'YOGA10' } });
      const body = await r.json();
      expect([body.subtotalCents, body.discountCents, body.totalCents]).toEqual([2300, 230, 2070]);
    });
  });
  test('healthy: total is $69', async ({ page }) => {
    await withApp({ noBugs: true }, async (app) => { expect(await totalCountsSpots(page, app)).toBe(true); });
  });
  test('capture: healthy variant passes the flow, broken variant fails it', async ({ page, browser }) => {
    const seed = await seedWithCaptureTarget('P12');
    await withApp({ seed, session: 'capture', variant: 'healthy' }, async (app) => {
      expect(await totalCountsSpots(page, app)).toBe(true);
    });
    const ctx = await browser.newContext();
    const page2 = await ctx.newPage();
    await withApp({ seed, session: 'capture', variant: 'broken' }, async (app) => {
      expect(await totalCountsSpots(page2, app)).toBe(false);
    });
    await ctx.close();
  });
});

// --- P13 function, change: a class can be booked twice --------------------------------------------
/** Maya already booked c08 (Vinyasa Strength). True when checking it out again is refused. */
async function secondBookingRefused(page: Page, app: App): Promise<boolean> {
  await apiLogin(page, app.url);
  await addToCart(page, app.url, 'c08');
  await go(page, `${app.url}/checkout`);
  await page.getByLabel('I accept the studio terms').check();
  await page.getByRole('button', { name: 'Place booking' }).click();
  const refused = page.getByRole('alert').filter({ hasText: 'You already booked this class.' });
  const confirmed = page.getByRole('heading', { name: 'Booking confirmed' });
  await expect(refused.or(confirmed)).toBeVisible();
  return refused.isVisible();
}

test.describe('P13', () => {
  test('active: the second booking goes through and My bookings lists the class twice', async ({ page }) => {
    await withApp({ activate: 'P13@checkout:all' }, async (app) => {
      expect(await secondBookingRefused(page, app)).toBe(false);
      await go(page, `${app.url}/bookings`);
      await expect(page.getByRole('heading', { name: 'Vinyasa Strength' })).toHaveCount(2);
    });
  });
  test('healthy: the second booking is refused', async ({ page }) => {
    await withApp({ noBugs: true }, async (app) => {
      expect(await secondBookingRefused(page, app)).toBe(true);
      await go(page, `${app.url}/bookings`);
      await expect(page.getByRole('heading', { name: 'Vinyasa Strength' })).toHaveCount(1);
    });
  });
});

// --- P14 timing trap: the session expires silently -----------------------------------------------
/** Logs in through the form, then walks Schedule <-> My bookings until the list is empty (or gives up). */
async function walkUntilEmpty(page: Page, app: App): Promise<boolean> {
  await go(page, `${app.url}/login?next=%2Fbookings`);
  await page.getByLabel('Email').fill(MAYA.email);
  await page.getByLabel('Password').fill(MAYA.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Vinyasa Strength' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (let i = 0; i < 4; i++) {
    await nav.getByRole('link', { name: 'Schedule' }).click();
    await page.waitForLoadState('networkidle');
    await nav.getByRole('link', { name: 'My bookings' }).click();
    await page.waitForLoadState('networkidle');
    const empty = page.getByText('No upcoming bookings.');
    const listed = page.getByRole('heading', { name: 'Vinyasa Strength' });
    await expect(empty.or(listed)).toBeVisible();
    if (await empty.isVisible()) return true;
  }
  return false;
}

test.describe('P14', () => {
  test('active: bookings vanish without a hint; reload alone does not help; only a new login passes', async ({ page }) => {
    await withApp({ activate: 'P14@bookings:all' }, async (app) => {
      expect(await walkUntilEmpty(page, app)).toBe(true);
      await expect(page.getByText('Your session expired')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
      await expect.poll(() => trapEvents(app.eventsFile, 'P14')).toEqual(['reached']);

      // Reload only: silently sent to the login page, no passed.
      await page.reload();
      await expect(page).toHaveURL(/\/login\?next=%2Fbookings$/);
      await expect(page.getByText('Your session expired')).toHaveCount(0);
      await page.waitForLoadState('networkidle');
      const types = lines(app.eventsFile).map((l) => l.type);
      expect(types).toContain('session_expired');
      expect(trapEvents(app.eventsFile, 'P14')).toEqual(['reached']);

      // Log in again: passed, in the order reached -> session_expired -> login -> passed.
      await page.getByLabel('Email').fill(MAYA.email);
      await page.getByLabel('Password').fill(MAYA.password);
      await page.getByRole('button', { name: 'Log in' }).click();
      await expect(page.getByRole('heading', { name: 'Vinyasa Strength' })).toBeVisible();
      await expect.poll(() => trapEvents(app.eventsFile, 'P14')).toEqual(['reached', 'passed']);
      const seq = lines(app.eventsFile).map((l) => (l.type === 'bug' ? `bug:${l.event}` : l.type));
      const reached = seq.indexOf('bug:reached');
      const expired = seq.indexOf('session_expired', reached);
      const login = seq.indexOf('login', expired);
      const passed = seq.indexOf('bug:passed', login);
      expect(reached).toBeGreaterThanOrEqual(0);
      expect(expired).toBeGreaterThan(reached);
      expect(login).toBeGreaterThan(expired);
      expect(passed).toBeGreaterThan(login);
      expect(seq.filter((s) => s === 'session_expired').length).toBeGreaterThanOrEqual(1);
    });
  });
  test('active: after the expiry, going on to checkout lands on the login page with the guest hint (conflict with the login decoy)', async ({ page }) => {
    await withApp({ activate: 'P14@bookings:all' }, async (app) => {
      expect(await walkUntilEmpty(page, app)).toBe(true);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await nav.getByRole('link', { name: 'Schedule' }).click();
      await page.waitForLoadState('networkidle');
      await go(page, `${app.url}/checkout`);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByText('Please log in to book.')).toBeVisible();
      await expect(page.getByText('Your session expired')).toHaveCount(0);
    });
  });
  test('healthy: the same walk keeps the bookings and never expires', async ({ page }) => {
    await withApp({ noBugs: true }, async (app) => {
      expect(await walkUntilEmpty(page, app)).toBe(false);
      expect(lines(app.eventsFile).map((l) => l.type)).not.toContain('session_expired');
      expect(lines(app.eventsFile).map((l) => l.type)).toContain('login');
    });
  });
});

// --- no readable error text in the browser, no trace when inactive --------------------------------------
const ERROR_WORDS = /session_expired|login_required|Please log in to continue|expired/i;

test.describe('no trace in the page', () => {
  test('P14 active: neither fetch.toString() nor the runtime script carries the error text', async ({ page }) => {
    await withApp({ activate: 'P14@bookings:all' }, async (app) => {
      await go(page, `${app.url}/`);
      const fetchSrc = await page.evaluate(() => window.fetch.toString());
      expect(fetchSrc.length).toBeGreaterThan(0);
      expect(fetchSrc).not.toMatch(ERROR_WORDS);
      const script = await (await page.request.get(`${app.url}/assets/runtime.js`)).text();
      expect(script).toContain('__swBoot('); // positive control: this is the runtime script
      expect(script).not.toMatch(ERROR_WORDS);
    });
  });
  test('P14 still rewrites after the text moved into data (counter-check)', async ({ page }) => {
    await withApp({ activate: 'P14@bookings:all' }, async (app) => {
      expect(await walkUntilEmpty(page, app)).toBe(true);
    });
  });
  test('P14/P16 inactive: no hook wrapper and no error text anywhere in the page context', async ({ page }) => {
    await withApp({ activate: 'P09@schedule:phone' }, async (app) => {
      await go(page, `${app.url}/`);
      const fetchSrc = await page.evaluate(() => window.fetch.toString());
      expect(fetchSrc).not.toMatch(ERROR_WORDS);
      expect(fetchSrc).not.toContain('clone');
      const script = await (await page.request.get(`${app.url}/assets/runtime.js`)).text();
      expect(script).toContain('__swBoot(');
      expect(script).not.toMatch(ERROR_WORDS);
      expect(script).not.toContain('/api/cart/coupon');
      expect(script).not.toContain('/api/bookings');
    });
  });
  test('P14 active shows the wrapper markers the inactive page lacks (control for the checks above)', async ({ page }) => {
    await withApp({ activate: 'P14@bookings:all' }, async (app) => {
      await go(page, `${app.url}/`);
      const script = await (await page.request.get(`${app.url}/assets/runtime.js`)).text();
      expect(script).toContain('/api/bookings');
    });
  });
});

// --- P15 timing trap: the save button needs a second click ---------------------------------------
test.describe('P15', () => {
  const cases = [
    { station: 'settings', path: '/settings', act: async (page: Page) => page.getByRole('switch', { name: 'Newsletter' }).click(),
      button: 'Save changes', done: 'Settings saved.' },
    { station: 'profile', path: '/profile', act: async (page: Page) => page.getByLabel('Phone').fill('555 0102'),
      button: 'Save profile', done: 'Profile saved.' },
  ];
  for (const c of cases) {
    test(`${c.station}: first click does nothing, second saves; reached then passed`, async ({ page }) => {
      await withApp({ activate: `P15@${c.station}:all` }, async (app) => {
        await apiLogin(page, app.url);
        await go(page, `${app.url}${c.path}`);
        await c.act(page);
        let puts = 0;
        page.on('request', (r) => { if (r.method() === 'PUT') puts++; });
        await page.getByRole('button', { name: c.button }).click();
        await page.waitForTimeout(600);
        await expect(page.getByText(c.done)).toHaveCount(0);
        expect(puts).toBe(0);
        await expect.poll(() => trapEvents(app.eventsFile, 'P15')).toEqual(['reached']);
        await page.getByRole('button', { name: c.button }).click();
        await expect(page.getByText(c.done)).toBeVisible();
        await expect.poll(() => trapEvents(app.eventsFile, 'P15')).toEqual(['reached', 'passed']);
      });
    });
    test(`${c.station}: healthy app saves on the first click`, async ({ page }) => {
      await withApp({ noBugs: true }, async (app) => {
        await apiLogin(page, app.url);
        await go(page, `${app.url}${c.path}`);
        await c.act(page);
        await page.getByRole('button', { name: c.button }).click();
        await expect(page.getByText(c.done)).toBeVisible({ timeout: 1500 });
        expect(lines(app.eventsFile).filter((l) => l.type === 'bug')).toEqual([]);
      });
    });
  }
});

// --- P16 timing trap: 4 s answer without a loading indicator -------------------------------------
test.describe('P16', () => {
  const cases = [
    { station: 'class-detail', prep: async () => {}, path: '/classes/c12', button: 'Book this class',
      done: (page: Page) => page.getByRole('dialog', { name: 'Added to cart' }) },
    { station: 'cart', prep: async (page: Page, app: App) => addToCart(page, app.url, 'c12'), path: '/cart', button: 'Apply',
      done: (page: Page) => page.getByTestId('coupon-message') },
  ];
  for (const c of cases) {
    test(`${c.station}: answer takes about 4 s with no spinner, status or busy marker; reached then passed`, async ({ page }) => {
      await withApp({ activate: `P16@${c.station}:all` }, async (app) => {
        await c.prep(page, app);
        await go(page, `${app.url}${c.path}`);
        if (c.station === 'cart') await page.getByLabel('Coupon code').fill('YOGA10');
        const t0 = Date.now();
        await page.getByRole('button', { name: c.button }).click();
        await page.waitForTimeout(1500);
        await expect(c.done(page)).toHaveCount(0);
        await expect(page.locator('[aria-busy="true"], .spinner')).toHaveCount(0);
        await expect(page.getByRole('status').filter({ hasText: /\S/ })).toHaveCount(0);
        await expect(c.done(page)).toBeVisible({ timeout: 8000 });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(3800);
        await expect.poll(() => trapEvents(app.eventsFile, 'P16'), { timeout: 3000 }).toEqual(['reached', 'passed']);
      });
    });
    test(`${c.station}: healthy app answers at once`, async ({ page }) => {
      await withApp({ noBugs: true }, async (app) => {
        await c.prep(page, app);
        await go(page, `${app.url}${c.path}`);
        if (c.station === 'cart') await page.getByLabel('Coupon code').fill('YOGA10');
        const t0 = Date.now();
        await page.getByRole('button', { name: c.button }).click();
        await expect(c.done(page)).toBeVisible();
        expect(Date.now() - t0).toBeLessThan(1500);
      });
    });
  }
  test('a different station is not slowed down', async ({ page }) => {
    await withApp({ activate: 'P16@cart:all' }, async (app) => {
      await go(page, `${app.url}/classes/c12`);
      const t0 = Date.now();
      await page.getByRole('button', { name: 'Book this class' }).click();
      await expect(page.getByRole('dialog', { name: 'Added to cart' })).toBeVisible();
      expect(Date.now() - t0).toBeLessThan(1500);
    });
  });
});

// --- P17 background: the reviews request fails, the page says "No reviews yet." -------------------
test.describe('P17', () => {
  test('active: reviews answer 500, a console error appears, the page only says there are no reviews', async ({ page }) => {
    await withApp({ activate: 'P17@class-detail:all' }, async (app) => {
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const reviews = page.waitForResponse((r) => r.url().endsWith('/reviews'));
      await go(page, `${app.url}/classes/c12`);
      expect((await reviews).status()).toBe(500);
      await expect(page.getByText('No reviews yet.')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      expect(errors.some((e) => e.includes('500'))).toBe(true);
    });
  });
  test('healthy: reviews are listed, no console error', async ({ page }) => {
    await withApp({ noBugs: true }, async (app) => {
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await go(page, `${app.url}/classes/c12`);
      await expect(page.locator('.review')).toHaveCount(3);
      await expect(page.getByText('No reviews yet.')).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
});

// --- inactive bugs leave no trace ---------------------------------------------------------------------
test('with only a far away bug active, the stations of P14-P17 behave like the healthy app', async ({ page }) => {
  await withApp({ activate: 'P09@schedule:phone' }, async (app) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
    await go(page, `${app.url}/classes/c12`);
    await expect(page.locator('.review')).toHaveCount(3);
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Book this class' }).click();
    await expect(page.getByRole('dialog', { name: 'Added to cart' })).toBeVisible();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(errors).toEqual([]);
    expect(lines(app.eventsFile).filter((l) => l.type === 'bug' || l.type === 'session_expired')).toEqual([]);
  });
});

// --- Node part: catalog, decoys, seeds --------------------------------------------------------------
test.describe('catalog', () => {
  test('17 valid public bugs with the planned mix of categories and roles', async () => {
    const { loadCatalog } = await load('catalog/load.mjs');
    const { validateBug } = await load('catalog/schema.mjs');
    const catalog = await loadCatalog({ publicDir: 'bugs/public' });
    expect(catalog.bugs.length).toBe(17);
    expect(catalog.bugs.map((b: any) => b.id).sort()).toEqual(Array.from({ length: 17 }, (_, i) => `P${String(i + 1).padStart(2, '0')}`));
    for (const b of catalog.bugs) {
    const { source, ...mod } = b;
    expect(source, b.id).toBe('public');
    expect(validateBug(mod), b.id).toEqual([]);
  }
    const mine = catalog.bugs.filter((b: any) => Number(b.id.slice(1)) >= 9);
    const count = (cat: string) => mine.filter((b: any) => b.category === cat).length;
    expect([count('layout'), count('function'), count('timing'), count('background')]).toEqual([2, 3, 3, 1]);
    const layout = mine.filter((b: any) => b.category === 'layout');
    expect(layout.some((b: any) => b.widths.length === 1 && b.widths[0] === 'phone')).toBe(true);
    expect(layout.some((b: any) => b.widths.length === 1 && ['tablet', 'desktop'].includes(b.widths[0]))).toBe(true);
    const withRole = (r: string) => catalog.bugs.filter((b: any) => b.roles?.[r]);
    expect(withRole('change').length).toBe(3);
    expect(withRole('change').every((b: any) => ['function', 'background'].includes(b.category))).toBe(true);
    expect(withRole('capture').length).toBe(2);
    expect(withRole('trap').length).toBe(3);
    // A background bug's request fails silently; the session trap uses expireSession, never a hand-made 401.
    const src = readFileSync(join(ROOT, 'bugs/public/P14-session-expires-silently.mjs'), 'utf8');
    expect(src).toContain('expireSession()');
    expect(src).not.toMatch(/respond\(\s*401/);
  });

  test('decoys are valid, at different stations, and name only existing bugs in conflicts', async () => {
    const { loadCatalog } = await load('catalog/load.mjs');
    const { validateDecoy } = await load('catalog/schema.mjs');
    const catalog = await loadCatalog({ publicDir: 'bugs/public' });
    expect(catalog.decoys.length).toBeGreaterThanOrEqual(4);
    for (const d of catalog.decoys) expect(validateDecoy(d), d.id).toEqual([]);
    const stations = catalog.decoys.map((d: any) => d.station);
    expect(new Set(stations).size).toBe(stations.length);
    const ids = new Set(catalog.bugs.map((b: any) => b.id));
    for (const d of catalog.decoys) for (const c of d.conflicts ?? []) expect(ids.has(c), `${d.id} -> ${c}`).toBe(true);
  });

  test('every seed has a change and a capture target and meets the stratification', async () => {
    const { loadCatalog } = await load('catalog/load.mjs');
    const { buildRunConfig, loadSeeds } = await load('harness/seed.mjs');
    const catalog = await loadCatalog({ publicDir: 'bugs/public' });
    const byId = new Map(catalog.bugs.map((b: any) => [b.id, b]));
    const seeds: number[] = loadSeeds();
    expect(seeds.length).toBe(5);
    for (const seed of seeds) {
      const cfg = buildRunConfig({ seed, sessionType: 'explore', catalog });
      expect(cfg.change, `seed ${seed}`).not.toBeNull();
      expect(buildRunConfig({ seed, sessionType: 'capture', catalog }).capture, `seed ${seed}`).not.toBeNull();
      const rest = cfg.active.filter((a: any) => a.id !== cfg.change.bugId);
      expect(rest.length, `seed ${seed}`).toBeGreaterThanOrEqual(6);
      expect(rest.length, `seed ${seed}`).toBeLessThanOrEqual(8);
      const bugs = rest.map((a: any) => byId.get(a.id) as any);
      expect(bugs.some((b: any) => b.roles?.trap), `seed ${seed} trap`).toBe(true);
      for (const w of ['phone', 'tablet', 'desktop']) expect(rest.some((a: any) => a.width === w), `seed ${seed} ${w}`).toBe(true);
      expect(bugs.some((b: any) => b.category === 'fiddly'), `seed ${seed} fiddly`).toBe(true);
      expect(bugs.some((b: any) => b.category === 'next-step'), `seed ${seed} next-step`).toBe(true);
      const activeIds = new Set(cfg.active.map((a: any) => a.id));
      for (const id of cfg.decoys) {
        const d = catalog.decoys.find((x: any) => x.id === id);
        expect((d.conflicts ?? []).filter((c: string) => activeIds.has(c)), `seed ${seed} ${id}`).toEqual([]);
      }
      for (const d of catalog.decoys) {
        if (!(d.conflicts ?? []).some((c: string) => activeIds.has(c))) expect(cfg.decoys, `seed ${seed}`).toContain(d.id);
      }
    }
  });
});
