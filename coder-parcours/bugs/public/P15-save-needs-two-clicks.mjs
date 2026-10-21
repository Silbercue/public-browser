export default {
  id: 'P15',
  category: 'timing',
  title: 'Save button reacts only to the second click',
  stations: ['settings', 'profile'],
  widths: ['all'],
  severity: 'medium',
  symptom: 'The first click on Save changes (settings) or Save profile (profile) does nothing at all: no message, nothing saved. A second click saves as expected.',
  grader: 'Counts when the report says the save button in settings or on the profile page needs two clicks, ignores the first click, or seems to do nothing at first. Does not count: remarks about the saved values themselves, the reset dialog, or the switches.',
  roles: {
    trap: { reached: 'the first click on the save button was swallowed', passed: 'a second click went through' },
  },
  client: {
    setup(api, ctx) {
      api.swallowFirstClick(ctx.station === 'profile'
        ? `${ctx.section} button[type="submit"]`
        : `${ctx.section} .actions .button.primary`);
    },
  },
};
