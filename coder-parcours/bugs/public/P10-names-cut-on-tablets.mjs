export default {
  id: 'P10',
  category: 'layout',
  title: 'Class names cut off in a four-column grid on tablets',
  stations: ['schedule', 'home'],
  widths: ['tablet'],
  severity: 'low',
  symptom: 'On a tablet, the class cards sit in four narrow columns and the class names end in "…", so names like "Morning Vinyasa Flow" cannot be read in full.',
  grader: 'Counts when the report says class names on the class cards (schedule or home page) are cut off, truncated with an ellipsis or unreadable on a tablet, or that the cards are squeezed into too narrow columns. Does not count: remarks about the Ended or Full labels, the card contents otherwise, or the filters.',
  client: {
    css: (ctx) => `${ctx.section} .card-list { grid-template-columns: repeat(4, minmax(0, 1fr)); }
${ctx.section} .card-list h2, ${ctx.section} .card-list h3 { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`,
  },
};
