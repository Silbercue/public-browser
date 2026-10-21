export default {
  id: 'P11',
  category: 'function',
  title: 'Profile phone number is not stored',
  stations: ['profile'],
  widths: ['all'],
  severity: 'high',
  symptom: 'Saving the profile with a new phone number shows "Profile saved.", but the phone field falls back to its old value right away and stays that way after a reload or a later visit. The name is kept.',
  grader: 'Counts when the report says the phone number on the profile page is lost, reset or not saved after reloading or coming back, although saving looked successful. Does not count: phone format errors for invalid input, or remarks about the name field.',
  roles: {
    change: { feature: 'Members can now add a phone number on their profile page.' },
    capture: { flow: 'Log in as Maya, enter a phone number on the profile page, save, reload the page and check that the number is still there.' },
  },
  server: {
    setup(api) {
      const accountOf = (h) => (h.session && h.session.accountId ? h.sandbox.accounts.find((a) => a.id === h.session.accountId) : null);
      api.before('PUT /api/profile', (h) => {
        const a = accountOf(h);
        h.previousPhone = a ? a.phone : null;
      });
      api.after('PUT /api/profile', (h, body) => {
        const a = accountOf(h);
        if (a && typeof h.previousPhone === 'string' && body && !body.error) a.phone = h.previousPhone;
        return body;
      });
    },
  },
};
