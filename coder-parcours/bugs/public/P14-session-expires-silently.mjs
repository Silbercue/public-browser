export default {
  id: 'P14',
  category: 'timing',
  title: 'Session expires and the app hides it',
  stations: ['bookings'],
  widths: ['all'],
  severity: 'high',
  symptom: 'After some browsing while logged in, My bookings suddenly shows "No upcoming bookings." although bookings exist; the header still says Log out and no message mentions an expired session. After a reload the visitor is sent to the login page without any explanation.',
  grader: 'Counts when the report says the bookings disappeared or the list turned empty while logged in, the user was logged out without notice, or an expired session was not explained. Does not count: a report that only describes the login page itself, or remarks about the empty state text when the account really has no bookings.',
  roles: {
    trap: { reached: 'the session was dropped on the server while the member used My bookings', passed: 'the member logged in again afterwards' },
  },
  server: {
    setup(api) {
      let authed = 0;
      let expired = false;
      let passed = false;
      const keys = ['GET /api/me', 'GET /api/cart', 'GET /api/profile', 'PUT /api/profile', 'GET /api/settings', 'PUT /api/settings',
        'GET /api/bookings', 'POST /api/bookings/:id/cancel', 'POST /api/bookings/:id/reschedule', 'POST /api/checkout',
        'POST /api/cart/items', 'PATCH /api/cart/items/:id', 'DELETE /api/cart/items/:id', 'POST /api/cart/coupon'];
      for (const key of keys) {
        api.before(key, (h) => {
          if (expired || !h.session || !h.session.accountId) return;
          authed++;
          if (key === 'GET /api/bookings' && authed >= 5) {
            expired = true;
            h.event('reached');
            h.expireSession();
          }
        });
      }
      api.after('POST /api/auth/login', (h, body) => {
        if (expired && !passed && body && body.user) {
          passed = true;
          h.event('passed');
        }
        return body;
      });
    },
  },
  client: {
    // The words the wrapper compares with and answers with are kept as shifted character codes, so neither
    // fetch.toString() nor the served script shows an error text in the clear.
    setup() {
      const send = window.fetch;
      const w = (codes) => String.fromCharCode.apply(null, codes.map((n) => n - 3));
      const a = w([118, 104, 118, 118, 108, 114, 113, 98, 104, 123, 115, 108, 117, 104, 103]);
      const b = w([111, 114, 106, 108, 113, 98, 117, 104, 116, 120, 108, 117, 104, 103]);
      const c = w([83, 111, 104, 100, 118, 104, 35, 111, 114, 106, 35, 108, 113, 35, 119, 114, 35, 102, 114, 113, 119, 108, 113, 120, 104, 49]);
      const make = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      window.fetch = function (input, init) {
        return send(input, init).then((res) => {
          if (res.status !== 401) return res;
          return res.clone().json().then((data) => {
            if (!data || data.error !== a) return res;
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            const method = String((init && init.method) || 'GET').toUpperCase();
            if (url.pathname === '/api/me') return make(200, { user: null });
            if (url.pathname === '/api/bookings' && method === 'GET') return make(200, { bookings: [] });
            return make(401, { error: b, message: c });
          }, () => res);
        });
      };
    },
  },
};
