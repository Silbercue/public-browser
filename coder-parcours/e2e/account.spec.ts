// Healthy app (no bugs): shell, account pages, report button, layout rules at all three widths.
import { test as base, expect, type Page, type Request } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'app/dist');
const MAYA = { email: 'maya@stillwater.test', password: 'lotus-breath-26' };
const WIDTHS = [390, 768, 1440];

type App = { url: string; reportsFile: string };
type Fixtures = { app: App; consoleErrors: string[] };

const test = base.extend<Fixtures>({
  app: async ({}, use) => {
    const { spawnAppServer } = await import(pathToFileURL(join(ROOT, 'server/spawn.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'cp-account-'));
    const reportsFile = join(dir, 'reports.jsonl');
    const srv = await spawnAppServer({ seed: 1, session: 'explore', noBugs: true, staticDir: DIST, reportsFile });
    await use({ url: srv.url.replace(/\/$/, ''), reportsFile });
    await srv.stop();
  },
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await use(errors);
  },
});

/** Console errors except the HTTP statuses a test provokes on purpose (Chrome logs every failed fetch). */
function expectNoConsoleErrors(errors: string[], allowedStatuses: number[] = []) {
  const rest = errors.filter((e) => !allowedStatuses.some((s) => e.includes(`status of ${s}`)));
  expect(rest).toEqual([]);
}

function countRequests(page: Page, test: (r: Request) => boolean) {
  const seen: Request[] = [];
  page.on('request', (r) => { if (test(r)) seen.push(r); });
  return seen;
}

async function login(page: Page, url: string) {
  await page.goto(`${url}/login`);
  await page.getByLabel('Email').fill(MAYA.email);
  await page.getByLabel('Password').fill(MAYA.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
}

/** Bottom of a lies above the top of b, with nothing of the form in between. */
async function expectDirectlyBelow(page: Page, upper: string, lower: string, next: string) {
  const [a, b, c] = await Promise.all([upper, lower, next].map((s) => page.locator(s).first().boundingBox()));
  expect(a && b && c).toBeTruthy();
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1);
  expect(b!.y + b!.height).toBeLessThanOrEqual(c!.y + 1);
}

test.describe('login', () => {
  test('empty fields: message without request; wrong password: message under the password field; success follows next', async ({ page, app, consoleErrors }) => {
    const loginCalls = countRequests(page, (r) => r.url().endsWith('/api/auth/login'));
    await page.goto(`${app.url}/login?next=/bookings`);
    await expect(page.locator('[data-section="login"]')).toBeVisible();

    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Enter your email and password.');
    expect(loginCalls.length).toBe(0);

    await page.getByLabel('Email').fill(MAYA.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.');
    expect(loginCalls.length).toBe(1);
    await expectDirectlyBelow(page, '#login-password', '[role="alert"]', 'button[type="submit"]');

    await page.getByLabel('Password').fill(MAYA.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(`${app.url}/bookings`);
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    expectNoConsoleErrors(consoleErrors, [401]);
  });

  test('foreign next is ignored, log out returns to logged-out header', async ({ page, app, consoleErrors }) => {
    await page.goto(`${app.url}/login?next=//evil.example/x`);
    await page.getByLabel('Email').fill(MAYA.email);
    await page.getByLabel('Password').fill(MAYA.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(`${app.url}/`);
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
    expectNoConsoleErrors(consoleErrors);
  });
});

test('register: short password shows a field error under the field, then the account is created', async ({ page, app, consoleErrors }) => {
  const calls = countRequests(page, (r) => r.url().endsWith('/api/auth/register'));
  await page.goto(`${app.url}/register`);
  await expect(page.locator('[data-section="register"]')).toBeVisible();
  await expect(page.getByText('At least 8 characters')).toBeVisible();
  await page.getByLabel('Name').fill('Robin Hale');
  await page.getByLabel('Email').fill('robin@example.test');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account' }).click();

  const err = page.locator('#register-password-error');
  await expect(err).toHaveText('Use at least 8 characters.');
  await expect(page.getByLabel('Password')).toHaveAttribute('aria-describedby', /register-password-error/);
  await expect(page.getByLabel('Password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#register-name-error')).toHaveCount(0);
  await expectDirectlyBelow(page, '#register-password', '#register-password-error', 'button[type="submit"]');
  expect(calls.length).toBe(0);

  // Server-side field error lands under the email field.
  await page.getByLabel('Email').fill(MAYA.email);
  await page.getByLabel('Password').fill('long-enough-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('#register-email-error')).toHaveText('An account with this email already exists.');
  await expect(page.locator('#register-password-error')).toHaveCount(0);

  await page.getByLabel('Email').fill('robin@example.test');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await expect(page).toHaveURL(`${app.url}/`);
  expectNoConsoleErrors(consoleErrors, [409]);
});

test('profile: phone is saved and survives a reload; empty name is refused without request', async ({ page, app, consoleErrors }) => {
  await login(page, app.url);
  await page.goto(`${app.url}/profile`);
  await expect(page.locator('[data-section="profile"]')).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Maya Lind');
  await page.getByLabel('Phone').fill('+1 555-0100');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toHaveText('Profile saved.');
  await page.reload();
  await expect(page.getByLabel('Phone')).toHaveValue('+1 555-0100');

  const puts = countRequests(page, (r) => r.url().endsWith('/api/profile') && r.method() === 'PUT');
  await page.getByLabel('Name').fill('   ');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.locator('#profile-name-error')).toHaveText('Enter your name.');
  expect(puts.length).toBe(0);
  expectNoConsoleErrors(consoleErrors);
});

test('settings: switches save, reset asks in a dialog (keep, escape, reset)', async ({ page, app, consoleErrors }) => {
  await login(page, app.url);
  await page.goto(`${app.url}/settings`);
  await expect(page.locator('[data-section="settings"]')).toBeVisible();
  const newsletter = page.getByRole('switch', { name: 'Newsletter' });
  const reminders = page.getByRole('switch', { name: 'Email reminders' });
  await expect(reminders).toHaveAttribute('aria-checked', 'true');
  await expect(newsletter).toHaveAttribute('aria-checked', 'false');
  await newsletter.click();
  await expect(newsletter).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Settings saved.');
  await page.reload();
  await expect(newsletter).toHaveAttribute('aria-checked', 'true');

  const resetBtn = page.getByRole('button', { name: 'Reset to defaults' });
  await resetBtn.click();
  const dialog = page.getByRole('dialog', { name: 'Reset all settings?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep my settings' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(resetBtn).toBeFocused();
  await expect(newsletter).toHaveAttribute('aria-checked', 'true');

  await resetBtn.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(resetBtn).toBeFocused();

  await resetBtn.click();
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(newsletter).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(newsletter).toHaveAttribute('aria-checked', 'false');
  await expect(reminders).toHaveAttribute('aria-checked', 'true');
  expectNoConsoleErrors(consoleErrors);
});

test.describe('bookings', () => {
  test('cancel asks first, keep leaves it, yes cancels; empty list links to the schedule', async ({ page, app, consoleErrors }) => {
    await login(page, app.url);
    await page.goto(`${app.url}/bookings`);
    await expect(page.locator('[data-section="bookings"]')).toBeVisible();
    const items = page.getByRole('listitem');
    await expect(items).toHaveCount(2);
    const first = items.filter({ hasText: 'Vinyasa Strength' });
    await expect(first).toContainText('Thu');
    await expect(first).toContainText('07:30');
    await expect(first).toContainText('1 spot');
    await expect(items.filter({ hasText: 'Yin and Breath' })).toContainText('2 spots');

    await first.getByRole('button', { name: 'Cancel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this booking?' });
    await dialog.getByRole('button', { name: 'Keep booking' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(items).toHaveCount(2);

    await first.getByRole('button', { name: 'Cancel' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel' }).click();
    await expect(items).toHaveCount(1);
    await page.reload();
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Yin and Breath');

    await items.first().getByRole('button', { name: 'Cancel' }).click();
    await dialog.getByRole('button', { name: 'Yes, cancel' }).click();
    await expect(page.getByText('No upcoming bookings.')).toBeVisible();
    await page.getByRole('link', { name: 'Browse the schedule' }).click();
    await expect(page).toHaveURL(`${app.url}/schedule`);
    expectNoConsoleErrors(consoleErrors);
  });

  test('reschedule offers matching dates and moves the booking; none left shows the empty hint', async ({ page, app, consoleErrors }) => {
    await login(page, app.url);
    await page.goto(`${app.url}/bookings`);
    const yin = page.getByRole('listitem').filter({ hasText: 'Yin and Breath' });
    await yin.getByRole('button', { name: 'Reschedule' }).click();
    const dialog = page.getByRole('dialog');
    // Yin classes: Mon 18:30 has ended, Wed 18:30 Deep Yin is the only other future one.
    await expect(dialog.getByRole('button', { name: /Deep Yin/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Yin Unwind/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: /Deep Yin/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'Deep Yin' })).toContainText('Wed');
    await expect(page.getByRole('listitem').filter({ hasText: 'Yin and Breath' })).toHaveCount(0);

    // Pretend no other Yin date exists to see the empty hint.
    await page.route('**/api/classes?style=*', (route) => route.fulfill({ json: { classes: [] } }));
    await page.getByRole('listitem').filter({ hasText: 'Deep Yin' }).getByRole('button', { name: 'Reschedule' }).click();
    await expect(page.getByRole('dialog').getByText('No other dates for this class style.')).toBeVisible();
    expectNoConsoleErrors(consoleErrors);
  });
});

test('report button only with ?report=1, remembered across pages, writes the reports file', async ({ page, app, consoleErrors }) => {
  await page.goto(`${app.url}/`);
  await expect(page.locator('[data-section="home"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report a problem' })).toHaveCount(0);

  await page.goto(`${app.url}/?report=1&tester=Anna%20M%C3%BCller`);
  await expect(page.getByRole('button', { name: 'Report a problem' })).toBeVisible();
  await page.goto(`${app.url}/login`);
  const open = page.getByRole('button', { name: 'Report a problem' });
  await expect(open).toBeVisible();

  const posts = countRequests(page, (r) => r.url().endsWith('/api/reports'));
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Report a problem' });
  await expect(dialog.getByLabel('Where?')).toHaveValue('/login');
  await expect(dialog.getByLabel('What went wrong?')).toHaveAttribute('maxlength', '4000');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Please describe the problem.');
  expect(posts.length).toBe(0);

  await page.route('**/api/reports', (route) => route.fulfill({
    status: 429, json: { error: 'too_many_reports', message: 'Too many reports. Please wait a few minutes.' },
  }));
  await dialog.getByLabel('What went wrong?').fill('The login button moved.');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Too many reports. Please wait a few minutes.');
  await expect(dialog.getByLabel('What went wrong?')).toHaveValue('The login button moved.');
  await page.unroute('**/api/reports');

  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(dialog.getByText('Thanks — report saved.')).toBeVisible();
  await expect.poll(() => existsSync(app.reportsFile)).toBe(true);
  const lines = readFileSync(app.reportsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ text: 'The login button moved.', path: '/login', tester: 'anna-m-ller' });
  expect(lines[0].viewportPx).toBe(page.viewportSize()!.width);
  expectNoConsoleErrors(consoleErrors, [429]);
});

test.describe('login redirects', () => {
  test('/profile without login goes to /login?next=/profile without the expired notice', async ({ page, app, consoleErrors }) => {
    await page.goto(`${app.url}/profile`);
    await expect(page.locator('[data-section="login"]')).toBeVisible();
    const u = new URL(page.url());
    expect(u.pathname).toBe('/login');
    expect(u.searchParams.get('next')).toBe('/profile');
    await expect(page.getByText('Your session expired. Please log in again.')).toHaveCount(0);
    expectNoConsoleErrors(consoleErrors);
  });

  test('a 401 session_expired shows the notice, goes to login and back after login', async ({ page, app, consoleErrors }) => {
    await login(page, app.url);
    await page.route('**/api/profile', (route) => route.fulfill({
      status: 401, json: { error: 'session_expired', message: 'Your session expired. Please log in again.' },
    }));
    await page.getByRole('link', { name: 'Profile' }).first().click();
    await expect(page.getByText('Your session expired. Please log in again.')).toBeVisible();
    await expect(page.locator('[data-section="login"]')).toBeVisible();
    expect(new URL(page.url()).searchParams.get('next')).toBe('/profile');
    await page.unroute('**/api/profile');
    await page.getByLabel('Email').fill(MAYA.email);
    await page.getByLabel('Password').fill(MAYA.password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page).toHaveURL(`${app.url}/profile`);
    await expect(page.getByText('Your session expired. Please log in again.')).toHaveCount(0);
    await expect(page.getByLabel('Name')).toHaveValue('Maya Lind');
    expectNoConsoleErrors(consoleErrors, [401]);
  });
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
    const name = (el: Element) => `${el.tagName.toLowerCase()}"${(el.textContent || (el as HTMLInputElement).name || '').trim().slice(0, 30)}"`;
    // With a modal open only the dialog counts: the page behind it is inert.
    const scope = document.querySelector('[role="dialog"]') ?? document.body;
    const controls = [...scope.querySelectorAll('button, input, textarea, select, [role="switch"]')].filter(visible);
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
        if (dx < 8 && dy < 8) out.push(`tight ${name(a)} / ${name(b)} dx=${dx} dy=${dy}`);
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
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const checked = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || checked.has(el) || !n.textContent?.trim() || !visible(el)) continue;
      checked.add(el);
      const ratio = (() => {
        const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      })();
      if (ratio < 4.5) out.push(`contrast ${name(el)} ${ratio.toFixed(2)}`);
    }
    return out;
  });
}

test('layout rules on all account pages at 390, 768 and 1440 px, phone menu, no console errors', async ({ page, app, consoleErrors }) => {
  await page.goto(`${app.url}/?report=1`);
  await login(page, app.url);
  const pages: Array<[string, string]> = [
    ['/', 'home'], ['/profile', 'profile'], ['/settings', 'settings'], ['/bookings', 'bookings'],
  ];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [path, section] of pages) {
      await page.goto(`${app.url}${path}`);
      await expect(page.locator(`[data-section="${section}"]`)).toBeVisible();
      await expect(page.locator('main h1')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await layoutProblems(page), `${path} @ ${w}`).toEqual([]);
    }
    await page.goto(`${app.url}/settings`);
    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await layoutProblems(page), `reset dialog @ ${w}`).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Report a problem' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await layoutProblems(page), `report dialog @ ${w}`).toEqual([]);
    await page.keyboard.press('Escape');

    const menu = page.getByRole('button', { name: 'Menu' });
    if (w === 390) {
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('link', { name: 'My bookings' })).toBeHidden();
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('link', { name: 'My bookings' })).toBeVisible();
      expect(await layoutProblems(page), `open menu @ ${w}`).toEqual([]);
      await page.getByRole('link', { name: 'My bookings' }).click();
      await expect(page.locator('[data-section="bookings"]')).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
    } else {
      await expect(menu).toBeHidden();
      await expect(page.getByRole('link', { name: 'My bookings' })).toBeVisible();
      await expect(page.getByRole('link', { name: /^Cart \(\d+\)$/ })).toBeVisible();
    }
  }
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const [path, section] of [['/login', 'login'], ['/register', 'register']]) {
      await page.goto(`${app.url}${path}`);
      await expect(page.locator(`[data-section="${section}"]`)).toBeVisible();
      expect(await layoutProblems(page), `${path} @ ${w}`).toEqual([]);
    }
  }
  expectNoConsoleErrors(consoleErrors);
});

test('placeholder routes carry their station sections', async ({ page, app, consoleErrors }) => {
  for (const [path, section] of [['/schedule', 'schedule'], ['/classes/c01', 'class-detail'], ['/cart', 'cart']]) {
    await page.goto(`${app.url}${path}`);
    await expect(page.locator(`[data-section="${section}"] h1`)).toBeVisible();
  }
  expectNoConsoleErrors(consoleErrors);
});
