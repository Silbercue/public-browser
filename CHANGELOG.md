# Changelog

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
