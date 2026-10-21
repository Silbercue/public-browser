export default {
  id: 'P02',
  category: 'fiddly',
  title: 'Dialog close cross is tiny on phones',
  stations: ['class-detail', 'cart', 'settings'],
  widths: ['phone'],
  severity: 'low',
  symptom: 'On a phone, the close cross in the top corner of a dialog is a small 20 px target that is easy to miss.',
  grader: 'Counts when the report says the close (x) button of a dialog at this page is too small or hard to tap on a phone. Does not count: remarks about the dialog text, the other dialog buttons, or that a dialog appears at all.',
  client: {
    css: (ctx) => `body:has(${ctx.section}) .dialog .icon-button { width: 20px; height: 20px; font-size: 1rem; border-radius: 4px; }
body:has(${ctx.section}) .dialog-head h2 { margin-top: 0; }`,
  },
};
