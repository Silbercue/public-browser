export default {
  id: 'P13',
  category: 'function',
  title: 'Checkout books a class that is already booked',
  stations: ['checkout', 'bookings'],
  widths: ['all'],
  severity: 'high',
  symptom: 'A member can check out a class they have already booked; the booking is confirmed and My bookings lists the same class twice.',
  grader: 'Counts when the report says the same class can be booked twice, a duplicate booking is accepted, or My bookings shows the same class twice. Does not count: booking more than one spot in a single booking, or remarks about the confirmation page.',
  roles: {
    change: { feature: 'Checkout now stops members from booking a class they have already booked.' },
  },
  server: {
    setup(api) {
      api.before('POST /api/checkout', (h) => {
        h.validate = false;
      });
    },
  },
};
