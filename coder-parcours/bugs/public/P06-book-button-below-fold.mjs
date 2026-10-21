export default {
  id: 'P06',
  category: 'next-step',
  title: 'Book button pushed below the reviews on phones',
  stations: ['class-detail'],
  widths: ['phone'],
  severity: 'high',
  symptom: 'On a phone, the class page shows description, facts and reviews, but no way to book; the Book this class button only appears at the very bottom below all reviews, with nothing hinting at it.',
  grader: 'Counts when the report says the Book this class button is hard to find, missing from the first screen or only at the end of the page below the reviews on a phone. Does not count: remarks about the reviews themselves or the booking dialog.',
  client: {
    css: (ctx) => `${ctx.section} { display: flex; flex-direction: column; }
${ctx.section} .book-box { order: 1; margin: 28px 0 0; }`,
  },
};
