export default {
  id: 'P12',
  category: 'function',
  title: 'Cart subtotal counts every class once',
  stations: ['cart', 'checkout'],
  widths: ['all'],
  severity: 'high',
  symptom: 'With more than one spot of a class, the line in the cart shows the right amount (for example 3 spots, $69), but subtotal and total only count one spot ($23). The checkout shows the same wrong total.',
  grader: 'Counts when the report says the cart or checkout subtotal or total is wrong, too low, or does not change with the number of spots, or does not match the line amounts. Does not count: remarks about the coupon messages, the stepper limits 1 and 5, or prices per spot.',
  roles: {
    change: { feature: 'The cart total now follows the number of spots booked per class.' },
    capture: { flow: 'Put 3 spots of Weekend Vinyasa ($23 per spot) in the cart and check that the cart total is $69.' },
  },
  server: {
    setup(api) {
      const recount = (h, body) => {
        if (!body || !Array.isArray(body.items)) return body;
        const subtotalCents = body.items.reduce((s, it) => s + it.priceCents, 0);
        const discountCents = body.coupon === 'YOGA10' ? Math.round(subtotalCents * 0.1) : 0;
        return { ...body, subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
      };
      for (const key of ['GET /api/cart', 'POST /api/cart/items', 'PATCH /api/cart/items/:id', 'DELETE /api/cart/items/:id', 'POST /api/cart/coupon']) {
        api.after(key, recount);
      }
    },
  },
};
