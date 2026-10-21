export default {
  id: 'P09',
  category: 'layout',
  title: 'Fixed widths make the page scroll sideways on phones',
  stations: ['schedule', 'cart'],
  widths: ['phone'],
  severity: 'medium',
  symptom: 'On a phone, the page is wider than the screen and can be dragged sideways: in the schedule the row of day tabs runs off the right edge, in the cart the coupon field and its Apply button stick out of the summary box.',
  grader: 'Counts when the report says the page scrolls or overflows sideways on a phone, or that the day tabs (schedule) or the coupon field and Apply button (cart) are cut off at the right edge or stick out. Does not count: remarks about the size of the tabs or buttons alone, the coupon messages, or the totals.',
  client: {
    css: (ctx) => (ctx.station === 'cart'
      ? `${ctx.section} .coupon-row input { flex: none; width: 320px; }`
      : `${ctx.section} .day-tabs { grid-template-columns: repeat(7, 64px); max-width: none; }`),
  },
};
