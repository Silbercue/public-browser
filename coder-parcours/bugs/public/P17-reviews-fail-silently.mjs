export default {
  id: 'P17',
  category: 'background',
  title: 'Reviews request fails and the page hides it',
  stations: ['class-detail'],
  widths: ['all'],
  severity: 'medium',
  symptom: 'Every class page says "No reviews yet." In the background the reviews request fails with a server error (500), which shows up as an error in the browser console; the page gives no hint.',
  grader: 'Counts when the report names the failed reviews request, a 500 error or a console error on the class page, or says that no class has any reviews. Does not count: remarks about the review texts or the star display.',
  server: {
    setup(api) {
      api.before('GET /api/classes/:id/reviews', (h) => {
        h.respond(500, { error: 'server_error', message: 'Something went wrong on our side.' });
      });
    },
  },
};
