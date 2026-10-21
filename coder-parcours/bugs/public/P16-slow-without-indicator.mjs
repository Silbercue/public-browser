export default {
  id: 'P16',
  category: 'timing',
  title: 'Slow answer without a loading indicator',
  stations: ['class-detail', 'cart'],
  widths: ['all'],
  severity: 'medium',
  symptom: 'After clicking Book this class (class page) or Apply (coupon in the cart), nothing visible happens for about four seconds: the button only greys out, no spinner or message; then the result appears.',
  grader: 'Counts when the report says booking a class or applying a coupon is slow, takes several seconds, or shows no loading feedback while waiting. Does not count: the result once it appears (dialog, coupon message), or remarks about page load speed in general.',
  roles: {
    trap: { reached: 'the slow request was sent', passed: 'the visitor stayed on the page until the answer arrived' },
  },
  client: {
    setup(api, ctx) {
      const path = ctx.station === 'cart' ? '/api/cart/coupon' : '/api/cart/items';
      api.fetch((url, init) => {
        const method = String((init && init.method) || 'GET').toUpperCase();
        if (method !== 'POST' || new URL(url, location.href).pathname !== path) return undefined;
        api.beacon('reached');
        setTimeout(() => { if (document.querySelector(ctx.section)) api.beacon('passed'); }, 4300);
        return { delayMs: 4000 };
      });
    },
  },
};
