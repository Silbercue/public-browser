export default {
  id: 'P05',
  category: 'next-step',
  title: 'Disabled main button loses its explanation on desktop',
  stations: ['checkout', 'class-detail'],
  widths: ['desktop'],
  severity: 'high',
  symptom: 'On a desktop screen, the main button is greyed out without any text saying why: Place booking at checkout before the terms are ticked, Book this class on a full or ended class.',
  grader: 'Counts when the report says the disabled Place booking (checkout) or Book this class (class page) button gives no visible reason why it cannot be used, on desktop. Does not count: a report that only says the button is disabled while the reason is shown, or that full classes cannot be booked.',
  client: {
    css: (ctx) => `${ctx.section} .book-note { display: none; }`,
  },
};
