# Bug modules — contract for bug authors

This folder holds the switchable bugs of the Stillwater yoga studio app. The public bugs live in
`bugs/public/`; the sealed secret part uses the very same module form and is loaded from
`<secret-dir>/bugs/` (see "Secret bugs"). Validation lives in `catalog/schema.mjs`, loading in
`catalog/load.mjs`. A module that breaks a rule below makes `loadCatalog()` throw with its file name.

> The client and server API names below are the contract the bug engine (`server/bug-engine.mjs`,
> `server/client-runtime.js`) implements. If they ever differ, the engine is right and this file
> gets fixed.

## Module form

One file per bug, named `<ID>-<short-name>.mjs` (public bugs: `P01-...` to `P17-...`). The module
has a single default export:

```js
export default {
  id: 'P01',                    // ^[A-Z]\d{2}$, unique across public and secret bugs
  category: 'fiddly',           // fiddly | next-step | layout | function | timing | background
  title: 'Short internal name',
  stations: ['cart', 'checkout'], // home | schedule | class-detail | cart | checkout | login |
                                  // register | profile | settings | bookings
  widths: ['phone'],            // phone | tablet | desktop, or exactly ['all']
  severity: 'medium',           // low | medium | high
  symptom: 'What a user sees.',
  grader: 'Which report counts as a hit (place plus symptom) and which does not.',
  roles: {                      // optional
    change: { feature: 'One sentence a developer would use to describe the change.' },
    capture: { flow: 'A flow a test can check in under a minute; fails while the bug is active.' },
    trap: { reached: 'what reached means', passed: 'what passed means' },
  },
  removesDecoys: ['D02'],       // optional for public bugs, REQUIRED for secret bugs (may be [])
  client: {                     // client and/or server
    css: (ctx) => `${ctx.section} button { padding: 0; }`,
    setup: (api, ctx) => { /* runs in the browser */ },
  },
  server: {
    setup: (api, ctx) => { /* runs in the app server */ },
  },
};
```

Do not set `source`; `loadCatalog` sets it to `'public'` or `'secret'`.

## Rules

- `id` matches `^[A-Z]\d{2}$`; `category`, every station, every width and `severity` come from the
  lists above; `title`, `symptom` and `grader` are not empty.
- A bug has at least a `client` or a `server` part. `client` has `css` and/or `setup`;
  `server` has `setup`.
- **A bug with a `server` part must have `widths: ['all']`** — the server does not know the
  viewport width.
- **A bug with `roles.change` or `roles.capture` must have `widths: ['all']`**, otherwise the result
  of the change check or the capture session would depend on the width the agent happens to test in.
- `roles.trap` is only allowed for category `timing`. A trap reports `reached` and `passed`
  (client: `api.beacon`, server: `api.event`).
- `removesDecoys` lists only decoy IDs (`^D\d{2}$`).
- `width: 'all'` stands alone; do not mix it with other widths.

### Functions must be self-contained

**No imports, no variables from outside the function.** `client.setup` is shipped to the browser as
source text, so anything it closes over is gone. The same discipline applies to `client.css` and
`server.setup` so every module can be moved between the public and the sealed secret part unchanged.
Use only the `api` and `ctx` arguments and browser/Node globals.

### Plausibility

Every bug looks like a real developer mistake (a tap target that is too small, a spacing that went
wrong, a forgotten explanation), never like sabotage. An attentive person notices it at its station
and width without developer tools in under a minute. Nothing invisible, no 1 px buttons.
`symptom` describes what a user sees; `grader` says which report counts as a hit (place plus symptom)
and which does not. Every bug has a measurable criterion its test can check (for example: tap target
below 24 px, spacing below 4 px, main button below the visible area, disabled button without visible
explanation, two buttons with the same computed style).

## Widths

| width   | px   | media query                                  |
|---------|------|----------------------------------------------|
| phone   | 390  | `(max-width: 600px)`                         |
| tablet  | 768  | `(min-width: 601px) and (max-width: 1100px)` |
| desktop | 1440 | `(min-width: 1101px)`                        |

Each run activates a bug at one station and one width drawn from its lists (`harness/seed.mjs`).

## Client side

`ctx` (client): `{ station, width, media, section }`, where `section` is the selector of the
station's root element, e.g. `'[data-section="cart"]'`, and `media` is the media query of the
activated width (empty for `all`).

- `client.css(ctx) → string` runs **on the server**. For a width other than `all` the engine wraps the
  result in `@media <media> { ... }`.
- `client.setup(api, ctx)` runs in the browser. `api` is bound to this bug:
  - `api.css(text)` — add CSS (raw: no media wrapper; use `api.matches()` or your own `@media`).
  - `api.onSection(name, fn(el))` — call `fn` once for every element with `data-section=name`, including
    elements created later (a re-rendered section counts as new). Not gated by the width; check `api.matches()` yourself.
  - `api.patch(selector, fn(el))` — call `fn` once per matching element, but only while `api.matches()` is true;
    re-scans after every DOM change and every resize, so new elements (React re-renders) and a live change
    into the activation width are both caught. Elements patched once are not patched again.
  - `api.fetch(fn(url, init) → { delayMs?, status?, body? } | void)` — intercept the app's fetch calls
    (only while `api.matches()` is true; the metrics beacon is never intercepted). `delayMs` delays the call;
    `status`/`body` (object or string) replace the answer with a synthetic JSON response.
  - `api.swallowFirstClick(selector)` — the first click per element (checked live, also only while `api.matches()`)
    is swallowed and reports `reached`, the second goes through and reports `passed`. A re-created element
    counts as a new element.
  - `api.beacon(event)` — only `'reached'` or `'passed'`; anything else throws.
  - `api.matches()` — whether the current width equals the activation width, checked live via
    `matchMedia` (check it on every event, not once at load).
  - `api.consoleError(msg)` — write a console error.

## Server side

`server.setup(api, ctx)` runs once in the app server; `ctx` is `{ station, seed }`.

- `api.before(key, fn(hctx))` — runs before the route logic. `key` is `'<METHOD> <path>'`, e.g.
  `'POST /api/cart/coupon'`. If the hook calls `hctx.respond(status, body)`, the route ends there.
- `api.after(key, fn(hctx, body) → body)` — runs on the response body.
- `api.event(name)` — report a trap event (`'reached'` / `'passed'`) right when `setup` runs. Inside a hook use
  `hctx.event(name)`; both write a `bug` line with the bug's ID to the event file.

Hook context `hctx`: `{ req, body, sandbox, session, validate, respond(status, body), event(name),
expireSession(), cart() }` (`event(name)` already knows the bug ID; writing `hctx.validate = false` reaches the route). `validate` is `true` by default; a hook may set it to `false` to skip the
range and double-booking checks. `cart()` returns the current cart of this client in the shape of
`GET /api/cart` (await it). Hooks may be `async`.

**An expired session is simulated only with `hctx.expireSession()`, never with a hand-made 401
response.** `expireSession()` drops the login of the current client on the server (the cookie and
the cart stay); from then on the server answers protected routes with `401 session_expired` and logs
the event itself.

## Beacons and the shipped script

The engine (`createBugEngine` in `server/bug-engine.mjs`) serves the browser part as `/assets/runtime.js`.
It contains the runtime (`server/client-runtime.js`, identified by `RUNTIME_MARKER`) and one start call
per active client bug; bug IDs, titles, symptoms and grader texts never appear in it. Each bug gets a key
`sha256(salt + id)[0..8]`; per session, bug and event a random 8-hex code is generated.

- Trap events leave the browser as `POST /api/metrics` with `{"b": key, "e": code}`, both 8 hex characters.
  The words `reached`/`passed` never travel. The server resolves them with `decodeBeacon(b, e)`.
- **Neutral beacons** of the same form with random values go out on every click and every `pushState`/`popstate`;
  `decodeBeacon` answers `null`, no event is written. A click that already sends a trap beacon sends no extra
  neutral one, so a request alone does not tell where a trap sits.
- Because of this, a bug must report trap events only through `api.beacon` / `api.event` / `hctx.event`,
  never through its own requests.

## Decoys

Decoys are correct app behaviour that looks odd but explains itself. Reports about a decoy count as
false alarms. Public decoys live in `catalog/decoys.json`, secret ones in `<secret-dir>/decoys.json`:

```json
[{ "id": "D01", "station": "cart", "title": "...", "grader": "Why a report about this is a false alarm.",
   "conflicts": ["P05"] }]
```

- `id` matches `^D\d{2}$`, `station` from the list, `title` and `grader` not empty.
- `conflicts` lists bug IDs (`^[A-Z]\d{2}$`) that can remove or hide the decoy's explanation at the
  same station. When such a bug is active, the run leaves the decoy out.

## Secret bugs

Secret bugs use the same form and rules. Because a public decoy cannot name secret IDs in its
`conflicts`, **every secret bug must carry `removesDecoys`** (an empty list is allowed): look at
every public decoy at the bug's stations and list those whose explanation the bug can remove. A
secret bug without the field makes `loadCatalog` throw. Secret bugs never serve as change or capture
target; they are drawn in addition to the public ones and never change which public bugs a seed
activates.
