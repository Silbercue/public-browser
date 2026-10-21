// Public bugs P01–P08 (categories fiddly and next-step): each one is switched on with --activate and its
// measurable criterion is checked at its station and width, at another width, and in the healthy app.
import { test, expect, type Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'app/dist');
const MAYA = { email: 'maya@stillwater.test', password: 'lotus-breath-26' }; // shared/accounts.mjs, 2 upcoming bookings
const BOOKABLE = 'c12'; // Saturday class with free spots
const FULL = 'c09'; // fully booked class
const IDS = ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08'];

type Width = 'phone' | 'tablet' | 'desktop';
const VIEW: Record<Width, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

type App = { url: string; stop: () => Promise<void> };

async function startApp(opts: { activate?: string; noBugs?: boolean }): Promise<App> {
  // Another spec in the same worker may point the catalog at the fixtures; these tests need the public bugs.
  process.env.CODER_PARCOURS_PUBLIC_DIR = 'bugs/public';
  const { spawnAppServer } = await import(pathToFileURL(join(ROOT, 'server/spawn.mjs')).href);
  const srv = await spawnAppServer({ seed: 2601, staticDir: DIST, ...opts });
  return { url: srv.url.replace(/\/$/, ''), stop: srv.stop };
}

// --- page set-up ---------------------------------------------------------------------------------

async function login(page: Page, url: string) {
  const r = await page.request.post(`${url}/api/auth/login`, { data: MAYA });
  expect(r.status()).toBe(200);
}
async function addToCart(page: Page, url: string, classId = BOOKABLE) {
  const r = await page.request.post(`${url}/api/cart/items`, { data: { classId, spots: 1 } });
  expect(r.status()).toBe(200);
}
async function openCart(page: Page, url: string) {
  await addToCart(page, url);
  await page.goto(`${url}/cart`);
  await expect(page.getByRole('button', { name: 'Increase spots' })).toBeVisible();
}
async function openClass(page: Page, url: string, id = BOOKABLE) {
  await page.goto(`${url}/classes/${id}`);
  await expect(page.getByRole('button', { name: 'Book this class' })).toBeVisible();
  await expect(page.locator('.review').first()).toBeVisible();
}
async function openSettings(page: Page, url: string) {
  await login(page, url);
  await page.goto(`${url}/settings`);
  await expect(page.getByRole('button', { name: 'Reset to defaults' })).toBeVisible();
}
async function openBookings(page: Page, url: string) {
  await login(page, url);
  await page.goto(`${url}/bookings`);
  await expect(page.getByRole('button', { name: 'Cancel' }).first()).toBeVisible();
}
async function openCheckout(page: Page, url: string) {
  await login(page, url);
  await addToCart(page, url);
  await page.goto(`${url}/checkout`);
  await expect(page.getByRole('button', { name: 'Place booking' })).toBeVisible();
}
async function dialogFrom(page: Page, button: string) {
  await page.getByRole('button', { name: button }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

// --- measurements --------------------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, sel: string): Promise<Box> => {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, `no box for ${sel}`).not.toBeNull();
  return b as Box;
};
/** Free space between two boxes, horizontally or vertically (the larger of both, 0 when they touch or overlap). */
const gapBetween = (a: Box, b: Box) => Math.max(0, Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), b.y - (a.y + a.height), a.y - (b.y + b.height)));
const looks = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
  const s = getComputedStyle(el);
  return `${s.backgroundColor}|${s.color}|${s.borderColor}`;
});

type Case = {
  id: string;
  station: string;
  width: Width;
  other?: Width; // a width where the same station must stay clean
  prepare: (page: Page, url: string) => Promise<void>;
  /** true = the bug's criterion is met (the user sees the bug) */
  criterion: (page: Page) => Promise<boolean>;
  /** extra check that only has to hold where the bug is active */
  whenActive?: (page: Page) => Promise<boolean>;
  name: string;
};

const stepTiny = async (page: Page) => (await box(page, 'button[aria-label="Increase spots"]')).height < 24;
const closeTiny = async (page: Page) => {
  const b = await box(page, '[role="dialog"] button[aria-label="Close"]');
  return b.width < 24 && b.height < 24;
};
const tabsCramped = async (page: Page) => {
  const a = await box(page, '#day-tab-Mon');
  const b = await box(page, '#day-tab-Tue');
  return a.height < 24 && gapBetween(a, b) < 4;
};
const touching = (first: string, second: string) => async (page: Page) => gapBetween(await box(page, first), await box(page, second)) < 4;
const unexplained = (hint: string, button: string) => async (page: Page) => {
  await expect(page.getByRole('button', { name: button })).toBeDisabled();
  return !(await page.locator(hint).isVisible());
};
/** The book button comes after the last review (healthy: between the facts and the reviews). */
const bookAfterReviews = async (page: Page) => {
  const b = await box(page, 'button:has-text("Book this class")');
  const r = await page.locator('.review').last().boundingBox();
  return r !== null && b.y > r.y + r.height;
};
const bookBelowFold = async (page: Page) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  const b = await box(page, 'button:has-text("Book this class")');
  return b.y >= (page.viewportSize()?.height ?? 0);
};
const sameLook = (first: string, second: string) => async (page: Page) => (await looks(page, first)) === (await looks(page, second));
const farFromField = (field: string, error: string) => async (page: Page) => {
  const f = await box(page, field);
  const e = await box(page, error);
  return e.y - (f.y + f.height) > 48;
};

const CASES: Case[] = [
  { id: 'P01', station: 'cart', width: 'phone', other: 'desktop', name: 'stepper buttons below 24 px',
    prepare: openCart, criterion: stepTiny },
  { id: 'P02', station: 'class-detail', width: 'phone', other: 'tablet', name: 'dialog close button below 24 px',
    prepare: async (p, u) => { await openClass(p, u); await dialogFrom(p, 'Book this class'); }, criterion: closeTiny },
  { id: 'P02', station: 'cart', width: 'phone', other: 'tablet', name: 'dialog close button below 24 px',
    prepare: async (p, u) => { await openCart(p, u); await dialogFrom(p, 'Remove'); }, criterion: closeTiny },
  { id: 'P02', station: 'settings', width: 'phone', other: 'tablet', name: 'dialog close button below 24 px',
    prepare: async (p, u) => { await openSettings(p, u); await dialogFrom(p, 'Reset to defaults'); }, criterion: closeTiny },
  { id: 'P03', station: 'schedule', width: 'tablet', other: 'phone', name: 'day tabs below 24 px and under 4 px apart',
    prepare: async (p, u) => { await p.goto(`${u}/schedule`); await expect(p.getByRole('tab', { name: 'Mon' })).toBeVisible(); },
    criterion: tabsCramped },
  { id: 'P04', station: 'bookings', width: 'phone', other: 'tablet', name: 'Reschedule and Cancel under 4 px apart',
    prepare: openBookings, criterion: touching('.booking >> button:has-text("Reschedule")', '.booking >> button:has-text("Cancel")') },
  { id: 'P04', station: 'cart', width: 'phone', other: 'tablet', name: 'Increase spots and Remove under 4 px apart',
    prepare: openCart, criterion: touching('button[aria-label="Increase spots"]', '.cart-item button:has-text("Remove")') },
  { id: 'P05', station: 'checkout', width: 'desktop', other: 'phone', name: 'disabled Place booking without visible explanation',
    prepare: openCheckout, criterion: unexplained('#terms-hint', 'Place booking') },
  { id: 'P05', station: 'class-detail', width: 'desktop', other: 'phone', name: 'disabled Book this class without visible explanation',
    prepare: async (p, u) => { await p.goto(`${u}/classes/${FULL}`); await expect(p.getByRole('button', { name: 'Book this class' })).toBeVisible(); },
    criterion: unexplained('#book-blocked', 'Book this class') },
  { id: 'P06', station: 'class-detail', width: 'phone', other: 'desktop', name: 'Book this class after the reviews and below the visible area',
    prepare: (p, u) => openClass(p, u), criterion: bookAfterReviews, whenActive: bookBelowFold },
  { id: 'P07', station: 'settings', width: 'tablet', other: 'phone', name: 'Save changes and Reset to defaults look the same',
    prepare: openSettings, criterion: sameLook('button:has-text("Save changes")', 'button:has-text("Reset to defaults")') },
  { id: 'P07', station: 'settings', width: 'desktop', other: 'phone', name: 'Save changes and Reset to defaults look the same',
    prepare: openSettings, criterion: sameLook('button:has-text("Save changes")', 'button:has-text("Reset to defaults")') },
  { id: 'P07', station: 'bookings', width: 'desktop', other: 'phone', name: 'Reschedule and Cancel look the same',
    prepare: openBookings, criterion: sameLook('.booking >> button:has-text("Reschedule")', '.booking >> button:has-text("Cancel")') },
  { id: 'P08', station: 'register', width: 'phone', other: 'desktop', name: 'name error more than 48 px from its field',
    prepare: async (p, u) => { await p.goto(`${u}/register`); await p.getByRole('button', { name: 'Create account' }).click(); await expect(p.locator('#register-name-error')).toBeVisible(); },
    criterion: farFromField('#register-name', '#register-name-error') },
  { id: 'P08', station: 'login', width: 'phone', other: 'desktop', name: 'login error more than 48 px from the password field',
    prepare: async (p, u) => { await p.goto(`${u}/login`); await p.getByRole('button', { name: 'Log in', exact: true }).first().click(); await expect(p.locator('#login-error')).toBeVisible(); },
    criterion: farFromField('#login-password', '#login-error') },
];

/** Console errors and page errors; a bug of these two categories must not leave any. */
function watchConsole(page: Page) {
  const lines: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') lines.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => lines.push(`pageerror: ${e}`));
  return lines;
}

for (const c of CASES) {
  test.describe(`${c.id}@${c.station}:${c.width}`, () => {
    let app: App;
    test.beforeAll(async () => { app = await startApp({ activate: `${c.id}@${c.station}:${c.width}` }); });
    test.afterAll(async () => { await app?.stop(); });

    test(`active at ${c.width}: ${c.name}`, async ({ page }) => {
      const noise = watchConsole(page);
      await page.setViewportSize(VIEW[c.width]);
      await c.prepare(page, app.url);
      expect(await c.criterion(page)).toBe(true);
      if (c.whenActive) expect(await c.whenActive(page)).toBe(true);
      expect(noise).toEqual([]);
    });

    if (c.other) {
      const other = c.other;
      test(`same page at ${other}: criterion not met`, async ({ page }) => {
        await page.setViewportSize(VIEW[other]);
        await c.prepare(page, app.url);
        expect(await c.criterion(page)).toBe(false);
      });
    }
  });
}

test.describe('healthy app (--no-bugs)', () => {
  let app: App;
  test.beforeAll(async () => { app = await startApp({ noBugs: true }); });
  test.afterAll(async () => { await app?.stop(); });

  for (const c of CASES) {
    test(`${c.id}@${c.station}:${c.width} criterion not met`, async ({ page }) => {
      await page.setViewportSize(VIEW[c.width]);
      await c.prepare(page, app.url);
      expect(await c.criterion(page)).toBe(false);
    });
  }
});

test.describe('station isolation: a bug switched on for one station leaves the other stations of the same bug clean', () => {
  const ids = [...new Set(CASES.map((c) => c.id))].filter((id) => new Set(CASES.filter((c) => c.id === id).map((c) => c.station)).size > 1);
  test('the catalog has multi-station bugs to isolate', () => {
    expect(ids).toEqual(['P02', 'P04', 'P05', 'P07', 'P08']);
  });
  for (const id of ids) {
    const mine = CASES.filter((c) => c.id === id);
    const main = mine[0];
    test.describe(`${id} active only at ${main.station}`, () => {
      let app: App;
      test.beforeAll(async () => { app = await startApp({ activate: `${id}@${main.station}:${main.width}` }); });
      test.afterAll(async () => { await app?.stop(); });
      test(`positive: ${id} acts at ${main.station}`, async ({ page }) => {
        await page.setViewportSize(VIEW[main.width]);
        await main.prepare(page, app.url);
        expect(await main.criterion(page)).toBe(true);
      });
      for (const side of mine.filter((c) => c.station !== main.station)) {
        test(`${id} stays off at ${side.station} (${side.width})`, async ({ page }) => {
          await page.setViewportSize(VIEW[side.width]);
          await side.prepare(page, app.url);
          expect(await side.criterion(page)).toBe(false);
        });
      }
    });
  }
});

test.describe('no trace without activation', () => {
  const styleCount = (page: Page) => page.evaluate(() => document.querySelectorAll('style').length);
  test('--no-bugs: the shipped script has no css or setup calls and the page gets no style element; a bug adds one', async ({ page, request }) => {
    const healthy = await startApp({ noBugs: true });
    try {
      const js = await (await request.get(`${healthy.url}/assets/runtime.js`)).text();
      expect(js).not.toContain('__sw.css(');
      expect(js).not.toContain('__sw.run(');
      await page.setViewportSize(VIEW.phone);
      await page.goto(`${healthy.url}/cart`);
      await expect(page.locator('body')).toBeVisible();
      await page.waitForTimeout(300);
      expect(await styleCount(page), 'no style element injected without an active bug').toBe(0);
    } finally { await healthy.stop(); }
    const active = await startApp({ activate: 'P01@cart:phone' });
    try {
      const js = await (await request.get(`${active.url}/assets/runtime.js`)).text();
      expect(js, 'positive: with a bug the script carries the css call').toContain('__sw.css(');
      await page.setViewportSize(VIEW.phone);
      await page.goto(`${active.url}/cart`);
      await page.waitForTimeout(300);
      expect(await styleCount(page)).toBe(1);
    } finally { await active.stop(); }
  });
});

test.describe('catalog and shipped script', () => {
  test('loadCatalog() holds P01–P08 without validation errors, 4 fiddly and 4 next-step, width rules', async () => {
    process.env.CODER_PARCOURS_PUBLIC_DIR = 'bugs/public';
    const { loadCatalog } = await import(pathToFileURL(join(ROOT, 'catalog/load.mjs')).href);
    const catalog = await loadCatalog();
    const mine = catalog.bugs.filter((b: { id: string }) => IDS.includes(b.id));
    expect(mine.map((b: { id: string }) => b.id).sort()).toEqual(IDS);
    const count = (f: (b: { category: string; widths: string[]; stations: string[] }) => boolean) => mine.filter(f).length;
    expect(count((b) => b.category === 'fiddly')).toBe(4);
    expect(count((b) => b.category === 'next-step')).toBe(4);
    const only = (w: string) => count((b) => b.widths.length === 1 && b.widths[0] === w);
    expect(only('phone')).toBeGreaterThanOrEqual(4);
    expect(only('tablet')).toBeGreaterThanOrEqual(1);
    expect(only('desktop')).toBeGreaterThanOrEqual(1);
    expect(only('all')).toBeLessThanOrEqual(2);
    expect(count((b) => b.stations.length >= 2)).toBeGreaterThanOrEqual(3);
    // every listed station (and width) of every bug is exercised by an active case above
    for (const b of mine) {
      for (const s of b.stations) expect(CASES.some((c) => c.id === b.id && c.station === s), `${b.id} station ${s}`).toBe(true);
      for (const w of b.widths) expect(CASES.some((c) => c.id === b.id && c.width === w), `${b.id} width ${w}`).toBe(true);
    }
  });

  test('the shipped script names none of the bugs', async ({ request }) => {
    process.env.CODER_PARCOURS_PUBLIC_DIR = 'bugs/public';
    const { loadCatalog } = await import(pathToFileURL(join(ROOT, 'catalog/load.mjs')).href);
    const mine = (await loadCatalog()).bugs.filter((b: { id: string }) => IDS.includes(b.id));
    const all = [...new Set(CASES.map((c) => `${c.id}@${c.station}:${c.width}`))].join(',');
    const app = await startApp({ activate: all });
    try {
      const js = await (await request.get(`${app.url}/assets/runtime.js`)).text();
      expect(js).toContain('__sw.css(');
      for (const b of mine) {
        expect(js).not.toContain(b.id);
        expect(js).not.toContain(b.title);
      }
    } finally {
      await app.stop();
    }
  });
});
