// Test fixture: timing trap, the first click on a schedule button is swallowed.
export default {
  id: 'F03',
  category: 'timing',
  title: 'Schedule buttons need two clicks',
  stations: ['schedule'],
  widths: ['all'],
  severity: 'medium',
  symptom: 'The first click on a schedule button does nothing; the second one works.',
  grader: 'Counts when the report says a schedule button only reacts on the second click.',
  roles: { trap: { reached: 'first click swallowed', passed: 'second click went through' } },
  client: {
    setup(api, ctx) {
      api.swallowFirstClick(`${ctx.section} button`);
    },
  },
};
