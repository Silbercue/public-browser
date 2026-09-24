# Changelog

## [Unreleased]

### Breaking
- **Update the server and the Python client together.** The Script API now needs its key (see Security), and `publicbrowser` 1.0.0 does not send one: against the new server it reports `ConnectionError: Public Browser server not reachable` although the server runs, and with `auto_start=True` it starts a second server that cannot get the port and ends with `Server did not become ready`. MCP configs that run `npx -y public-browser@latest -- --script` pick up the new server on their next start, so update `publicbrowser` at the same time (S1).
- **A real profile runs without a debugging port.** With `--profile` Chrome is driven over `--remote-debugging-pipe`; nothing listens on a TCP port. `--attach` and the Python escape hatch `page.cdp` do not work with a real profile (`/session/create` returns `cdp_ws_url: null`, `page.cdp` raises `RuntimeError`), `session.cdpPort` of the Node library is `undefined`, and a second Public Browser on the same profile stops with an error naming the PID of the Chrome that holds it. Should Chrome refuse the pipe, it gets a random debugging port (never 9222) and a warning (S2).
- **CSS selectors are strict.** A selector that matches more than one element no longer acts on the first match: `click`, `type`, `fill_form`, `press_key`, `scroll`, `drag`, `file_upload` and `observe` do nothing and return up to five candidates (ref, role, name). Invalid CSS such as Playwright's `:has-text()` names a ref or valid CSS as the way out. Flows that relied on the first match need a ref or a narrower selector (S3).
- **Refs are kept per tab and never reused.** Ref numbers keep counting across navigation and reload instead of starting again at `e1`, so a ref from a page you left reports `stale ref` instead of hitting whatever node now has that number. `switch_tab` switches the ref table instead of discarding it — refs of an unchanged tab stay valid when you come back, a ref of another tab names its tab, and a node a re-render removed reports `stale ref` instead of typing into nothing. Stored plans with hard-coded refs need fresh refs from `view_page` (S3).
- **`run_plan` has no `parallel` and no `use_operator` any more.** Both were in the schema but always returned an error; they are gone from schema and description (S9).
- **`run_plan` `saveAs` stores the raw result.** Hint paragraphs appended to a result (`Tip:`, `Note:`, `Warning:`, `Notice:`) and blocks the server adds next to it (click diff, dialog, download and relaunch notices) no longer end up in the variable (E5).
- **Python API.** `page.click()` reads `"text=Sign in"` as visible text and `"e12"` / `"ref:12"` as a ref; any other string is a CSS selector (plain text and `ref:` were sent as CSS before and did not work). `page.wait_for("text=…")` waits for page text, a ref waits for the element to be visible. `page.download()` returns the download report (JSON with filename, path, size and url, or a notice) instead of a directory. `page.evaluate()` no longer returns appended hints as part of the value. `Chrome.connect()` takes `token=`, raises `ConnectionError` when another program answers on the port and `PermissionError` when a Public Browser server rejects the key (S10, S1).

### Security
- The Script API answers only requests that carry its key (`Authorization: Bearer <key>`, else `401`). A server started with `--script` generates the key and writes it to `~/.public-browser/script-api-<port>.token` (mode 0600); `Chrome.connect()` reads it from there, hands a fresh key to a server it starts itself, or takes `PUBLIC_BROWSER_SCRIPT_TOKEN` / `token=`. Requests with an `Origin` header or a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` get `403`, which blocks web pages and DNS rebinding. `GET /health` identifies the server (`{server: "public-browser", version}`), so a client never takes another program on the port for it (S1).
- A real profile no longer opens a debugging port that every local program could use to take over the logged-in browser (S2, see Breaking).

### Fixed
- A click that opens a new tab names the tab's ID and title in its answer, also in the one-line step summary of `run_plan`, so `switch_tab` can use it (S4).
- `switch_tab` works as a `run_plan` step without `action` instead of failing with `Cannot read properties of undefined (reading 'isError')`; a step whose handler returns nothing (`wait_for` without `condition`, `handle_dialog` without `action`) is reported as an error (S5).
- `click` by text no longer hits a DOM node the page has already replaced: when the first match is detached and same-name matches exist (same match tier, interactive flag and name), it checks them live, newest first (at most 5 probes), and clicks the one that is connected, visible and in the same session and document; if none or more than one qualifies it reports the stale-element error instead of guessing (FR-050).
- A click on a node the page re-rendered away now reports `Element eN was replaced by a page re-render (node detached from document). Call view_page for fresh refs and retry.` instead of the raw CDP error, and can no longer fall through to a mouse click at (0,0) (FR-051).
- After a click with no visible change the hint no longer suggests `wait_for(condition: "network_idle")` — Chrome reports network idle once per page load, so that wait always timed out on a loaded page; the hint now names `text`/`element`, and the `network_idle` timeout explains this (FR-052).
- A click inside a cross-origin iframe that sits in another cross-origin iframe now reaches its target: nested frames are auto-attached through their parent frame, and `view_page` no longer lists iframes of other tabs, whose refs sent clicks into those tabs while reporting success (S8).
- `drag` scrolls the source into view before it reads coordinates — elements below the fold were dragged at off-screen coordinates and nothing happened (benchmark T3.3). HTML5 drag-and-drop (draggable lists, SortableJS, React DnD) runs through `Input.setInterceptDrags` and `Input.dispatchDragEvent`. When no reaction is detected — no drop, no DOM change around source and target, no input event — `drag` answers `Drag not confirmed: …` instead of `Dragged …` (the finding opens the line, so it survives the one-line step summary of `run_plan`), without an error: only the source's document is observed, for about 250 ms after release, so iframes, shadow DOM and later updates are not seen and the answer asks to verify with `view_page` rather than repeat the drag. Scrolling, a mere text selection and changes elsewhere on the page do not count as a reaction; PB's own session overlay is ignored, other `aria-hidden` elements are not. A drag on a canvas says its result can only be checked with `capture_image` (S6).
- `press_key` sends every character once: the extra `char` event made Chrome insert each character twice (`HHeelllloo`) and each Enter as two line breaks, in inputs, textareas and editors (S7).
- On macOS a `Control+<letter>` that changes nothing in the focused editor answers with a hint to use Meta instead of Control; nothing is remapped silently. `Meta+A`, `Meta+Z` and `Meta+Shift+Z` carry the editing commands (`selectAll`, `undo`, `redo`) Chrome needs on macOS, where these shortcuts did nothing (S7).
- `type` accepts contenteditable editors by ref (`generic (editable)` in `view_page`, also their text children) instead of rejecting role `generic`. Text goes to the end of the editor — before, it landed in front of the existing text — or to the caret when the caret already sits there, so a `Meta+B` before `type` still applies; `clear: true` empties the editor (S7).

### Changed
- The diff shows only what changed since the last observation (no stale `REMOVED` lines, no iframe noise), at most 15 lines with live regions first; deferred click diffs appear only on page actions (H1).
- Compact `view_page`: a StaticText that repeats its parent's name is dropped, StaticText and LabelText carry no refs, multi-line container names show their first line with `filter: "all"`, and the TRUNCATED line is shorter (H2).
- Each tip appears once per session; state notes (counts, truncation) stay in every response (H3).
- No `[~N tokens | N refs]` footer and no `Server:` line in `virtual_desk`, the Cortex line appears only at confidence ≥ 0.9, and unambiguous `evaluate` strings come back raw in the MCP tool (H5).

## [2.10.5] - 2026-09-04

### Changed
- Package description and README headline now name the tool-definition shrink: 34% smaller since v2.10.4 (7,607 → 4,990 tokens, reproduce with `node scripts/token-count.mjs`). The figure is a comparison against this project's own earlier releases, not against other servers — Playwright MCP 0.0.80 ships smaller tool definitions (4,626 tokens) and the wording no longer implies otherwise. Metadata only, no behaviour change.

## [2.10.4] - 2026-09-04

### Changed
- Tool definitions cost 4,990 tokens on the wire instead of 7,607 (NFR4 budget < 5,000, enforced by `src/tool-budget.test.ts`): SDK metadata (`$schema`, `execution`, `additionalProperties: false`) is stripped from `tools/list`, shared rules moved into the server instructions, every tool and parameter description was tightened. No tool, parameter or rule was removed — only illustrations and filler; accepted by two blind benchmark runs (30/30, 80 and 68 calls).
- `run_plan` now exposes `vars` and `errorStrategy` in its input schema (they were implemented but not listed).
- Blind-run harness: `--local` runs the benchmark against the local build.
- Blind-run harness: `--headless` runs Public Browser without a visible Chrome window (`SILBERCUE_CHROME_HEADLESS=1`), recorded as `harness.headless` in the run JSON.

### Fixed
- Three `drag` parameter descriptions were German; now English.

## [2.10.0 – 2.10.3]
See the GitHub releases for these versions (release notes were generated from commits).

## [2.9.1] - 2026-08-22

### Fixed

- **The session overlay no longer shows up in `view_page`.** The status bar
  is a real DOM node, so `view_page({ filter: "all" })` listed it as page
  content — `"Public Browser"` and the cortex page-type flash as static text,
  three of fourteen nodes on a small page. The overlay host and the click
  indicator now carry `aria-hidden="true"`, which keeps them out of the
  accessibility tree that `view_page` reads. Reported by an integrator.

### Changed

- README: the `view_page` row of the tool table spells out both `filter`
  values and what each returns.

## [2.9.0] - 2026-08-22

### Fixed

- **The page overlay no longer throws on every page load.** The overlay script
  is registered via `Page.addScriptToEvaluateOnNewDocument`, which runs before
  the parser has produced `<html>` — `document.documentElement` is still `null`
  there, and `appendChild` on it threw `TypeError: Cannot read properties of
  null` into the page console on every navigation, in every configuration.
  `tab_status` then reported that error back as `Errors (1)`, as if the page
  had produced it. The host now waits for `DOMContentLoaded` when the root does
  not exist yet, and a marker keeps the second evaluation from creating a
  second one.
- **`wait_for` reports `cdp_error` when the session is gone, not `timeout`.**
  The poll loops behind `element`, `text`, `url` and `js` swallowed every CDP
  failure and kept polling until the deadline, so a dead transport or a closed
  session surfaced as "the condition never held". A script without an LLM needs
  the difference: a condition that never became true and a browser that is not
  there any more call for different recoveries. Failures that only mean "could
  not check right now" — an execution context torn down by navigation, a node
  that vanished — are still retried. Verified live: a Chrome killed mid-wait
  now returns `cdp_error` after ~1 s instead of `timeout` after 15.
- **`tab_status` and `switch_tab` show the page title after a navigation.** The
  tab-state cache is prefilled on `Page.frameNavigated`, which fires before
  `<title>` is parsed, so it held an empty title — and served it as a cache
  hit for the next 30 s. The cache now reads `document.title` (the navigation
  entry's title lags behind it), refreshes an empty one on
  `Page.domContentEventFired`, and never serves an empty title from cache.
- **`transport: "pipe"` with an unknown profile name reports the pipe conflict**
  rather than "profile not found". The transport check now runs before the
  profile is resolved, so the caller hears about the contradiction that
  renaming the profile would not fix.
- **`close()` no longer takes 30 seconds for an attached session.** Shutdown
  removed the page overlay *after* closing the tab it lives in, so it addressed
  a target that was already gone — Chrome never answers, and the CDP client sat
  out its full 30 s timeout. Reproduced at 30006 ms with an attached,
  `eager: true` session closed before its first tool call; now 3 ms. The
  overlay is removed first, and every CDP command on the cleanup path is
  bounded at 2 s rather than 30.
- **An attached session no longer terminates a Chrome it did not start.**
  Closing the last remaining page target takes the whole browser down with it.
  Shutdown now checks for another page target first and keeps its own tab when
  there is none — an `about:blank` left behind beats killing somebody else's
  browser. The kept tab is navigated to `about:blank` first, through a session
  attached to that exact target: left as it was, it would show whatever the
  automation last opened, which after a login is an authenticated page in a
  browser nobody controls any more.
- **`settle` is reachable over MCP.** The `download` tool documented it as a
  per-call parameter, but the registered schema only exposed `action` and
  `timeout`, so no MCP client could set it. Reported by an integrator.

### Added

- **`transport: "pipe"` — a Chrome with no listening CDP port.** Public Browser
  already spoke CDP over the stdio pipe for temp profiles, but always passed
  `--remote-debugging-port` as well, leaving an endpoint every local process
  could drive. `createSession({ transport: "pipe" })` omits the flag entirely:
  nothing listens, and the pipe belongs to Public Browser alone. The port paid
  for reconnect-after-crash, `attach`, the Script API and named profiles, so
  none of those are available in pipe mode; `attach` and `profile` are rejected
  at `createSession()` instead of failing later. `session.transport` reports the
  mode in use.
- **`wait_for` understands page text and the URL.** `condition: "text"` matches
  a substring of `document.body.innerText`, `condition: "url"` a substring of
  the address — the two most common waits, which previously forced callers into
  `condition: "js"` and therefore into writing code. Failures show what the page
  actually holds.
- **`wait_for({ assert: true })` checks once instead of waiting**, and reports
  `_meta.code = "assertion_failed"`. Deliberately a mode rather than a new
  `assert` tool: every additional tool widens the tool list that each agent
  pays for in context on every session.
- **Typed failure codes on `wait_for`** — `_meta.code` is one of `timeout`,
  `assertion_failed`, `invalid_params`, `cdp_error`, so a script can branch on
  the outcome instead of parsing prose.

### Changed

- **`session.cdpPort` is `undefined` with `transport: "pipe"`.** It reported
  the resolved default — `9222`, the port of whatever Chrome the user has
  open — for a session whose whole point is that nothing listens. The type is
  now `number | undefined` on `SessionCore`, `PublicBrowserSession` and
  `WorkerReadyInfo`; callers on `"port"` transport see no change.
- Documented attach timings corrected against a Chrome started outside Public
  Browser: ~0.7 s to the first tool response and ~1.8 s to a navigated and read
  page, rather than the ~0.2 s / ~1.25 s measured against a Public Browser-owned
  Chrome with a warm renderer. Most of it is Chrome starting a renderer for the
  tab an attached session opens for itself.
- The README now states what the browser-wide download directory actually
  costs: with two sessions on one Chrome the losing session keeps reporting
  paths under its own `downloadDir` while the file lands in the other — a
  silently wrong `path`, not just a shared folder.


## [2.8.0] - 2026-08-21

### Multi-instance operation without a per-instance process

- **`createSession()` — Public Browser as a Node library.** Run one or more
  fully isolated sessions inside a host process instead of spawning
  `npx public-browser` per Chrome (~1 s vs. 4–6 s per instance):

  ```ts
  import { createSession } from "public-browser";
  const s = await createSession({ cdpUrl: "http://127.0.0.1:9333", userDataDir: "/var/agents/a1" });
  await s.callTool("navigate", { url: "https://example.com" });
  ```

  `callTool(name, params)` takes the same tool names and parameters as the MCP
  tools and routes through the identical handlers. Each session runs in its own
  worker thread by default, so element refs, selector cache, viewport state and
  the cortex matcher are per-session rather than per-process. `isolation:
  "inline"` skips the thread for single-session hosts.
- **`isolation: "process"`** runs each session in its own OS process — separate
  heap, separate file descriptors, separate crash domain — for integrators whose
  trust boundary has to be a process boundary. A worker thread shares both with
  the host and was never one. `session.pid` reports the child's pid; closing the
  session (or losing the host) shuts Chrome down with it.
- **Public Browser environment variables no longer leak into a session.** Every
  `SILBERCUE_*` / `PUBLIC_BROWSER_*` configuration variable has an explicit
  `createSession()` option, so a host-level value — typically meant for the
  host's own Chrome — is stripped rather than silently overriding the session.
  Previously only the port and profile variables were stripped, and a host
  `SILBERCUE_CHROME_HOST` redirected a session created with an explicit
  `cdpPort` to a foreign machine. Use `env` to set one back deliberately.
- **A session no longer inherits the host environment by default.** It starts
  from `ESSENTIAL_ENV_VARS` — `PATH`, `HOME`, the temp dir, `CHROME_PATH`,
  locale/timezone, the Linux display variables, the Windows process basics — and
  nothing else. An orchestrator holding cloud credentials, API keys and tokens
  should not hand them to a browser session just because the two share a process
  tree. Widen it with `inheritEnv`: an array adds the names you list
  (`["HTTPS_PROXY", "NO_PROXY"]` is the common one), `true` restores full
  inheritance. Proxy variables are deliberately not essential — a proxy URL can
  carry credentials, so it is allowlisted on purpose rather than inherited by
  accident.
- **Per-instance cortex store** via `cortexDir` / `PUBLIC_BROWSER_CORTEX_DIR`,
  and a per-instance environment via the `env` option.
- **New CLI flags** for running several instances side by side: `--port`
  (alias `--cdp-port`), `--host`, `--script-port`, `--headless`,
  `--user-data-dir`, `--download-dir`, `--download-hash`, `--download-naming`,
  `--stealth` / `--no-stealth`.
  `--attach`, `SILBERCUE_CHROME_PORT` and `SILBERCUE_SCRIPT_PORT` are now
  documented as part of the stable public contract, with
  `PUBLIC_BROWSER_CHROME_PORT` / `PUBLIC_BROWSER_SCRIPT_PORT` /
  `PUBLIC_BROWSER_CHROME_HOST` as aliases.
- **`--user-data-dir <path>`** points an instance at a raw Chrome user-data
  directory (created if missing) instead of a named profile — the throwaway
  per-agent Chrome case, previously reachable only through the library.
- An invalid port or download-naming mode in a flag or environment variable now
  fails with a named error instead of silently falling back to a default.
- `--help` now lists the `PUBLIC_BROWSER_*` aliases next to their canonical
  `SILBERCUE_*` names; they were documented only in the README.

### Opt-out of the `navigator.webdriver` masking

- **`--no-stealth` / `SILBERCUE_STEALTH=0` / `createSession({ stealth: false })`.**
  With stealth off, no masking script is injected on attach, after navigation
  or on tab switch, and Chrome launches without
  `--disable-blink-features=AutomationControlled`. `navigator.webdriver` stays
  `true` with its native getter (`[native code]`) — permanently, with no
  post-correction needed by the client. For integrations that must be
  transparently identifiable as automation.

### Configurable download directory

- **`--download-dir` / `PUBLIC_BROWSER_DOWNLOAD_DIR` / `downloadDir`** — point
  downloads at a quarantine directory of your own. It is created if missing and
  never deleted by Public Browser; only auto-created temp directories are
  cleaned up on shutdown.
- **`--download-hash` / `PUBLIC_BROWSER_DOWNLOAD_HASH` / `downloadHash`** adds a
  `sha256` to every completed download, reported by the `download` tool
  alongside path and size.
- **`--download-naming suggested` / `PUBLIC_BROWSER_DOWNLOAD_NAMING` /
  `downloadNaming`** renames each finished download from Chrome's internal GUID
  to the server-supplied filename. The name is sanitised first (basename only,
  no control characters, never hidden, length-capped) and a collision gets a
  `-1`, `-2`, ... suffix instead of overwriting. The reported `filename` is the
  name the file actually has, so `join(downloadDir, filename)` always equals
  `path`. A failed rename keeps the GUID path and the raw server name, so a
  download is never lost to a naming problem. Default stays `guid`.

### Fixed

- **`download` no longer reports "no downloads" for a file that is on its way.**
  Chrome fires `downloadWillBegin` a few milliseconds after the click that
  triggers it, so the first `download` call after a click could miss it and the
  caller had to invent a retry delay. `action: "status"` now waits up to 250 ms
  for a download to start — measured at ~200 ms for a click-triggered download,
  and short enough not to become the floor of a polling loop. Tune it per call
  with the new `settle` parameter (`0` for an instant check, higher for a slow
  server). `action: "list"` returns the session history immediately and never
  waits, for either a start or a completion — that is the wait-free path for
  polling.
- **`close()` now returns only once Chrome has actually exited.** It used to
  send SIGTERM and resolve immediately, so a caller reusing the port or the
  user-data-dir raced a process that had merely been asked to quit. The wait is
  bounded: SIGKILL after 5 s, give up after another 2 s, and the temp
  user-data-dir is removed only afterwards — Chrome rewrites its profile on
  exit and used to recreate what had just been deleted.


## [2.0.0] - 2026-04-26

### Everything is Free

All features that were previously Pro-only are now available to everyone at no cost:

- **23 Tools** unlocked (was: 10 Free, 13 Pro-gated)
- **Unlimited `run_plan`** steps (was: Free limited to 3 steps)
- **Parallel execution** in `run_plan` (was: Pro-only)
- **`switch_tab`**, **`virtual_desk`** and all extended tools — no license needed
- **License system completely removed** — no keys, no grace period, no Polar.sh dependency

### Renamed: SilbercueChrome is now Public Browser

The project has been renamed to reflect its new identity as a fully open, community-driven browser automation server.

| What | Old | New |
|------|-----|-----|
| npm package | `@silbercue/chrome` | `public-browser` |
| Binary | `silbercuechrome` | `public-browser` |
| Python package | `silbercuechrome` | `publicbrowser` |
| Debug env var | `DEBUG=silbercuechrome` | `DEBUG=public-browser` |
| User data dir | `~/.silbercuechrome/` | `~/.public-browser/` |
| GitHub repo | `Silbercue/SilbercueChrome` | `Silbercue/public-browser` |

### Migration Guide (v1.3.0 to v2.0.0)

**npm / npx users:**

```bash
# Old
npx @silbercue/chrome@latest
# New
npx public-browser@latest
```

Update your MCP configuration (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest"]
    }
  }
}
```

**Python users:**

```bash
pip uninstall silbercuechrome
pip install publicbrowser
```

```python
# Old
from silbercuechrome import Chrome
# New
from publicbrowser import Chrome
```

**Environment variables:**

```bash
# Old
DEBUG=silbercuechrome
# New
DEBUG=public-browser
```

**User data:** The data directory moved from `~/.silbercuechrome/` to `~/.public-browser/`. Your existing data is not migrated automatically — copy it manually if needed.

### Breaking Changes

- **Package name:** `@silbercue/chrome` is deprecated. Use `public-browser`.
- **Binary name:** `silbercuechrome` is now `public-browser`.
- **Python package:** `silbercuechrome` is now `publicbrowser`.
- **Debug env var:** `DEBUG=silbercuechrome` is now `DEBUG=public-browser`.
- **User data dir:** `~/.silbercuechrome/` is now `~/.public-browser/`.
- **License keys:** No longer accepted or required. Remove any `SILBERCUE_PRO_KEY` environment variable.

### Removed

- License validation and Polar.sh integration
- Pro/Free feature gating logic
- `SILBERCUE_PRO_KEY` environment variable support
- Pro-specific build pipeline and repository

---

## [1.3.0] - 2026-04-26

### Changed
- Internal pre-release for Public Browser migration (Stories 11.1-11.6)
- All Pro feature gates removed
- License system removed
- Renamed to Public Browser

## [1.2.0] - 2026-04-25

### Fixed
- FR-045: evaluate spiral hint now escalates correctly

### Changed
- Full tool set is default again (FR-035 revised)

## [1.1.1] - 2026-04-21

### Fixed
- Same-site cross-origin iframes now inlined in A11y-Tree

## [1.1.0] - 2026-04-16

### Added
- `Chrome.connect()` Auto-Start — starts the SilbercueChrome server automatically as a subprocess, no manual server or Chrome launch needed
- Escape Hatch: `page.cdp.send()` for direct CDP access in special cases (network interception, console log subscriptions, performance tracing, cookie management)
- Script API Gateway: HTTP server on port 9223 for Script API clients (`--script` flag)
- Server discovery chain: running server → PATH binary → npx fallback → explicit `server_path`

### Changed
- Script API (Python): Shared Core — scripts now use the same tool implementations as the MCP server. Every improvement to click, navigate, fill_form etc. automatically benefits scripts too
- `python/README.md` fully rewritten for Shared Core architecture, Auto-Start, and Escape Hatch documentation

## [1.0.0] - 2026-04-15

### Added
- 23 MCP tools for Chrome browser automation (10 Default, 13 Extended; 6 Pro-gated)
- `run_plan`: Server-side batch execution of multiple browser actions in a single tool call with variables, conditions, suspend/resume
- `virtual_desk`: Session management entry point — lists tabs, shows status, steers the LLM to the right tool
- Zero-Config Chrome launch via `npx @silbercue/chrome@latest` and `--attach` mode for connecting to running Chrome
- Free/Pro license model via Polar.sh (Free: full 10-tool default set; Pro: 23 tools + parallel run_plan)
- Ambient Context: DOM-diff (NEW/REMOVED/CHANGED lines) included inline after click — no extra view_page needed
- Progressive A11y-Tree with token budget and 50K safety cap
- Speculative prefetch during LLM think time
- Anti-Pattern Detection: evaluate-spiral streak detector with situational fail-hints (BUG-018 mitigation)
- Tool steering via negative delimitation in tool descriptions
- Configurable tool profiles (Default 10, Full 23 via `SILBERCUE_CHROME_FULL_TOOLS`)
- Multi-tab management (Pro: `switch_tab`, `virtual_desk`)
- Download tracking with status and session history
- Auto-reconnect with state preservation
- Shadow DOM + cross-origin iframe (OOPIF) support
- Drag-and-drop via native CDP mouse events
- `press_key` with real CDP keyboard events and ref/selector target focus
- `fill_form` for multi-field form filling in a single call
- `observe` tool — MutationObserver + polling hybrid for DOM change detection
- Container-aware scrolling (`scroll` with container_ref/container_selector)
- `inspect_element` for CSS debugging with computed styles, CSS rules, cascade, and visual clip
- Script API (Python): `pip install silbercuechrome` — deterministic browser automation via CDP, parallel to MCP server (`--script` flag), tab isolation, context-manager pattern

### Epic Overview

| Epic | Scope |
|------|-------|
| 1 — Page Reading & Navigation | A11y-Tree with stable refs, progressive depth, screenshots, tab status, URL navigation |
| 2 — Element Interaction | Click, type, fill_form, scroll, press_key (Pro), drag-and-drop |
| 3 — Automated Multi-Step Workflows | run_plan batch execution, evaluate, wait_for, observe, step-limit partial results |
| 4 — Tab & Download Management | Multi-tab open/switch/close (Pro), tab overview, download status and history |
| 5 — Connection & Reliability | Chrome auto-launch, --attach mode, auto-reconnect with state preservation |
| 6 — Intelligent Tool Steering | Anti-pattern detection, stale-ref recovery, negative delimitation, tool profiles, DOM-diff |
| 7 — Distribution & Licensing | npx zero-install, Polar.sh license keys, 7-day grace period, free-tier completeness |
| 8 — Documentation & v1.0 Release | README, CHANGELOG, MCP server instructions audit, release checklist |
| 9 — Script API (Python) | Python CDP client, --script CLI mode, tab isolation, pip distribution |

### Benchmark Results (mcp-test.second-truth.com, 24 LLM-driven tests)

| Server | Pass Rate | Tool Calls | Duration |
|--------|-----------|------------|----------|
| **SilbercueChrome MCP** | **24/24 (100%)** | **71** | **350s** |
| Playwright MCP | 24/24 (100%) | 138 | 570s |
| claude-in-chrome | 24/24 (100%) | 193 | 772s |
| browser-use | 16/24 (67%) | 124 | 1813s |

SilbercueChrome achieves the same 100% pass rate as Playwright MCP and claude-in-chrome with 49-63% fewer tool calls. Extended benchmark (35 tests including Level 5): 34/35 passed, 1 skipped (chrome://crash safety).

### Known Issues
- BUG-003: WebSocket Sec-WebSocket-Accept mismatch (Node 22 + Chrome 146) — Accept-Check deactivated, auto-launch not affected

### Breaking Changes (vs. pre-release)
- `read_page` renamed to `view_page`
- `screenshot` renamed to `capture_image`

### Deferred (post-v1.0)
- Story 6.1: Evaluate Anti-Spiral v2 — three new anti-patterns, situational tool steering (planned for v1.1)
- Story 6.2: Pro DOM-Diff for `type` and `fill_form` (planned for v1.1)
