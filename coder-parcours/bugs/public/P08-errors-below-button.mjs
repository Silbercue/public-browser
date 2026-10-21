export default {
  id: 'P08',
  category: 'next-step',
  title: 'Form errors collected below the submit button on phones',
  stations: ['register', 'login'],
  widths: ['phone'],
  severity: 'medium',
  symptom: 'On a phone, form error messages do not appear at the field they belong to but are gathered below the submit button, so it is unclear which field needs fixing.',
  grader: 'Counts when the report says an error message on the register or login form appears far from its field (below the button) on a phone. Does not count: the wording of the errors or that empty fields are rejected.',
  client: {
    css: (ctx) => `${ctx.section} .form { display: flex; flex-direction: column; }
${ctx.section} .form .field { display: contents; }
${ctx.section} .form .field label { margin: 16px 0 6px; }
${ctx.section} .form > .field:first-child label { margin-top: 0; }
${ctx.section} .form .actions { order: 1; }
${ctx.section} .form .field-error { order: 2; margin: 12px 0 0; }`,
  },
};
