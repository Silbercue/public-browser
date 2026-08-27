# Public Browser

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/public-browser)](https://github.com/Silbercue/public-browser/releases)
[![npm version](https://img.shields.io/npm/v/public-browser)](https://www.npmjs.com/package/public-browser)
[![25 tools](https://img.shields.io/badge/Tools-25-brightgreen)](https://github.com/Silbercue/public-browser#tool-overview)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

The most token-efficient MCP server for Chrome browser automation. Direct CDP, a11y-tree refs, multi-tab ready — 1670+ TypeScript tests, 235+ Python tests.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-dark.svg">
  <img alt="Response size per tool call, lower is better. Page snapshot: Playwright MCP 6,084 chars vs Public Browser 1,124 (5.4x smaller). P95 tool response: 8,068 vs 2,328 chars (3.5x smaller). Average tool response: 362 vs 201 tokens (1.8x smaller)." src="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-light.svg" width="880">
</picture>

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client.

> **Looking for an alternative to Playwright MCP, Browser MCP, or claude-in-chrome?** Public Browser talks to Chrome directly via the DevTools Protocol — no Playwright dependency, no Chrome extension bridge, no single-tab limit. One command to install, zero config. [See benchmark comparison below](#benchmarks).

## Why Public Browser?

Every Chrome MCP server has the same problem: **too many tokens, too few reliable refs.** Screenshots eat 10-30x more tokens than text trees. Selector-based refs break the second the DOM rerenders. Extension bridges (Browser MCP) get stuck on the connected tab. Playwright wrappers spin up a new browser instance for every session.

Public Browser fixes this. It talks directly to Chrome via CDP (same protocol Playwright and Puppeteer use internally), returns an accessibility-tree-based reference map, and caches it across calls so `click(ref: 'e5')` and `type(ref: 'e7', ...)` survive scrolls and DOM updates.

| What you get | Playwright MCP | Browser MCP | claude-in-chrome | browser-use | **Public Browser** |
|---|---|---|---|---|---|
| Hardest benchmark (35 tests, LLM-driven) | 29/31 (563s) | **cannot finish** | (pending re-bench) | (pending re-bench) | **30/31: 598s** |
| Avg Tool-Response (Tokens est.) | 362 | — | — | — | **201 (1.8x smaller)** |
| P95 Tool-Response (Chars) | 8.068 | — | — | — | **2.328 (3.5x smaller)** |
| `view_page` avg (Chars) | 6.084 (`browser_snapshot`) | — | — | — | **1.124 (5.4x smaller)** |
| Multi-tab support | Yes | **No (single tab)** | Yes | Partial | **Yes** |
| Connection | New browser | Extension bridge | Extension | Subprocess | **Direct CDP (pipe or WebSocket)** |
| Ref system | Playwright refs | Playwright refs | CSS selectors | Screenshots | **A11y-tree refs (stable across DOM changes)** |
| Drag & drop | Yes | No | Partial | No | **Yes (native CDP mouse events)** |
| Shadow DOM + iframe | Yes | Yes | Partial | No | **Yes (with OOPIF session support)** |
| Multi-step plan execution | — | — | — | — | **`run_plan` — server-side plan executor with variables, conditions, suspend/resume** |

## Quick Start

### Install in Claude Code

One command — installs globally for all projects:

```bash
claude mcp add --scope user public-browser npx -y public-browser@latest
```

**Important:** after `claude mcp add` you must **fully quit and reopen Claude Code**. `/mcp reconnect` is not enough — Claude Code reads the `mcpServers` config only at session start and caches it. After the restart, the first tool call auto-launches Chrome **visible** (no headless, no port setup). Done.

> To enable parallel Python [Script API](#script-api-python) access, add `--script` to the args:
> `claude mcp add --scope user public-browser npx -y public-browser@latest -- --script`

### Install in Cursor

Add to `~/.cursor/mcp.json`:

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

> For parallel Python [Script API](#script-api-python) access, use `"args": ["-y", "public-browser@latest", "--", "--script"]`

### Install in Cline

Add to your `cline_mcp_settings.json`:

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

### Install in other MCP clients

Any client that supports stdio MCP servers: `npx -y public-browser@latest` with no arguments.

### Try it — your first prompt

After installing, paste this into your AI coding assistant:

> Open mcp-test.second-truth.com, read the page, and fill the contact form with Name "Test User" and Email "test@example.com".

This exercises three core tools in sequence: `navigate` loads the page, `view_page` reads the accessibility tree with stable element refs, and `fill_form` fills multiple fields in one call. You should see Chrome open, the page load, and the form filled — all without writing a single line of code.

### Uninstall

```bash
claude mcp remove --scope user public-browser
```

## Chrome Profiles

By default, Public Browser starts Chrome with a fresh temp profile — no cookies, no logins, no extensions. For tasks like research on sites that block anonymous visitors, you can launch Chrome with your real profile instead.

### List available profiles

```bash
npx public-browser profiles
```

### Launch with a profile

Three ways — pick whichever fits your setup:

```bash
# CLI flag
npx public-browser --profile "Julian"

# Environment variable
PUBLIC_BROWSER_PROFILE="Julian" npx public-browser

# MCP tool (call BEFORE any browser interaction)
configure_session({ profile: "Julian" })
```

When using a real profile, Public Browser preserves extensions, cookies, logins, and sync. It creates a lightweight wrapper directory with a symlink to your real profile data — Chrome gets a "non-default" data dir (required for remote debugging) while using your actual profile.

### If Chrome is already open

Public Browser detects this via lock-file inspection. If Chrome is running with remote debugging enabled, it attaches via CDP. If not, it shows a clear error asking you to close Chrome first.

## Script API (Python)

A second way to use Public Browser — deterministic browser automation from Python, without an LLM in the loop. Scripts use the same tool implementations as the MCP server (Shared Core) — every improvement to `click`, `navigate`, `fill_form` etc. automatically benefits your scripts too. The MCP server handles AI-driven workflows; the Script API is for repeatable scripts you write yourself.

### Installation

The Python package is not currently published on PyPI. From a source checkout, install the local package:

```bash
python -m pip install ./python
```

`Chrome.connect()` auto-starts the Public Browser server as a subprocess via a local `public-browser` binary or the `npx` fallback — no manual Chrome launch or port setup needed.

> **Legacy single-file alternative:** For quick prototyping you can copy [`python/silbercuechrome.py`](python/silbercuechrome.py) into your project. This uses v1 direct CDP and does not benefit from server-side improvements — use the local `publicbrowser` package for the full Shared Core experience.

### How it works

```
Python Script                        Escape Hatch (Power User)
    |                                    |
    v                                    v
HTTP POST /tool/{name}              WebSocket (CDP)
Port 9223                           Port 9222
    |                                    |
    v                                    |
Public Browser Server                    |
    |                                    |
    v                                    |
registry.executeTool()                   |
    |                                    |
    v                                    |
Tool Handler                             |
(click.ts, navigate.ts, ...)             |
    |                                    |
    v                                    v
Chrome <------------ CDP --------------->
```

Your script sends HTTP requests to the Public Browser server on port 9223. The server executes the exact same tool handlers that the MCP server uses — one codebase, one test suite (1670+ tests), two access paths.

### Auto-Start

`Chrome.connect()` finds and starts the server automatically:

1. **Running server** — checks if port 9223 already responds, connects immediately
2. **PATH binary** — finds `public-browser` in PATH, starts it with `--script`
3. **npx fallback** — runs `npx -y public-browser@latest -- --script`
4. **Explicit path** — `Chrome.connect(server_path="/path/to/public-browser")` for custom setups

### Example: Login + Data Extraction

```python
from publicbrowser import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://competitor.example.com/login")
    page.fill({"#email": "tomek@shop.de", "#password": "***"})
    page.click("button[type=submit]")
    page.wait_for("text=Dashboard")

    for cat in ["electronics", "furniture", "toys"]:
        page.navigate(f"https://competitor.example.com/prices/{cat}")
        prices = page.evaluate(
            "[...document.querySelectorAll('tr')].map(r => r.textContent)"
        )
        save_csv(cat, prices)

chrome.close()
```

### Methods

| Method | Description |
|---|---|
| `Chrome.connect()` | Connect to or auto-start the Public Browser server |
| `chrome.new_page()` | Context manager — opens a new tab, auto-closes on exit |
| `page.navigate(url)` | Navigate and wait for load |
| `page.click(selector)` | Click element by CSS selector, text, or ref |
| `page.type(selector, text)` | Type text into an input |
| `page.fill({"sel": "val"})` | Fill multiple form fields at once |
| `page.wait_for(condition)` | Wait for JS condition or `"text=..."` shorthand |
| `page.evaluate(expression)` | Run JavaScript, return result |
| `page.download()` | Enable downloads, return download dir |
| `page.close()` | Close the tab (auto-called by context manager) |
| `page.cdp.send(method, params)` | Escape Hatch — direct CDP access via WebSocket (see below) |

### Escape Hatch: Direct CDP Access

For use cases the high-level API doesn't cover — network interception, console log subscriptions, performance tracing, cookie management — you can drop down to raw CDP commands:

```python
with chrome.new_page() as page:
    page.navigate("https://example.com")

    # Enable network tracking
    page.cdp.send("Network.enable")

    # Get all cookies
    cookies = page.cdp.send("Network.getAllCookies")

    # Performance tracing
    page.cdp.send("Tracing.start", {"categories": "-*,devtools.timeline"})
```

The Escape Hatch communicates directly with Chrome via WebSocket (port 9222), bypassing the server. It connects lazily on the first `send()` call and reuses the connection for subsequent calls. Each page gets its own WebSocket routed to the correct tab.

### MCP Coexistence

When the MCP server and Python scripts need to run at the same time, add `--script` to the MCP config. `Chrome.connect()` handles the rest automatically — each script works in its own tab, MCP tabs are never touched.

### Enabling `--script` in MCP Config

**Claude Code:**
```bash
claude mcp add --scope user public-browser npx -y public-browser@latest -- --script
```

**Cursor / Cline (`mcp.json`):**
```json
{
  "mcpServers": {
    "public-browser": {
      "command": "npx",
      "args": ["-y", "public-browser@latest", "--", "--script"]
    }
  }
}
```

See [`python/README.md`](python/README.md) for the full API reference and advanced examples.

## Node Library API (multiple instances in one process)

The MCP server and the Python Script API both drive exactly **one** Chrome per
process. When you need several browsers at once — say a read-only research
browser and a separate action browser per agent — spawning one
`npx public-browser` per instance costs 4–6 s of start-up each. `createSession()`
runs the same session inside your own Node process instead:

```ts
import { createSession } from "public-browser";

const research = await createSession({
  cdpUrl: "http://127.0.0.1:9333",          // or cdpPort: 9333
  userDataDir: "/var/agents/a1/research",   // created if missing
  headless: true,
  stealth: false,                            // stay identifiable — see below
  downloadDir: "/var/agents/a1/quarantine",  // never deleted by us
  downloadHash: true,                        // adds sha256 to every download
  downloadNaming: "suggested",               // real filenames, not GUIDs
  cortexDir: "/var/agents/a1/cortex",        // per-instance pattern store
  inheritEnv: ["HTTPS_PROXY"],               // opt in — see Environment below
});

const action = await createSession({ cdpPort: 9334, userDataDir: "/var/agents/a1/action" });

await research.callTool("navigate", { url: "https://example.com" });
const page = await research.callTool("view_page", {});

await research.close();
await action.close();
```

`callTool(name, params)` takes the same tool names and parameters as the MCP
tools (`navigate`, `view_page`, `click`, `type`, `fill_form`, `run_plan`,
`download`, ...) and routes through the identical handlers (Shared Core).

**Isolation.** Each session runs in its own worker thread by default, so the
module-level caches (element refs, selector cache, viewport state, stealth flag,
cortex matcher) exist once *per session* rather than once per process — two
sessions can never hand each other stale element refs.

Measured on macOS with `isolation: "process"`, attaching to a Chrome started
outside Public Browser (a worker thread saves ~40 ms):

| | Median |
|---|---|
| `createSession()` launches its own headless Chrome | ~0.9 s |
| `attach` to a running Chrome, up to the first tool response | ~0.7 s |
| ...through to a real page navigated and read | ~1.8 s |

Most of the attach cost is Chrome starting a renderer for the tab Public
Browser opens for itself — an attached session never takes over tabs that
belong to someone else.

A thread is not a security boundary: same process memory, same file
descriptors. `isolation: "process"` forks one OS process per session instead —
separate heap, separate descriptors, separate crash domain — for integrators
whose trust model draws the line there. `isolation: "inline"` skips isolation
altogether and is only correct when the thread runs exactly one session.

| `isolation` | Boundary | Startup | Use when |
|---|---|---|---|
| `"worker"` (default) | thread — private module caches | ~1 s | several sessions in one trusted process |
| `"process"` | OS process — private memory + descriptors | ~1 s | the sessions must not share a process with the host |
| `"inline"` | none — the calling thread | fastest | exactly one session per thread |

**No listening CDP port (`transport: "pipe"`).** By default Chrome is launched
with `--remote-debugging-port`, which is what makes `--attach`, the Script API
and reconnect-after-crash possible — and which also means every other process
on the machine can drive that browser. For a session holding real logins that
is a way around any permission check you perform yourself.

```ts
const action = await createSession({
  transport: "pipe",                      // no --remote-debugging-port at all
  userDataDir: "/var/agents/a1/action",
  headless: true,
});
```

CDP then travels over the child's stdio pipe, which only Public Browser holds:
`lsof` shows nothing listening and a second process finds no way in. The price
is everything the port paid for — no reconnect after a Chrome crash, no second
client, no `attach`, and no named `profile` (Chrome rejects the pipe with a
real user profile). Both contradictions fail at `createSession()` rather than
at the first tool call. `session.transport` reports which mode is in use, and
`session.cdpPort` is `undefined` — there is no port, and reporting the default
would name whatever Chrome the user has open on 9222.

**Environment.** A session does **not** start from the host environment. It
starts from a documented minimum and you widen it deliberately — an
orchestrator holding cloud credentials, API keys and tokens should not hand
them to a browser session just because the two share a process tree.

What a session always gets is `ESSENTIAL_ENV_VARS`: `PATH`, `HOME`, the temp
dir, `CHROME_PATH`, locale/timezone, the Linux display variables and the
Windows process basics. Everything else is opt-in:

```ts
// PATH/HOME/CHROME_PATH plus the proxy — and nothing else from the host.
await createSession({ inheritEnv: ["HTTPS_PROXY", "NO_PROXY"] });

// Full inheritance, the pre-2.8 behaviour.
await createSession({ inheritEnv: true });
```

Proxy variables are deliberately *not* essential: a proxy URL can carry
credentials, so it is allowlisted on purpose rather than inherited by accident.

On top of that, a session never inherits Public Browser's own `SILBERCUE_*` /
`PUBLIC_BROWSER_*` configuration variables — in any `inheritEnv` mode. Each of
them has an option here, and a host-level variable, usually set for the *host's*
own Chrome, silently redirecting a configured session is a bug, not a feature:
with `SILBERCUE_CHROME_HOST=10.9.9.9` in the orchestrator's environment, a
session created with `cdpPort: 9450` still talks to `127.0.0.1:9450`. Use `env`
to set one back deliberately.

**Shutdown.** `close()` resolves only once Chrome is actually gone — SIGTERM,
SIGKILL after 5 s — so the port and the user-data-dir are free for the next
launch instead of racing a process that was merely asked to exit.

**One session per Chrome.** Some CDP settings are browser-wide rather than
per-session, `Browser.setDownloadBehavior` among them: two sessions attached to
the *same* Chrome share one download directory, and whichever connected last
wins.

This fails silently and it corrupts the record: the losing session keeps
reporting paths under *its* `downloadDir`, but the file was written to the
other one. `path` then points at nothing, with no error to notice. Give each
session its own Chrome — its own port (or `transport: "pipe"`) and its own
user-data-dir — whenever `downloadDir` matters.

| Option | Default | Description |
|---|---|---|
| `cdpUrl` | — | `http://host:port`, `host:port` or a bare port. Wins over `cdpPort`/`cdpHost` |
| `cdpPort` / `cdpHost` | `9222` / `127.0.0.1` | CDP endpoint this session drives. `session.cdpPort` is `undefined` with `transport: "pipe"` |
| `userDataDir` | — | Chrome `--user-data-dir` for auto-launch. One directory per instance |
| `profile` | — | Named Chrome profile instead of a raw directory |
| `headless` | `false` | Launch Chrome headless |
| `stealth` | `true` | `false` disables all `navigator.webdriver` masking |
| `attach` | `false` | Never auto-launch; attach to a running Chrome and fail fast if there is none |
| `downloadDir` | temp dir | Where downloads land. A directory you supply is never deleted |
| `downloadHash` | `false` | Report `sha256` for every completed download |
| `downloadNaming` | `"guid"` | `"suggested"` renames finished files to the server-supplied name |
| `cortexDir` | `~/.public-browser/cortex` | Per-instance cortex store |
| `transport` | `"port"` | `"pipe"` launches Chrome with no listening CDP port (no attach/reconnect/profile) |
| `inheritEnv` | `false` | Essentials only. Array = essentials + allowlist, `true` = whole host env |
| `env` | — | Extra environment variables for the session, applied last |
| `isolation` | `"worker"` | `"process"` for an OS-process boundary, `"inline"` for none |
| `eager` | `false` | Launch/attach during `createSession()` instead of on the first call |
| `startupTimeoutMs` | `30000` | Budget for the session thread/process to report ready |

### Multiple instances via the CLI

The same thing without a Node host — one process per Chrome, each on its own port:

```bash
public-browser --port 9333 --profile research --download-dir /q/research
public-browser --port 9334 --profile action   --download-dir /q/action
```

`--profile <name>` uses one of your real Chrome profiles. For a throwaway
per-agent Chrome, point at a raw directory instead — it is created if missing:

```bash
public-browser --port 9335 --user-data-dir /var/agents/a3/chrome
```

`--attach` connects to an already-running Chrome on the configured port instead
of launching one. `SILBERCUE_CHROME_PORT` and `SILBERCUE_SCRIPT_PORT` are the
environment equivalents of `--port` and `--script-port` and are part of the
stable public contract.

## Identifiable automation (`--no-stealth`)

By default Public Browser masks `navigator.webdriver` (it reports `undefined`)
and launches Chrome with `--disable-blink-features=AutomationControlled`. That
is the right default for consumer automation, but the wrong one when your
integration must be transparently identifiable as a bot — compliance-driven
crawling, internal agent fleets, or sites whose terms require honest signalling.

Turn the masking off completely:

```bash
public-browser --no-stealth
# or
SILBERCUE_STEALTH=0 npx public-browser
```

```ts
await createSession({ stealth: false });
```

With stealth off, `navigator.webdriver` stays `true` **and** keeps its native
getter (`Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get`
still reports `[native code]`) — permanently, across navigations and tab
switches, with no post-correction needed on your side. No masking script is
injected at any point and the launch flag is omitted.

## Downloads

Downloads land in a per-session temp directory that is removed on shutdown.
Point them at a directory of your own — a quarantine dir, a shared volume — with
`--download-dir` / `PUBLIC_BROWSER_DOWNLOAD_DIR` / `downloadDir`. A directory you
supply is created if missing and **never** deleted by Public Browser.

With `--download-hash` (or `downloadHash: true`) every completed download also
carries a `sha256`, so the `download` tool returns path, size and digest:

```json
{"filename":"report.pdf","path":"/q/research/A1B2...","size":48213,"sizeKb":48,
 "url":"https://example.com/report.pdf","sha256":"9f86d081884c7d659a2f..."}
```

**Filenames.** Chrome writes downloads under their internal GUID, so the file on
disk is called `A1B2...` and only the `filename` field carries the real name.
That is fine when you read the JSON, and useless when something else has to walk
the directory. `--download-naming suggested` (or `downloadNaming: "suggested"`,
`PUBLIC_BROWSER_DOWNLOAD_NAMING=suggested`) renames each finished file to the
server-supplied name:

```json
{"filename":"report.pdf","path":"/q/research/report.pdf","size":48213,"sizeKb":48,
 "url":"https://example.com/report.pdf","sha256":"9f86d081884c7d659a2f..."}
```

The name is sanitised before it touches the disk — basename only, no control
characters, never hidden, length-capped — and a collision gets a `-1`, `-2`, ...
suffix rather than overwriting an existing file. `filename` always reports the
name the file actually has, so `join(downloadDir, filename)` equals `path`. If
the rename fails, the GUID path and the raw server name are kept and reported;
a download is never lost to a naming problem.

**Timing.** `action: "status"` waits up to 250 ms for a download to *start*
before reporting that there is none, because Chrome fires `downloadWillBegin` a
few milliseconds after the click that triggers it — without the window, the
first call after a click misses a file that is already on its way. Adjust it per
call with `settle` (`{"action":"status","settle":0}` for an instant check,
`5000` for a slow server). Once a download has started, `status` waits for it to
finish, bounded by `timeout`.

**For polling loops use `action: "list"`** — it returns the full session history
immediately and never waits, for either a start or a completion.

## Tool Overview

| Tool | Description |
|---|---|
| **Reading & Observation** | |
| `view_page` | A11y-tree with stable `e`-refs — primary way to understand the page. `filter: "interactive"` (default) returns the elements an agent can act on; `filter: "all"` adds headings, paragraphs and other static text. 5.4x more compact than Playwright's `browser_snapshot`. |
| `capture_image` | WebP screenshot, max 800px, <100KB. For visual verification only — refs come from `view_page`. |
| `console_logs` | Browser console output with level/pattern filters |
| `network_monitor` | Start/stop/query network requests with filtering |
| `observe` | Watch DOM changes: `collect` (buffer over time) or `until` (wait for condition, then auto-click) |
| `wait_for` | Wait for element visible, page **text**, **URL**, network idle, or JS expression. `assert: true` checks once and fails with a typed `code` instead of waiting |
| `tab_status` | Active tab's cached URL/title/ready/errors (0ms) |
| `virtual_desk` | Lists all tabs with stable IDs. Call first in every session. |
| `dom_snapshot` | Bounding boxes, computed styles, paint order. For spatial questions `view_page` cannot answer. |
| **Interaction** | |
| `click` | Real CDP mouse events by ref, selector, text, or coordinates. Response includes DOM diff (NEW/REMOVED/CHANGED). |
| `type` | Type into an input by ref/selector |
| `fill_form` | Fill a complete form in one call — text, `<select>`, checkbox, radio. Per-field status. |
| `press_key` | Real CDP keyboard events — Enter, Escape, Tab, arrows, shortcuts (Ctrl+K, etc.) |
| `scroll` | Scroll page, element into view, or inside a specific container |
| `file_upload` | Upload file(s) to `<input type="file">` |
| `handle_dialog` | Configure `alert`/`confirm`/`prompt` handling before triggering actions |
| `drag` | Native CDP drag & drop between elements |
| `download` | Enable downloads, return download dir |
| **Navigation** | |
| `navigate` | Load a URL. First call per session auto-redirected to `virtual_desk` to prevent overwriting the user's tab. |
| `switch_tab` | Open, switch to, or close tabs by ID from `virtual_desk` |
| **Scripting** | |
| `run_plan` | Multi-step batch execution with variables, conditions, `saveAs`, error strategies, suspend/resume. |
| `configure_session` | View/set session defaults (tab, timeout) and accept auto-promote suggestions |
| `batch_evaluate` | Visit multiple URLs sequentially and run the same JavaScript expression on each page. |
| `set_page_data` | Write large payloads to `window.__pb_data[key]` via server-side chunking for data that is too large for a single CDP message. |
| `evaluate` | Execute JS in page context. Anti-pattern scanner warns on `querySelector`/`.click()`. |

## Benchmarks

Measured on `https://mcp-test.second-truth.com` — **35 tests in 5 levels** (Basics, Intermediate, Advanced, Hardest, Community Pain Points). Each run is independent, values on the benchmark page are randomized per page-load, all runs started in a fresh Claude Code session out of `/tmp` (no project context bias), and **all metrics measured post-hoc from the session JSONL** via [`test-hardest/measure-tool-calls.sh`](.claude/skills/benchmarkTest/measure-tool-calls.sh) — no self-reporting, no MCP-side instrumentation, just counting `tool_use` blocks and `tool_result` char lengths.

### Head-to-Head (24-Test Suite, 2026-04-04)

All four servers ran the same 24-test suite on [mcp-test.second-truth.com](https://mcp-test.second-truth.com), same LLM (Claude Opus 4.6), same test page. Raw data in `test-hardest/benchmark-*.json`.

| MCP Server | Tests Passed | Duration | Tool Calls | Speed vs PB |
|---|---:|---:|---:|---|
| **Public Browser** | **24/24** | **21s** | **116** | -- |
| Playwright MCP | 24/24 | 570s | 138 | 27x slower |
| claude-in-chrome | 24/24 | 772s | 193 | 37x slower |
| browser-use | 16/24 | 1813s | 124 | 86x slower |

### Pass Rate + Duration (35-Test Suite, 2026-04-09)

| MCP | Passed | Duration |
|---|---|---|
| **Public Browser** | **30/31 (97%)** | **598s** |
| Playwright MCP | 29/31 (94%) | 563s |
| Playwright CLI | 28/31 (90%) | 376s |

### Tool-Efficiency (the fair metric)

We measure each tool call's response char length directly, group by tool name, estimate tokens via `chars/4`. Why this metric: session-level token deltas are dominated by LLM overhead (system prompt + CLAUDE.md + conversation history = ~80-90% of the budget) and only show 5-15% differences between MCPs — untrustworthy for comparing browser servers. Tool-response size is the part the MCP server actually controls.

| Metric | Public Browser | Playwright MCP | Difference |
|---|---:|---:|---:|
| Tool calls (MCP-only) | 151 | 121 | +25% (PB uses more, smaller calls) |
| Avg Response size | **807 Chars** | 1.448 Chars | **PB 1.8x smaller** |
| Avg Response tokens est. | **201** | 362 | **PB 1.8x smaller** |
| P95 Response | **2.328 Chars** | 8.068 Chars | **PB 3.5x smaller** |
| Total response content | **128k Chars** | 175k Chars | **PB 27% less** |

### Per-Tool Breakdown (where the difference comes from)

| Tool | Public Browser Avg | Playwright MCP Avg | Verdict |
|---|---:|---:|---|
| `view_page` / `browser_snapshot` | **1.124 Chars** (21 calls) | 6.084 Chars (8 calls) | **PB 5.4x more compact per call** |
| `evaluate` / `browser_evaluate` | **510 Chars** (33 calls) | 2.155 Chars (47 calls) | **PB 4.2x more compact per call** |
| `type` / `browser_type` | **88 Chars** (13 calls) | 147 Chars (13 calls) | PB 1.7x more compact |
| `click` / `browser_click` | 1.278 Chars (63 calls) | **463 Chars** (44 calls) | Playwright 2.8x leaner — but see trade-off below |

### The Ambient-Context trade-off

> **Ambient Context — Claude sees DOM changes for free, no extra `view_page` needed**

Public Browser's `click` is 2.8x larger than Playwright's because every click response embeds the DOM diff (NEW/REMOVED/CHANGED lines). Playwright returns a bare confirmation, forcing the LLM to follow up with a `browser_snapshot` or `browser_evaluate` to see what happened. Over a full benchmark run, this cascade costs Playwright MCP **47 extra `browser_evaluate` calls** averaging 2.155 chars each. Public Browser delivers the diff inline. Net result: PB's click+read_page+evaluate total is **120k chars vs Playwright MCP's 170k** — 30% less response content overall.

> **`view_page` is 5.4x more compact than Playwright MCP's `browser_snapshot`**

Measured on the 35-test benchmark (2026-04-09): Public Browser's `view_page` averages **1.124 chars per call** vs Playwright MCP's `browser_snapshot` at **6.084 chars**. Same page, same test suite, same LLM driver. The a11y-tree compression + Ambient Context pipeline means we only send what the agent actually needs — smaller responses, less context pressure, cheaper runs.

See [`test-hardest/BENCHMARK-PROTOCOL.md`](test-hardest/BENCHMARK-PROTOCOL.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

## Cortex — Self-Learning Pattern Engine

Public Browser includes a lightweight learning layer called **Cortex**. It observes which tool sequences work on different page types and feeds that knowledge back as hints to the LLM agent. No ML model, no training step — just deterministic pattern recording and Markov-chain predictions.

### How it works

1. **Page Classification** — Every page is classified by its accessibility tree into one of 16 functional types: `login`, `signup`, `mfa`, `search_form`, `search_results`, `data_table`, `form_simple`, `form_wizard`, `article`, `navigation`, `dashboard`, `settings`, `media`, `checkout`, `profile`, `error`. The classifier is rule-based (ARIA roles, landmarks, keyword signals) — no domains or URLs are involved.

2. **Pattern Recording** — Successful tool-call sequences (e.g. `navigate → view_page → fill_form → click` on a `login` page) are recorded into a local append-only Merkle log (`~/.public-browser/patterns.jsonl`). Only page type, tool names, a content hash, and a timestamp are stored — no URLs, no page content, no PII.

3. **Markov Predictions** — Recorded patterns are ingested into a first-order Markov table that models `P(next_tool | last_tool, page_type)`. When the agent lands on a page, the Cortex returns the most likely next tools with probabilities. Stale entries decay automatically (0.95/week, removed after 30 days).

4. **Community Markov Table** — A hand-curated transition table (`community-markov.json`) ships with every installation. It contains baseline probabilities for common page types so that new installations benefit from community knowledge immediately, without needing local history. The table is SHA-256 verified at load time and merged with local patterns (local data takes precedence).

### Privacy by design

The Cortex stores and transmits only structural metadata — page types (not domains), tool names (not arguments), and content hashes (not content). A `login` pattern reveals nothing about *which* login page was visited. The telemetry payload is built via explicit field allowlist (no spread operator), preventing accidental leakage of future fields.

### Opt-in telemetry

Telemetry is **disabled by default**. To contribute your anonymised patterns back to the community table, set `PUBLIC_BROWSER_TELEMETRY=1`. Uploads go via HTTPS only; non-HTTPS endpoints are rejected. Each pattern is rate-limited to prevent duplicate uploads.

### Local friction log (developer opt-in)

For development of Public Browser itself there is a second, fully local opt-in: `SILBERCUE_CHROME_FRICTION_LOG=1` makes the server count tool calls, tool errors and detected fallback spirals per run in `~/.silbercue-chrome/friction-queue.json`. It records counters, timestamps and the working directory — never page content, URLs or user input — and nothing ever leaves the machine. Without the variable the code path is not entered at all: no file, no counters, no hints.

## Architecture

```
Public Browser (Node.js MCP server, public-browser)
+-- @modelcontextprotocol/sdk (stdio transport)
+-- CDP Client
|   +-- WebSocket transport (existing Chrome on :9222)
|   +-- Pipe transport (auto-launched Chrome with --remote-debugging-pipe)
+-- Auto-Launch: Chrome + optimal flags, visible by default
+-- A11y-tree cache + Selector cache
+-- Session Manager (OOPIF support for iframes and Shadow DOM)
+-- Tab State Cache (URL/title/ready across tabs)
+-- Cortex (self-learning pattern engine)
|   +-- Page Classifier (16 page types from a11y-tree)
|   +-- Pattern Recorder + Merkle Log (local persistence)
|   +-- Markov Table (transition predictions)
|   +-- Community Table (shipped baseline, SHA-256 verified)
|   +-- Hint Matcher (delivers predictions to tool responses)
|   +-- Telemetry Upload (opt-in, HTTPS, rate-limited)
+-- Script API (Python, source install from ./python)
|   +-- Shared Core via HTTP (:9223) — same tool handlers as MCP
|   +-- Escape Hatch via WebSocket (:9222) — direct CDP for power users
+-- 25 tools
    Reading - Interaction - Navigation - Scripting - Observation
```

Connection priority:
1. **Auto-Launch (default, zero-config)** — starts Chrome as a child process via `--remote-debugging-pipe`, visible as a window, with all flags set for reliable screenshots and keyboard focus.
2. **WebSocket (optional)** — if you already run Chrome with `--remote-debugging-port=9222`, Public Browser connects to that instead. Use this to control your own browser with its extensions and login sessions.

## Requirements

- Node.js >= 18
- Google Chrome, Chromium, or any Chromium-based browser (auto-detected on macOS/Linux/Windows; override with `CHROME_PATH`)

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` | Auto-launch Chrome if no running instance found |
| `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `false` | Opt-in headless mode for CI/server environments |
| `SILBERCUE_CHROME_PORT` | `1`–`65535` | `9222` | CDP debugging port. Non-default values spawn an isolated Chrome instance (separate `--user-data-dir`) that won't conflict with the user's browser. Alias: `PUBLIC_BROWSER_CHROME_PORT` |
| `SILBERCUE_CHROME_HOST` | host | `127.0.0.1` | CDP host. Alias: `PUBLIC_BROWSER_CHROME_HOST` |
| `SILBERCUE_SCRIPT_PORT` | `1`–`65535` | `9223` | Script API port (needs `--script`). Alias: `PUBLIC_BROWSER_SCRIPT_PORT` |
| `SILBERCUE_STEALTH` | `0` / `1` | `1` | `0` disables the `navigator.webdriver` masking. Alias: `PUBLIC_BROWSER_STEALTH` |
| `PUBLIC_BROWSER_DOWNLOAD_DIR` | path | — (temp dir) | Directory downloads are written to. Created if missing, never deleted |
| `PUBLIC_BROWSER_DOWNLOAD_HASH` | `1` / `true` | — (off) | Report a `sha256` for every completed download |
| `PUBLIC_BROWSER_DOWNLOAD_NAMING` | `guid` / `suggested` | `guid` | `suggested` renames finished downloads to the server-supplied filename |
| `PUBLIC_BROWSER_CORTEX_DIR` | path | `~/.public-browser/cortex` | Per-instance cortex pattern store |
| `SILBERCUE_CHROME_PROFILE` | path | — | Chrome user profile directory (auto-launch only). Alias: `PUBLIC_BROWSER_PROFILE` (profile *name*) |
| `CHROME_PATH` | path | — | Path to Chrome binary (overrides auto-detection) |
| `PUBLIC_BROWSER_TELEMETRY` | `1` / `true` | — (disabled) | Opt-in: upload anonymised Cortex patterns to the community endpoint |
| `PUBLIC_BROWSER_TELEMETRY_ENDPOINT` | URL | `https://cortex.public-browser.dev/v1/patterns` | Override the telemetry collection endpoint (must be HTTPS) |

Invalid values fail loudly: an unparseable port or naming mode aborts startup
with a named error instead of silently falling back to 9222. Sessions created
through the Node library ignore every variable in this table except
`CHROME_PATH` and the telemetry pair — see [Node Library API](#node-library-api-multiple-instances-in-one-process).

## License

MIT licensed — see [LICENSE](LICENSE). Use it however you want, commercially or otherwise.

## Contributing

Issues and pull requests welcome at [github.com/Silbercue/public-browser](https://github.com/Silbercue/public-browser).

## Privacy

Public Browser runs entirely on your machine. All browser automation happens locally via CDP. The Cortex learning layer stores only structural metadata locally (page types, tool names, content hashes — no URLs, no domains, no page content, no PII). Telemetry is **off by default**. If you opt in via `PUBLIC_BROWSER_TELEMETRY=1`, only the same structural metadata is uploaded via HTTPS — the payload is built from an explicit field allowlist to prevent accidental leakage.

## Links

- [GitHub Repository](https://github.com/Silbercue/public-browser)
- [npm Package](https://www.npmjs.com/package/public-browser)
- [Benchmark Test Site](https://mcp-test.second-truth.com)
