// Test fixture: client CSS only, phone width, cart station.
export default {
  id: 'F01',
  category: 'fiddly',
  title: 'Cart buttons shrink on phones',
  stations: ['cart'],
  widths: ['phone'],
  severity: 'medium',
  symptom: 'On a phone, the buttons in the cart are only 18 px tall and hard to tap.',
  grader: 'Counts when the report names the cart buttons as too small or hard to tap on a phone.',
  client: {
    css: (ctx) => `${ctx.section} button { min-height: 0 !important; height: 18px !important; padding: 0 4px !important; }`,
  },
};
