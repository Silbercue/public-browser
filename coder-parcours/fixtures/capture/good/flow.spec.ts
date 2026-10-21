// Test fixture: a capture test for the fixture bug F02. Passes on the healthy app, fails when the
// coupon is accepted without lowering the total.
import { test, expect } from '@playwright/test';

test('YOGA10 lowers the cart total by 10 percent', async ({ request }) => {
  const base = process.env.APP_URL ?? '';
  const list = await request.get(new URL('/api/classes', base).href);
  expect(list.ok()).toBeTruthy();
  const { classes } = await list.json();
  const open = classes.find((k: { full: boolean, ended: boolean }) => !k.full && !k.ended);
  expect(open).toBeTruthy();
  const added = await request.post(new URL('/api/cart/items', base).href, { data: { classId: open.id, spots: 1 } });
  expect(added.ok()).toBeTruthy();
  const before = (await added.json()).totalCents;
  const coupon = await request.post(new URL('/api/cart/coupon', base).href, { data: { code: 'YOGA10' } });
  expect(coupon.ok()).toBeTruthy();
  const cart = await (await request.get(new URL('/api/cart', base).href)).json();
  expect(cart.totalCents).toBe(before - Math.round(before * 0.1));
});
