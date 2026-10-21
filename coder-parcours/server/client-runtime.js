// Browser runtime of the bug engine. Shipped as /assets/runtime.js, followed by one start call per active bug.
// Plain ES5-style script, no imports: the server reads this file as text and appends the per-run part.
// The words for the two trap events are assembled from pieces so a text search over the shipped file finds nothing.
function __swBoot(cfg) {
  var EVENTS = ['reach', 'pass'].map(function (s) { return s + 'ed'; });
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var bugs = {};
  var patchers = [];
  var sectionWatchers = [];
  var fetchHooks = [];
  var swallowers = [];
  var clickBeaconSent = false;

  function hex8() {
    var a = new Uint32Array(1);
    window.crypto.getRandomValues(a);
    return ('00000000' + a[0].toString(16)).slice(-8);
  }

  function post(b, e) {
    var body = JSON.stringify({ b: b, e: e });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(cfg.url, body)) return;
    } catch (err) { /* fall through */ }
    if (origFetch) origFetch(cfg.url, { method: 'POST', body: body, keepalive: true }).catch(function () {});
  }

  function neutral() { post(hex8(), hex8()); }

  function matchesFor(ctx) {
    if (!ctx.media) return true;
    return window.matchMedia(ctx.media).matches;
  }

  function scan() {
    var i;
    for (i = 0; i < patchers.length; i++) {
      var p = patchers[i];
      if (!p.bug.matches()) continue;
      var els = document.querySelectorAll(p.selector);
      for (var j = 0; j < els.length; j++) {
        if (p.done.has(els[j])) continue;
        p.done.add(els[j]);
        p.fn(els[j]);
      }
    }
    for (i = 0; i < sectionWatchers.length; i++) {
      var w = sectionWatchers[i];
      var secs = document.querySelectorAll('[data-section="' + w.name + '"]');
      for (var k = 0; k < secs.length; k++) {
        if (w.done.has(secs[k])) continue;
        w.done.add(secs[k]);
        w.fn(secs[k]);
      }
    }
  }

  var scanning = false;
  var observer = new MutationObserver(function () {
    if (scanning) return;
    scanning = true;
    try { scan(); } finally { scanning = false; }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('resize', scan);
  document.addEventListener('DOMContentLoaded', scan);

  // Neutral beacons: one per click (unless a trap already sent its own for this click) and one per page change.
  window.addEventListener('click', function () {
    clickBeaconSent = false;
    setTimeout(function () {
      if (!clickBeaconSent) neutral();
      clickBeaconSent = false;
    }, 0);
  }, true);
  window.addEventListener('popstate', neutral);
  var origPush = history.pushState;
  history.pushState = function () {
    var out = origPush.apply(this, arguments);
    neutral();
    return out;
  };

  window.addEventListener('click', function (ev) {
    /** @type {any} */
    var target = ev.target;
    if (!target || !target.closest) return;
    for (var i = 0; i < swallowers.length; i++) {
      var s = swallowers[i];
      if (!s.bug.matches()) continue;
      var el = target.closest(s.selector);
      if (!el) continue;
      var n = s.seen.get(el) || 0;
      s.seen.set(el, n + 1);
      if (n === 0) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        s.bug.beacon(EVENTS[0]);
        return;
      }
      if (n === 1) s.bug.beacon(EVENTS[1]);
      return;
    }
  }, true);

  if (origFetch) {
    window.fetch = function (input, init) {
      /** @type {any} */
      var any = input;
      var url = typeof any === 'string' ? any : (any && any.url) || String(any);
      if (url.indexOf(cfg.url) >= 0) return origFetch(input, init);
      var delay = 0;
      var fake = null;
      for (var i = 0; i < fetchHooks.length; i++) {
        var h = fetchHooks[i];
        if (!h.bug.matches()) continue;
        var r = h.fn(url, init);
        if (!r) continue;
        if (r.delayMs) delay = Math.max(delay, r.delayMs);
        if (r.status !== undefined || r.body !== undefined) fake = r;
      }
      var run = function () {
        if (!fake) return origFetch(input, init);
        var text = typeof fake.body === 'string' ? fake.body : JSON.stringify(fake.body === undefined ? {} : fake.body);
        return Promise.resolve(new Response(text, { status: fake.status || 200, headers: { 'Content-Type': 'application/json' } }));
      };
      return delay > 0 ? new Promise(function (res) { setTimeout(res, delay); }).then(run) : run();
    };
  }

  function forBug(key) {
    var bug = bugs[key];
    if (!bug) throw new Error('runtime: unknown bug key');
    return bug.api;
  }

  function run(key, ctx, setup) {
    var bug = { key: key, ctx: ctx };
    bug.matches = function () { return matchesFor(ctx); };
    bug.beacon = function (event) {
      var idx = EVENTS.indexOf(event);
      if (idx < 0) throw new Error('beacon: unknown event');
      var codes = cfg.codes[key];
      if (!codes) return;
      clickBeaconSent = true;
      post(key, codes[idx]);
    };
    bug.api = {
      css: function (text) { addCss(text); },
      onSection: function (name, fn) { sectionWatchers.push({ name: name, fn: fn, done: new WeakSet() }); scan(); },
      patch: function (selector, fn) { patchers.push({ bug: bug, selector: selector, fn: fn, done: new WeakSet() }); scan(); },
      fetch: function (fn) { fetchHooks.push({ bug: bug, fn: fn }); },
      swallowFirstClick: function (selector) { swallowers.push({ bug: bug, selector: selector, seen: new WeakMap() }); },
      beacon: bug.beacon,
      matches: bug.matches,
      consoleError: function (msg) { console.error(msg); },
    };
    bugs[key] = bug;
    setup(bug.api, ctx);
  }

  function addCss(text) {
    var style = document.createElement('style');
    style.textContent = text;
    (document.head || document.documentElement).appendChild(style);
  }

  /** @type {any} */ (window).__sw = { run: run, css: addCss, forBug: forBug };
}
