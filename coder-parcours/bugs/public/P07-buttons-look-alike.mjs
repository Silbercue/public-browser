export default {
  id: 'P07',
  category: 'next-step',
  title: 'Opposite actions share one button style',
  stations: ['settings', 'bookings'],
  widths: ['tablet', 'desktop'],
  severity: 'medium',
  symptom: 'Two buttons with very different effects look exactly the same (both filled green): Save changes and Reset to defaults in Settings, Reschedule and Cancel in My bookings. Nothing shows which one is the safe or the main choice.',
  grader: 'Counts when the report says Save changes and Reset to defaults (Settings), or Reschedule and Cancel (My bookings), look identical or that the destructive or secondary action is not set apart. Does not count: remarks about the confirmation dialogs or the switch controls.',
  client: {
    css: (ctx) => `${ctx.section} .actions .button.button { background: var(--primary); border-color: var(--primary); color: #ffffff; }`,
  },
};
