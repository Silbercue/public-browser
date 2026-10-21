export default {
  id: 'P01',
  category: 'fiddly',
  title: 'Cart spot stepper shrinks on phones',
  stations: ['cart'],
  widths: ['phone'],
  severity: 'medium',
  symptom: 'On a phone, the minus and plus buttons that change the number of spots in the cart are tiny (about 22 px) and hard to tap.',
  grader: 'Counts when the report says the spot stepper (minus/plus, number of spots) in the cart is too small or hard to tap on a phone. Does not count: general remarks about cart layout, the Remove button, or the stepper limits 1 and 5.',
  client: {
    css: (ctx) => `${ctx.section} .step { width: 22px; height: 22px; font-size: 0.85rem; border-width: 1px; border-radius: 4px; }
${ctx.section} .stepper { gap: 6px; }`,
  },
};
