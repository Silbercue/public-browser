export default {
  id: 'P03',
  category: 'fiddly',
  title: 'Day tabs squeezed on tablets',
  stations: ['schedule'],
  widths: ['tablet'],
  severity: 'medium',
  symptom: 'On a tablet, the Mon to Sun day tabs of the schedule are squeezed into a thin strip (about 22 px high) with almost no space between them, so it is easy to hit the wrong day.',
  grader: 'Counts when the report says the day tabs of the schedule are too small, too thin or too close together on a tablet. Does not count: which day is selected at start, the filter chips, or the class cards.',
  client: {
    css: (ctx) => `${ctx.section} .day-tabs { gap: 2px; max-width: 420px; }
${ctx.section} .day-tab { min-height: 0; height: 22px; font-size: 0.8rem; line-height: 1; border-width: 1px; border-radius: 4px; }`,
  },
};
