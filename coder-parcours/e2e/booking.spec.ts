// Healthy app (no bugs): schedule, class detail, cart, checkout, confirmation, layout rules at all three widths.
import { test as base, expect, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'app/dist');
const MAYA = { email: 'maya@stillwater.test', password: 'lotus-breath-26', name: 'Maya Lind' };
const WIDTHS = [390, 768, 1440];

/** Everything a page leaves behind that the study would count: console errors, page errors, failed or 4xx/5xx requests. */
type Noise = { console: string[]; failed: string[]; http: Array<{ status: number; url: string }> };
type Fixtures = { app: { url: string }; noise: Noise };

const test = base.extend<Fixtures>({
  app: async ({}, use) => {
    const { spawnAppServer } = await import(pathToFileURL(join(ROOT, 'server/spawn.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'cp-booking-'));
    const srv = await spawnAppServer({ seed: 1, session: 'explore', noBugs: true, staticDir: DIST, reportsFile: join(dir, 'reports.jsonl') });
    await use({ url: srv.url.replace(/\/$/, '') });
    await srv.stop();
  },
  noise: async ({ page }, use) => {
    const noise: Noise = { console: [], failed: [], http: [] };
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') noise.console.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => noise.console.push(`pageerror: ${e}`));
    page.on('requestfailed', (r) => noise.failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) noise.http.push({ status: r.status(), url: r.url() }); });
    await use(noise);
  },
});

/** Nothing but the HTTP errors a test provokes on purpose (Chrome logs each of them as one console error). */
function expectClean(noise: Noise, allowed: Array<{ status: number; path: string }> = []) {
  const ok = (status: number, url: string) => allowed.some((a) => a.status === status && new URL(url).pathname === a.path);
  expect(noise.http.filter((h) => !ok(h.status, h.url))).toEqual([]);
  const allowedStatuses = allowed.map((a) => `status of ${a.status}`);
  expect(noise.console.filter((c) => !allowedStatuses.some((s) => c.includes(s)))).toEqual([]);
  expect(noise.failed).toEqual([]);
}

/** Lets running requests finish before the test leaves the page, so no fetch is cut off by the test itself. */
async function go(page: Page, url: string) {
  await page.waitForLoadState('networkidle');
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

async function login(page: Page) {
  await page.getByLabel('Email').fill(MAYA.email);
  await page.getByLabel('Password').fill(MAYA.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

const card = (page: Page, name: string) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });

async function addToCart(page: Page, url: string, classId: string) {
  await go(page, `${url}/classes/${classId}`);
  await page.getByRole('button', { name: 'Book this class' }).click();
  const dialog = page.getByRole('dialog', { name: 'Added to cart' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('whole booking: schedule, class, cart, YOGA10, checkout with login detour, confirmation, my bookings', async ({ page, app, noise }) => {
  await go(page, `${app.url}/schedule`);
  await expect(page.locator('[data-section="schedule"] h1')).toHaveText('Schedule');
  const tabs = page.getByRole('tablist');
  await expect(tabs.getByRole('tab')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  // Opens on the first day that still has classes to come.
  await expect(tabs.getByRole('tab', { name: 'Wed' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Sat' }).click();
  await expect(tabs.getByRole('tab', { name: 'Sat' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: 'Wed' })).toHaveAttribute('aria-selected', 'false');
  const weekend = card(page, 'Weekend Vinyasa');
  await expect(weekend).toContainText('09:30');
  await expect(weekend).toContainText('Lena Park');
  await expect(weekend).toContainText('$23');
  await expect(weekend).toContainText('6 spots left');
  await weekend.getByRole('link', { name: /View class/ }).click();

  await expect(page).toHaveURL(/\/classes\/c12$/);
  const detail = page.locator('[data-section="class-detail"]');
  await expect(detail.getByRole('heading', { level: 1 })).toHaveText('Weekend Vinyasa');
  await expect(detail).toContainText('A playful, longer flow to start the weekend.');
  await expect(detail).toContainText('Lena Park');
  await expect(detail).toContainText('$23');
  await expect(detail.getByRole('heading', { name: 'Reviews' })).toBeVisible();
  await expect(detail.locator('.review')).toHaveCount(3);
  await page.getByRole('button', { name: 'Book this class' }).click();
  const dialog = page.getByRole('dialog', { name: 'Added to cart' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cart (1)' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Go to cart' }).click();

  await expect(page).toHaveURL(/\/cart$/);
  const cart = page.locator('[data-section="cart"]');
  await expect(cart.getByRole('heading', { name: 'Weekend Vinyasa' })).toBeVisible();
  await page.getByRole('button', { name: 'Increase spots' }).click();
  await expect(cart.getByTestId('spots-value')).toHaveText('2');
  await expect(page.getByRole('link', { name: 'Cart (2)' })).toBeVisible();
  await expect(cart.getByTestId('subtotal')).toHaveText('$46');
  await expect(cart.getByTestId('total')).toHaveText('$46');
  await page.getByLabel('Coupon code').fill('yoga10');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(cart.getByTestId('coupon-message')).toHaveText('YOGA10 applied: 10% off.');
  await expect(cart.getByTestId('discount')).toHaveText('−$4.60');
  await expect(cart.getByTestId('total')).toHaveText('$41.40');
  await page.getByRole('link', { name: 'Continue to checkout' }).click();

  // Guest: off to the login page with the reason, then straight back.
  await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
  await expect(page.getByText('Please log in to book.')).toBeVisible();
  await login(page);
  await expect(page).toHaveURL(/\/checkout$/);
  const checkout = page.locator('[data-section="checkout"]');
  await expect(checkout).toContainText(MAYA.name);
  await expect(checkout).toContainText(MAYA.email);
  await expect(checkout).toContainText('Weekend Vinyasa');
  await expect(checkout.getByTestId('total')).toHaveText('$41.40');
  const place = page.getByRole('button', { name: 'Place booking' });
  const terms = page.getByLabel('I accept the studio terms');
  const why = page.getByText('Please accept the studio terms to continue.');
  await expect(terms).not.toBeChecked();
  await expect(place).toBeDisabled();
  await expect(why).toBeVisible();
  const [w, p] = await Promise.all([why.boundingBox(), place.boundingBox()]);
  expect(w!.y + w!.height).toBeLessThanOrEqual(p!.y + 1);
  expect(p!.y - (w!.y + w!.height)).toBeLessThan(24);
  await terms.check();
  await expect(place).toBeEnabled();
  await expect(why).toHaveCount(0);

  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/checkout', async (route) => { await held; await route.continue(); });
  await place.click();
  const busy = page.getByRole('button', { name: 'Booking…' });
  await expect(busy).toHaveAttribute('aria-busy', 'true');
  await expect(busy).toBeDisabled();
  release();

  await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
  const ref = (await page.getByTestId('reference').textContent())!.trim();
  expect(ref).toMatch(/^SW-[A-Z0-9]{4}$/);
  expect(page.url()).toContain(`/confirmation/${ref}`);
  await expect(page.getByRole('link', { name: 'Cart (0)' })).toBeVisible();
  await page.getByRole('link', { name: 'See my bookings' }).click();
  const booked = page.locator('[data-section="bookings"] li').filter({ hasText: 'Weekend Vinyasa' });
  await expect(booked).toContainText(ref);
  await expect(booked).toContainText('2 spots');
  await page.unroute('**/api/checkout');
  expectClean(noise);
});

test('login page shows the booking hint only when it comes from checkout', async ({ page, app, noise }) => {
  await go(page, `${app.url}/login`);
  await expect(page.locator('[data-section="login"]')).toBeVisible();
  await expect(page.getByText('Please log in to book.')).toHaveCount(0);
  await go(page, `${app.url}/checkout`);
  await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
  await expect(page.getByText('Please log in to book.')).toBeVisible();
  expectClean(noise);
});

test('expired coupon shows its server message directly under the field, total unchanged', async ({ page, app, noise }) => {
  await addToCart(page, app.url, 'c12');
  await go(page, `${app.url}/cart`);
  await page.getByLabel('Coupon code').fill('SPRING25');
  await page.getByRole('button', { name: 'Apply' }).click();
  const msg = page.getByTestId('coupon-message');
  await expect(msg).toHaveText('This code expired on March 31.');
  await expect(msg).toHaveAttribute('role', 'alert');
  const [field, m, apply] = await Promise.all([page.getByLabel('Coupon code').boundingBox(), msg.boundingBox(), page.getByRole('button', { name: 'Apply' }).boundingBox()]);
  expect(m!.y).toBeGreaterThanOrEqual(Math.max(field!.y + field!.height, apply!.y + apply!.height) - 1);
  expect(m!.y - (field!.y + field!.height)).toBeLessThan(40);
  await expect(page.getByTestId('discount')).toHaveCount(0);
  await expect(page.getByTestId('total')).toHaveText('$23');
  expectClean(noise, [{ status: 400, path: '/api/cart/coupon' }]);
});

test('spots stepper stops at 1 and 5, remove asks first', async ({ page, app, noise }) => {
  await addToCart(page, app.url, 'c12');
  await go(page, `${app.url}/cart`);
  const minus = page.getByRole('button', { name: 'Decrease spots' });
  const plus = page.getByRole('button', { name: 'Increase spots' });
  const value = page.getByTestId('spots-value');
  await expect(value).toHaveText('1');
  await expect(minus).toBeDisabled();
  await expect(plus).toBeEnabled();
  for (const n of [2, 3, 4, 5]) {
    await plus.click();
    await expect(value).toHaveText(String(n));
  }
  await expect(plus).toBeDisabled();
  await expect(minus).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Cart (5)' })).toBeVisible();
  await expect(page.getByTestId('subtotal')).toHaveText('$115');
  await minus.click();
  await expect(value).toHaveText('4');
  await expect(plus).toBeEnabled();
  await page.reload();
  await expect(page.getByTestId('spots-value')).toHaveText('4');

  await page.getByRole('button', { name: 'Remove' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove this class?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep it' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('spots-value')).toHaveText('4');
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog', { name: 'Remove this class?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cart (0)' })).toBeVisible();
  await page.locator('[data-section="cart"]').getByRole('link', { name: 'Browse the schedule' }).click();
  await expect(page).toHaveURL(/\/schedule$/);
  expectClean(noise);
});

test('full class and ended class cannot be booked, ended classes are marked in the schedule', async ({ page, app, noise }) => {
  await go(page, `${app.url}/classes/c09`);
  const book = page.getByRole('button', { name: 'Book this class' });
  await expect(book).toBeDisabled();
  await expect(page.getByText('Class full — check another day')).toBeVisible();
  await expect(page.getByText('This class has ended.')).toHaveCount(0);
  const [b, t] = await Promise.all([book.boundingBox(), page.getByText('Class full — check another day').boundingBox()]);
  expect(t!.y).toBeGreaterThanOrEqual(b!.y + b!.height - 1);

  await go(page, `${app.url}/classes/c01`);
  await expect(page.getByRole('button', { name: 'Book this class' })).toBeDisabled();
  await expect(page.getByText('This class has ended.')).toBeVisible();
  await expect(page.getByText('Class full — check another day')).toHaveCount(0);

  await go(page, `${app.url}/classes/c12`);
  await expect(page.getByRole('button', { name: 'Book this class' })).toBeEnabled();
  await expect(page.getByText('This class has ended.')).toHaveCount(0);
  await expect(page.getByText('Class full — check another day')).toHaveCount(0);

  await go(page, `${app.url}/schedule`);
  await page.getByRole('tab', { name: 'Mon' }).click();
  await expect(card(page, 'Morning Vinyasa Flow')).toContainText('Ended');
  await expect(card(page, 'Morning Vinyasa Flow')).toHaveClass(/ended/);
  await page.getByRole('tab', { name: 'Sat' }).click();
  await expect(card(page, 'Weekend Vinyasa')).not.toContainText('Ended');
  await expect(card(page, 'Weekend Vinyasa')).not.toHaveClass(/ended/);
  await expect(card(page, 'Power Core')).toContainText('Full');
  expectClean(noise);
});

test('filter chips narrow the day, no match shows the empty state, Clear filters resets', async ({ page, app, noise }) => {
  await go(page, `${app.url}/schedule`);
  const chip = (name: string) => page.getByRole('button', { name, exact: true });
  await expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
  for (const n of ['Beginner', 'Vinyasa', 'Yin', 'Evening']) await expect(chip(n)).toHaveAttribute('aria-pressed', 'false');
  const cards = page.locator('[data-section="schedule"] .class-card');
  await expect(cards).toHaveCount(3); // Wednesday
  await chip('Yin').click();
  await expect(chip('Yin')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('All')).toHaveAttribute('aria-pressed', 'false');
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('Deep Yin');
  await chip('Evening').click();
  await expect(cards).toHaveCount(1);
  await chip('Beginner').click();
  await expect(cards).toHaveCount(0);
  await expect(page.getByText('No classes match these filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chip('All')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('Yin')).toHaveAttribute('aria-pressed', 'false');
  await expect(cards).toHaveCount(3);
  await expect(page.getByText('No classes match these filters.')).toHaveCount(0);
  // Two styles together show both.
  await chip('Vinyasa').click();
  await chip('Yin').click();
  await expect(cards).toHaveCount(2);
  await chip('All').click();
  await expect(cards).toHaveCount(3);
  expectClean(noise);
});

/** Overflow, control size, spacing and text contrast of the current page; returns readable problems. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.scrollWidth > window.innerWidth) out.push(`overflow ${de.scrollWidth} > ${window.innerWidth}`);
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
    };
    const name = (el: Element) => `${el.tagName.toLowerCase()}"${(el.textContent || el.getAttribute('aria-label') || (el as HTMLInputElement).name || '').trim().slice(0, 30)}"`;
    const scope = document.querySelector('[role="dialog"]') ?? document.body;
    const controls = [...scope.querySelectorAll('button, input, textarea, select, [role="switch"], [role="tab"]')].filter(visible);
    for (const el of controls) {
      const h = el.getBoundingClientRect().height;
      if (h < 44) out.push(`small ${name(el)} ${h}px`);
    }
    const interactive = [...scope.querySelectorAll('a, button, input, textarea, select')].filter(visible);
    for (let i = 0; i < interactive.length; i++) {
      for (let j = i + 1; j < interactive.length; j++) {
        const a = interactive[i], b = interactive[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const dx = Math.max(0, rb.left - ra.right, ra.left - rb.right);
        const dy = Math.max(0, rb.top - ra.bottom, ra.top - rb.bottom);
        if (dx < 7.99 && dy < 7.99) out.push(`tight ${name(a)} / ${name(b)} dx=${dx} dy=${dy}`);
      }
    }
    const rgb = (s: string) => (s.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c;
      }
      return [255, 255, 255];
    };
    const opacityOf = (el: Element | null) => {
      let o = 1;
      for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
      return o;
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const checked = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || checked.has(el) || !n.textContent?.trim() || !visible(el)) continue;
      checked.add(el);
      if (opacityOf(el) < 1) out.push(`faded ${name(el)}`);
      const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) out.push(`contrast ${name(el)} ${ratio.toFixed(2)}`);
    }
    return out;
  });
}

test('layout rules on all booking pages and dialogs at 390, 768 and 1440 px', async ({ page, app, noise }) => {
  const check = async (label: string) => {
    await page.waitForLoadState('networkidle');
    expect(await layoutProblems(page), label).toEqual([]);
  };
  await go(page, `${app.url}/login?next=%2Fcheckout`);
  await login(page);
  await expect(page.locator('[data-section="checkout"]')).toBeVisible();
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await go(page, `${app.url}/schedule`);
    await expect(page.locator('.class-card').first()).toBeVisible();
    await check(`schedule @ ${w}`);
    // Day names stay on one line: every tab keeps the single-line height.
    for (const box of await Promise.all((await page.getByRole('tab').all()).map((t) => t.boundingBox()))) {
      expect(box!.height, `tab height @ ${w}`).toBeLessThanOrEqual(46);
    }
    await page.getByRole('tab', { name: 'Mon' }).click();
    await check(`schedule ended @ ${w}`);
    await page.getByRole('button', { name: 'Beginner', exact: true }).click();
    await page.getByRole('button', { name: 'Evening', exact: true }).click();
    await page.getByRole('button', { name: 'Vinyasa', exact: true }).click();
    await expect(page.getByText('No classes match these filters.')).toBeVisible();
    await check(`schedule empty @ ${w}`);

    for (const id of ['c09', 'c01']) {
      await go(page, `${app.url}/classes/${id}`);
      await expect(page.locator('.review').first()).toBeVisible();
      await check(`class ${id} @ ${w}`);
    }
    const dialog = await addToCart(page, app.url, w === 390 ? 'c12' : w === 768 ? 'c14' : 'c10');
    await expect(dialog).toBeVisible();
    await check(`added dialog @ ${w}`);
    await dialog.getByRole('button', { name: 'Keep browsing' }).click();
    await expect(dialog).toHaveCount(0);
    await check(`class after dialog @ ${w}`);

    await go(page, `${app.url}/cart`);
    await page.getByLabel('Coupon code').fill('YOGA10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('coupon-message')).toBeVisible();
    await check(`cart @ ${w}`);
    await page.getByRole('button', { name: 'Remove' }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await check(`remove dialog @ ${w}`);
    await page.keyboard.press('Escape');

    await go(page, `${app.url}/checkout`);
    await expect(page.getByRole('button', { name: 'Place booking' })).toBeVisible();
    await check(`checkout @ ${w}`);
    await page.getByLabel('I accept the studio terms').check();
    await check(`checkout ticked @ ${w}`);
    await page.getByRole('button', { name: 'Place booking' }).click();
    await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
    await check(`confirmation @ ${w}`);

    await go(page, `${app.url}/cart`);
    await expect(page.getByText('Your cart is empty.')).toBeVisible();
    await check(`empty cart @ ${w}`);
  }
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await go(page, `${app.url}/checkout`);
    await expect(page.getByText('Please log in to book.')).toBeVisible();
    await check(`login from checkout @ ${w}`);
  }
  expectClean(noise);
});

test('day tabs: arrow keys, Home and End move the selection and the focus; Left wraps from the first to the last day', async ({ page, app, noise }) => {
  await go(page, `${app.url}/schedule`);
  const tabs = page.getByRole('tablist').getByRole('tab');
  const selected = () => page.getByRole('tablist').getByRole('tab', { selected: true });
  await expect(selected()).toHaveText('Wed');
  await selected().focus();
  await page.keyboard.press('ArrowRight');
  await expect(selected()).toHaveText('Thu');
  await expect(tabs.filter({ hasText: 'Thu' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(selected()).toHaveText('Sun');
  await page.keyboard.press('ArrowRight');
  await expect(selected(), 'Right wraps from the last day to the first').toHaveText('Mon');
  await page.keyboard.press('ArrowLeft');
  await expect(selected(), 'Left wraps from the first day to the last').toHaveText('Sun');
  await page.keyboard.press('Home');
  await expect(selected()).toHaveText('Mon');
  await expect(tabs.filter({ hasText: 'Mon' })).toBeFocused();
  await page.keyboard.press('a');
  await expect(selected(), 'other keys change nothing').toHaveText('Mon');
  expectClean(noise);
});

test('class page: a refused booking shows the server message as alert and the button works again', async ({ page, app, noise }) => {
  await go(page, `${app.url}/classes/c12`);
  await page.route('**/api/cart/items', (route) => route.fulfill({ status: 400, json: { error: 'spots_range', message: 'Pick between 1 and 5 spots.' } }));
  await page.getByRole('button', { name: 'Book this class' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pick between 1 and 5 spots.' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Added to cart' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Book this class' })).toBeEnabled();
  await page.unroute('**/api/cart/items');
  await page.getByRole('button', { name: 'Book this class' }).click();
  await expect(page.getByRole('dialog', { name: 'Added to cart' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expectClean(noise, [{ status: 400, path: '/api/cart/items' }]);
});

test('cart: a refused change shows its message at the line and brings back the server value', async ({ page, app, noise }) => {
  await addToCart(page, app.url, 'c12');
  await go(page, `${app.url}/cart`);
  let patched = '';
  await page.route('**/api/cart/items/*', (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patched = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 400, json: { error: 'spots_range', message: 'Pick between 1 and 5 spots.' } });
  });
  await page.getByRole('button', { name: 'Increase spots' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pick between 1 and 5 spots.' })).toBeVisible();
  await expect(page.getByTestId('spots-value'), 'the value of the server, not the optimistic one').toHaveText('1');
  await page.unroute('**/api/cart/items/*');
  await page.getByRole('button', { name: 'Increase spots' }).click();
  await expect(page.getByTestId('spots-value')).toHaveText('2');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expectClean(noise, [{ status: 400, path: patched }]);
});

test('remove dialog: Escape closes it and keeps the class', async ({ page, app, noise }) => {
  await addToCart(page, app.url, 'c12');
  await go(page, `${app.url}/cart`);
  await page.getByRole('button', { name: 'Remove' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove this class?' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('spots-value')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Remove' })).toBeVisible();
  expectClean(noise);
});

test.describe('checkout: login and error branches', () => {
  async function toCheckout(page: Page, url: string) {
    await addToCart(page, url, 'c12');
    await go(page, `${url}/login?next=%2Fcheckout`);
    await login(page);
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByRole('button', { name: 'Place booking' })).toBeVisible();
  }

  test('a refused booking shows the message, keeps the visitor on the page and re-enables the button', async ({ page, app, noise }) => {
    await toCheckout(page, app.url);
    await page.getByLabel('I accept the studio terms').check();
    await page.route('**/api/checkout', (route) => route.fulfill({ status: 409, json: { error: 'already_booked', message: 'You already booked this class.' } }));
    await page.getByRole('button', { name: 'Place booking' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'You already booked this class.' })).toBeVisible();
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByRole('button', { name: 'Place booking' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Booking…' })).toHaveCount(0);
    await page.unroute('**/api/checkout');
    await page.getByRole('button', { name: 'Place booking' }).click();
    await expect(page.getByRole('heading', { name: 'Booking confirmed' })).toBeVisible();
    expectClean(noise, [{ status: 409, path: '/api/checkout' }]);
  });

  test('login_required while placing the booking sends the visitor to the login page with the booking hint', async ({ page, app, noise }) => {
    await toCheckout(page, app.url);
    await page.getByLabel('I accept the studio terms').check();
    await page.route('**/api/checkout', (route) => route.fulfill({ status: 401, json: { error: 'login_required', message: 'Please log in to continue.' } }));
    await page.getByRole('button', { name: 'Place booking' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
    await expect(page.getByText('Please log in to book.')).toBeVisible();
    expectClean(noise, [{ status: 401, path: '/api/checkout' }]);
  });

  test('session_expired while placing the booking shows the expiry notice on the login page', async ({ page, app, noise }) => {
    await toCheckout(page, app.url);
    await page.getByLabel('I accept the studio terms').check();
    await page.route('**/api/checkout', (route) => route.fulfill({ status: 401, json: { error: 'session_expired', message: 'Your session expired. Please log in again.' } }));
    await page.getByRole('button', { name: 'Place booking' }).click();
    await expect(page.getByText('Your session expired. Please log in again.')).toBeVisible();
    await expect(page.locator('[data-section="login"]')).toBeVisible();
    expectClean(noise, [{ status: 401, path: '/api/checkout' }]);
  });

  test('login_required while the checkout loads sends the visitor to the login page', async ({ page, app, noise }) => {
    await addToCart(page, app.url, 'c12');
    await go(page, `${app.url}/login?next=%2Fcheckout`);
    await login(page);
    await expect(page).toHaveURL(/\/checkout$/);
    await page.route('**/api/profile', (route) => route.fulfill({ status: 401, json: { error: 'login_required', message: 'Please log in to continue.' } }));
    await page.reload();
    await expect(page).toHaveURL(/\/login\?next=%2Fcheckout$/);
    await expect(page.getByText('Please log in to book.')).toBeVisible();
    expectClean(noise, [{ status: 401, path: '/api/profile' }]);
  });

  test('a server error while the checkout loads shows an alert instead of the form', async ({ page, app, noise }) => {
    await addToCart(page, app.url, 'c12');
    await go(page, `${app.url}/login?next=%2Fcheckout`);
    await login(page);
    await expect(page).toHaveURL(/\/checkout$/);
    await page.route('**/api/profile', (route) => route.fulfill({ status: 500, json: { error: 'boom', message: 'Something went wrong. Please try again.' } }));
    await page.reload();
    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong. Please try again.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Place booking' })).toHaveCount(0);
    expectClean(noise, [{ status: 500, path: '/api/profile' }]);
  });
});
