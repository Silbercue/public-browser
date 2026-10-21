export default {
  id: 'P04',
  category: 'fiddly',
  title: 'Neighbouring buttons touch on phones',
  stations: ['bookings', 'cart'],
  widths: ['phone'],
  severity: 'medium',
  symptom: 'On a phone, two buttons sit flush against each other with no space between them: in My bookings Reschedule touches Cancel, in the cart the plus button touches Remove. A slightly wrong tap hits the other button.',
  grader: 'Counts when the report says these neighbouring buttons (Reschedule/Cancel in My bookings, plus/Remove in the cart) are too close together or easy to mis-tap on a phone. Does not count: the confirmation dialogs, button colours or wording.',
  client: {
    css: (ctx) => `${ctx.section} .booking .actions, ${ctx.section} .cart-item-controls { gap: 0; }`,
  },
};
