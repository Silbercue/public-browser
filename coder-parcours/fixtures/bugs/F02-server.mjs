// Test fixture: server hook with change and capture roles. The coupon request answers 200
// with the unchanged cart, so the discount is missing.
export default {
  id: 'F02',
  category: 'function',
  title: 'Coupon accepted but no discount',
  stations: ['cart'],
  widths: ['all'],
  severity: 'high',
  symptom: 'Applying YOGA10 shows no error, but the total stays the same.',
  grader: 'Counts when the report says a valid coupon is accepted without lowering the total.',
  roles: {
    change: { feature: 'Coupon codes are now applied to the cart total.' },
    capture: { flow: 'Add a class to the cart, apply YOGA10 and check that the total drops by 10 percent.' },
  },
  server: {
    setup(api) {
      api.before('POST /api/cart/coupon', async (ctx) => {
        ctx.respond(200, await ctx.cart());
      });
    },
  },
};
