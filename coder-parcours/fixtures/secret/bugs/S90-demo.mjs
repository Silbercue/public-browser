// Test fixture for the secret folder: valid module that removes decoy D01.
export default {
  id: 'S90',
  category: 'layout',
  title: 'Cart total overlaps on phones',
  stations: ['cart'],
  widths: ['phone'],
  severity: 'low',
  symptom: 'On a phone, the cart total overlaps the checkout button.',
  grader: 'Counts when the report says the cart total covers the checkout button on a phone.',
  removesDecoys: ['D01'],
  client: {
    css: (ctx) => `${ctx.section} [data-total] { margin-bottom: -24px !important; }`,
  },
};
