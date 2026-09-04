# <img src="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/logo-400.png" width="30" alt=""> Public Browser

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/public-browser)](https://github.com/Silbercue/public-browser/releases)
[![npm version](https://img.shields.io/npm/v/public-browser)](https://www.npmjs.com/package/public-browser)
[![Tool definitions < 5k tokens](https://img.shields.io/badge/tool_definitions-%3C5k_tokens-brightgreen)](#why-an-mcp-server-and-not-a-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Lets Claude Code and Cursor drive Chrome — with your real, logged-in profile. On the same 30-test benchmark page it used **30% fewer tokens, 25% less money, 41% fewer tool calls and 40% less time** than Playwright MCP at the same pass rate — two runs each, 2026-09-03, driver Claude Opus 5, raw data in the repo ([Benchmarks](#benchmarks), including where it loses). Direct CDP, a11y-tree refs, multi-tab ready — 2,343 TypeScript tests, 237 Python tests.

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client.

> **Looking for an alternative to Playwright MCP, Browser MCP, or claude-in-chrome?** Public Browser talks to Chrome directly via the DevTools Protocol — no Playwright dependency, no Chrome extension bridge, no single-tab limit. One command to install, zero config. [See benchmark comparison below](#benchmarks).

## Why Public Browser?

Every Chrome MCP server has the same problem: **bulky responses, too few reliable refs.** Screenshots return 10-30x more context payload than text trees. Selector-based refs break the second the DOM rerenders. Extension bridges (Browser MCP) get stuck on the connected tab. Playwright wrappers spin up a new browser instance for every session.

Public Browser fixes this. It talks directly to Chrome via CDP (same protocol Playwright and Puppeteer use internally), returns an accessibility-tree-based reference map, and caches it across calls so `click(ref: 'e5')` and `type(ref: 'e7', ...)` survive scrolls and DOM updates.

Benchmark rows below are **April 2026, 35-test suite, Opus 4.6** unless a cell also gives a September value. Cells marked *Sep* come from the blind September 2026 re-run (35-test page, 30 scored, driver `claude-opus-5`, two runs per required server; one browser-use run) — run files `public-browser-run1/2.json`, `playwright-mcp-run5/6.json`, `chrome-devtools-mcp-run3/4.json`, `browser-use-run6.json` in [`test-hardest/results/`](test-hardest/results). Cross-suite comparison is not valid; see [Benchmarks](#benchmarks).

| What you get | Playwright MCP | Browser MCP | claude-in-chrome | browser-use | **Public Browser** |
|---|---|---|---|---|---|
| Benchmark pass rate (Apr 2026: 31 scored / *Sep 2026: 30 scored*) | 29/31 (563s)<br>*Sep: 30/30 (468s, 493s)* | **6/31, aborted**<br>*Sep: not re-run* | (24-test suite only) | 21/31 (1870s)<br>*Sep: 24/30, incomplete run (2023s)* | **30/31 (598s)**<br>*Sep: 30/30 (281s, 296s)* |
| Session tokens, whole run (*Sep 2026 only*) | *Sep: 8.8M, 9.6M* | — | — | *Sep: 56.2M, incomplete run* | ***Sep: 6.3M, 6.5M** (−30%)* |
| Cost per run, Opus 5 list price (*Sep 2026 only*) | *Sep: $4.28, $4.78* | — | — | *Sep: $25.25, incomplete run* | ***Sep: $3.41, $3.35** (−25%)* |
| Avg Tool-Response (Chars) | 1,448<br>*Sep: 740, 656* | — | — | — | 807<br>*Sep: 1,298, 1,214* |
| P95 Tool-Response (Chars) | 8,068<br>*Sep: 3,617, 1,587* | — | — | — | 2,328<br>*Sep: 6,077, 6,479* |
| `view_page` avg (Chars) | 6,084 (`browser_snapshot`)<br>*Sep: 1,911, 2,269* | — | — | — | 1,124<br>*Sep: 2,841, 3,398* |
| Multi-tab support | Yes | **No (single tab)** | Yes | Partial | **Yes** |
| Connection | New browser | Extension bridge | Extension | Subprocess | **Direct CDP (pipe or WebSocket)** |
| Ref system | Playwright refs | Playwright refs | CSS selectors | Screenshots | **A11y-tree refs (stable across DOM changes)** |
| Drag & drop | Yes | No | Partial | No | **Yes (native CDP mouse events)** |
| Shadow DOM + iframe | Yes | Yes | Partial | No | **Yes (with OOPIF session support)** |
| Multi-step plan execution | — | — | — | — | **`run_plan` — server-side plan executor with variables, conditions, suspend/resume** |

<sub>P95 is not computed the same way in both rows: the April values are the largest per-tool P95 (`by_tool[].p95_chars`, jq index `floor((n-1)·0.95)`), the September values are a nearest-rank P95 over all MCP calls of a run. Do not read the April and *Sep* P95 numbers as one series.</sub>

**What changed since April.** In April 2026 Public Browser's page views were 5.4x smaller than Playwright MCP's; Playwright MCP 0.0.80 has since made its snapshot format much more compact, so in the September runs its individual responses are smaller than ours (Ø 740 and 656 chars against 1,298 and 1,214) and the tool-response payload summed over a whole run is roughly a tie (109,075 / 104,432 chars against 101,478 / 99,147) — "smallest responses" is no longer a claim we can make. What the model actually consumed over the whole session is a different story: 6.3M and 6.5M tokens against 8.8M and 9.6M (~30% fewer), $3.41 and $3.35 against $4.28 and $4.78 at Opus 5 list price (~25% less). That gap comes from the second thing left standing: ~41% fewer tool calls (84 and 86 against 137 and 151) and ~40% less time to finish (281s and 296s against 468s and 493s, page timer; 34% on the full wall clock, 331s and 346s against 501s and 527s) at the same reliability, 30/30 in each of those four runs. Every call re-reads the whole conversation so far, so fewer calls means fewer re-reads — that is where the token and cost gap comes from, not from smaller responses. The advantage moved from "cheaper per look" to "cheaper per task", and the headline was changed accordingly.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-2026-09-dark.svg">
  <img alt="September 2026 benchmark, 35-test page, 30 scored, driver model claude-opus-5. Each bar is Public Browser as a share of Playwright MCP 0.0.80 on the same metric; the vertical line is Playwright at 100 percent and shorter is better. Session tokens over the whole run: 6.3 and 6.5 million against 8.8 and 9.6 million, 30 percent fewer. Cost per run at list price: 3.41 and 3.35 dollars against 4.28 and 4.78, 25 percent less. Tool calls: 84 and 86 against 137 and 151, 41 percent fewer. Time to finish: 281 and 296 seconds against 468 and 493, 40 percent less. Average response size: 1,298 and 1,214 chars against 740 and 656, 80 percent larger — Public Browser loses this one. Total response volume: 109k and 104k chars against 101k and 99k, 6 percent more. Pass rate is a tie at 30 of 30 in all four runs." src="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-2026-09-light.svg" width="880">
</picture>

September 2026 data, both runs per server, against Playwright MCP 0.0.80. Rows where the bar runs past the line are rows Public Browser loses. Method and the full table: [Benchmarks](#september-2026-current).

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

How fast that is without an LLM: a scripted run of the 24-test version of the benchmark suite finished the whole suite in **21 seconds** (`type: mcp-scripted`, 2026-04-04). That number says what deterministic scripting costs, not how Public Browser compares to other MCP servers — every cross-server comparison in [Benchmarks](#benchmarks) is LLM-driven on both sides.

### Installation

```bash
pip install publicbrowser
```

Or, from a source checkout, install the local package:

```bash
python -m pip install ./python
```

`Chrome.connect()` auto-starts the Public Browser server as a subprocess via a local `public-browser` binary or the `npx` fallback — no manual Chrome launch or port setup needed.

> **Legacy single-file alternative:** For quick prototyping you can copy [`python/publicbrowser_standalone.py`](python/publicbrowser_standalone.py) into your project. This uses v1 direct CDP and does not benefit from server-side improvements — use the local `publicbrowser` package for the full Shared Core experience.

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

Your script sends HTTP requests to the Public Browser server on port 9223. The server executes the exact same tool handlers that the MCP server uses — one codebase, one test suite (2300+ tests), two access paths.

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
| `view_page` | A11y-tree with stable `e`-refs — primary way to understand the page. `filter: "interactive"` (default) returns the elements an agent can act on; `filter: "all"` adds headings, paragraphs and other static text. |
| `capture_image` | WebP screenshot, max 800px, <100KB. For visual verification only — refs come from `view_page`. |
| `console_logs` | Browser console output with level/pattern filters |
| `network_monitor` | Start/stop/query network requests with filtering |
| `observe` | Watch DOM changes: `collect` (buffer over time) or `until` (wait for condition, then auto-click) |
| `wait_for` | Wait for element visible, page **text**, **URL**, network idle, or JS expression. `assert: true` checks once and fails with a typed `code` instead of waiting |
| `tab_status` | Active tab's cached URL/title/ready/errors (0ms) |
| `virtual_desk` | Lists all tabs with stable IDs. Call first in every session. |
| `dom_snapshot` | Bounding boxes, computed styles, paint order. For spatial questions `view_page` cannot answer. |
| **Interaction** | |
| `click` | Real CDP mouse events by ref, selector, text, or coordinates. The DOM diff (NEW/REMOVED/CHANGED) arrives with the next response, or in this one with `wait_for_diff: true`. |
| `type` | Type into an input by ref/selector |
| `fill_form` | Fill a complete form in one call — text, `<select>`, checkbox, radio. Per-field status. |
| `press_key` | Real CDP keyboard events — Enter, Escape, Tab, arrows, shortcuts (Ctrl+K, etc.) |
| `scroll` | Scroll page, element into view, or inside a specific container |
| `file_upload` | Upload file(s) to `<input type="file">` |
| `handle_dialog` | Configure `alert`/`confirm`/`prompt` handling before triggering actions |
| `drag` | Native CDP drag & drop between elements |
| `download` | Wait for pending downloads or list downloaded session files |
| **Navigation** | |
| `navigate` | Load a URL. First call per session auto-redirected to `virtual_desk` to prevent overwriting the user's tab. |
| `switch_tab` | Open, switch to, or close tabs by ID from `virtual_desk` |
| **Scripting** | |
| `run_plan` | Multi-step batch execution with variables, conditions, `saveAs`, error strategies, suspend/resume. |
| `configure_session` | View/set session defaults (tab, timeout) and accept auto-promote suggestions |
| `batch_evaluate` | Visit multiple URLs sequentially and run the same JavaScript expression on each page. |
| `set_page_data` | Write large payloads to `window.__pb_data[key]` via server-side chunking for data that is too large for a single CDP message. |
| `evaluate` | Execute JS in page context. Anti-pattern scanner warns on `querySelector`/`.click()`. |

## Why an MCP server and not a CLI?

Several browser-automation projects now ship a CLI and tell coding agents to call it from the shell; Microsoft's Playwright README recommends that route. A CLI adds no tool definitions to the context. The trade-off is that the model has to learn the command surface from `--help` output and error messages. In one practitioner's side-by-side of Chrome DevTools MCP and the agent-browser CLI, the MCP tool surface came out better and the models "do not seem deeply fluent with it yet" ([Pasi Huuhka, 28 Jan 2026](https://www.huuhka.net/browser-verification-for-coding-agents-chrome-devtools-mcp-vs-agent-browser/)) — one comparison, not a study.

Public Browser keeps the MCP surface and keeps it under a fixed budget: its 25 tool definitions take about **4,992 tokens** of context as delivered over the wire (characters / 4 of the `tools/list` response, `npm run token-count`; measured the same way with `node scripts/token-count.mjs --cmd npx --args "-y @playwright/mcp@0.0.80"`, Playwright MCP 0.0.80 takes 4,626 and Chrome DevTools MCP 1.8.0 takes 6,290). Chars / 4 is a coarse proxy — your client's `/context` figure will differ, but it is the same proxy for all three servers. A test enforces the budget, so it cannot creep back up. Getting there cost nothing in the benchmark: the two acceptance runs of the shortened definitions solved 30/30 with 79 calls each, against 84 and 86 for the previous wording (raw data in [`test-hardest/results-local/`](test-hardest/results-local)).

The other argument for a CLI — "MCP needs a round-trip per step" — is what `run_plan` is for: N steps in one call, executed server-side with variables, conditions and suspend/resume. In the same two acceptance runs that was 45% fewer tool calls than Playwright MCP (79 and 79 against 137 and 151, same pass rate); the headline's 41% comes from the published September runs with the previous wording (84 and 86 calls, see [Benchmarks](#benchmarks)).

## Coming from Browser MCP?

[Browser MCP](https://browsermcp.io) (`@browsermcp/mcp`) has had no release since 0.1.3 on 11 April 2025, and its extension bridge works on one tab. If you picked it for its four promises, here is what Public Browser does for each: **Fast** — talks to Chrome directly over CDP, no extension bridge, no cloud hop; **Private** — runs on your machine, telemetry is opt-in; **Logged In** — can drive your real, logged-in Chrome profile (see [Chrome Profiles](#chrome-profiles)); **Stealth** — sends real CDP input events, so pages see an ordinary browser; `--no-stealth` makes the automation identifiable when you want that. Install with one command ([Quick Start](#quick-start)). Tool names differ: `browser_snapshot` → `view_page`, `browser_click` → `click`, `browser_type` → `type`; `view_page` returns the refs that `click` and `type` take. Multi-tab works.

## Benchmarks

Two data sets, measured on `https://mcp-test.second-truth.com`: a **September 2026** blind re-run (current) and the **April 2026** runs kept for history. Cross-suite and cross-model comparisons are not valid — compare rows only inside one data set. Raw run JSONs, the full method and the environment matrix are in [`test-hardest/README.md`](test-hardest/README.md).

### September 2026 (current)

2026-09-03, 35-test page with **30 scored** (T5.3–T5.6 can only be started by the page's own runner; T4.7 grades a self-reported token count and was dropped for everyone). One fresh blind Claude Code session per run in print mode, driver model `claude-opus-5`, exactly one MCP server per session, built-in tools cut down to `Write`, identical prompt for every server. Two runs each for Public Browser 2.10.1, Playwright MCP 0.0.80 and Chrome DevTools MCP 1.8.0; one run for browser-use 0.12.5. All seven runs are pinned to the same page version (`suite.html_sha256` = `81e4b7aa…bed2`). Metrics are counted post-hoc from the session transcript via [`test-hardest/measure-tool-calls.sh`](test-hardest/measure-tool-calls.sh) — nothing is self-reported by the servers. Table below is the output of `node test-hardest/blind-run.mjs compare`; method, profiles and losses are documented in [`test-hardest/README.md`](test-hardest/README.md).

| MCP | Version | Model | Date | Run | Status | Passed | Duration | MCP calls | Response total | Ø response | P95 | Snapshot tool Ø |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| browser-use | 0.12.5 | claude-opus-5 | 2026-09-03 | browser-use-run6 | ok | 24/30 | 2023s | 276 | 15800k | 57244 | 321033 | 102819 (18×) |
| Chrome DevTools MCP | 1.8.0 | claude-opus-5 | 2026-09-03 | chrome-devtools-mcp-run3 | ok | 29/30 | 547s | 156 | 149k | 954 | 5676 | 4718 (12×) |
| Chrome DevTools MCP | 1.8.0 | claude-opus-5 | 2026-09-03 | chrome-devtools-mcp-run4 | ok | 29/30 | 558s | 172 | 120k | 696 | 5271 | 3593 (14×) |
| Playwright MCP | 0.0.80 | claude-opus-5 | 2026-09-03 | playwright-mcp-run5 | ok | 30/30 | 468s | 137 | 101k | 740 | 3617 | 1911 (17×) |
| Playwright MCP | 0.0.80 | claude-opus-5 | 2026-09-03 | playwright-mcp-run6 | ok | 30/30 | 493s | 151 | 99k | 656 | 1587 | 2269 (14×) |
| Public Browser | 2.10.1 | claude-opus-5 | 2026-09-03 | public-browser-run1 | ok | 30/30 | 281s | 84 | 109k | 1298 | 6077 | 2841 (16×) |
| Public Browser | 2.10.1 | claude-opus-5 | 2026-09-03 | public-browser-run2 | ok | 30/30 | 296s | 86 | 104k | 1214 | 6479 | 3398 (16×) |

What these two runs show: Public Browser needed 84 and 86 tool calls where Playwright MCP needed 137 and 151 and Chrome DevTools MCP needed 156 and 172, and it finished the page in 281s and 296s against 468s/493s and 547s/558s. Duration here is `summary.duration_s`, the page's own timer from the first test to the export click — server start, Chrome start and the first navigation are not in it; the full wall clock per run (`harness.wall_clock_s`) is 331s/346s against 501s/527s and 583s/597s. Pass rate is a tie with Playwright MCP (30/30 in both runs each) and one test ahead of Chrome DevTools MCP: its only miss is T5.2, a CDP-fingerprint check (`navigator.webdriver` is `true` under chrome-devtools-mcp) rather than a browser capability; on the other 29 tests it is a tie. `browser-use-run6` has `complete: false` — two tests were never started, so its 24/30 is an incomplete run, not a clean loss.

Where Public Browser loses in these runs: Playwright MCP 0.0.80 returns the smaller responses (Ø 740 and 656 chars against 1,298 and 1,214; `browser_snapshot` Ø 1911 and 2269 against `view_page` at 2841 and 3398, whose P95 reaches 9,734), total response volume is a near tie slightly in Playwright's favour (101k/99k against 109k/104k), and per-call click latency is mixed rather than a win — `by_tool.avg_ms` for click is 90 ms in run 1 but 435 ms in run 2, against 251 and 260 ms for Chrome DevTools MCP. P95 response size over all calls goes against Public Browser in both runs and against both competitors (6077 and 6479 chars against Playwright's 3617 and 1587 and DevTools' 5676 and 5271), and so does the `evaluate` response (Ø 1913 and 966 chars against `browser_evaluate` at 1223 and 755 and `evaluate_script` at 1069 and 488). The April claim that `view_page` is 5.4x more compact than `browser_snapshot` does not hold against Playwright MCP 0.0.80.

**What changed since April, and where the remaining lead comes from.** The April 2026 numbers (35-test suite, Opus 4.6) had Public Browser's page views 5.4x smaller than Playwright MCP's. Playwright MCP 0.0.80 has since made its snapshot format considerably more compact, and in these September runs its single responses are the smaller ones (Ø 740 and 656 chars against 1,298 and 1,214). Summed over a whole run the context payload is about the same on both sides — 109,075 and 104,432 chars for Public Browser against 101,478 and 99,147 for Playwright MCP — so "smallest responses" is not an argument we still have, and we say so. What the model consumed over the whole session is a different measure, and there Public Browser is ahead: `tokens.delta` (input + output + cache writes + cache reads from the Claude Code transcript) is 6,288,593 and 6,518,119 against 8,783,693 and 9,592,264 — ~30% fewer — and `cost_usd_list` is $3.41 and $3.35 against $4.28 and $4.78 — ~25% less. Almost all of that volume is cache reads of the growing conversation (4.4M and 4.3M against 6.0M and 6.9M); fresh input is 170–304 tokens per run on every side, so the shared overhead that made session totals useless for comparison in April is not present in these blind runs. Cache reads are billed cheaper than fresh input, which is why the cost gap (25%) is smaller than the token gap (30%) — quote the cost figure when in doubt. What drives both is ~41% fewer tool calls (84 and 86 against 137 and 151) and ~40% less time to finish (281s and 296s against 468s and 493s on the page's own timer), at identical reliability: 30/30 in all four runs. That gap does not come from smaller snapshots — both servers took page snapshots about equally often (`view_page` 16 and 16 against `browser_snapshot` 17 and 14). The design hypothesis is that it comes from `run_plan`, which bundles several steps into one call and was used 22 and 29 times, and from the 1,601 characters (2,358 since v2.10.4, without the Cortex line) of handshake instructions Public Browser sends to tell the model how to work (it is the only server in this field that sends any). Neither was isolated in this benchmark, so treat both as plausible contributors, not as a proven cause. The advantage moved from "cheaper per look" to "cheaper per task", and the headline was changed accordingly. The chart at the top of this file plots these six ratios, wins and losses on one scale; it is regenerated from the run JSON by [`scripts/make-benchmark-chart-2026-09.py`](scripts/make-benchmark-chart-2026-09.py).

### April 2026 (historical)

Measured on the same page against the **35-test version of the suite (April 2026)** — 5 levels (Basics, Intermediate, Advanced, Hardest, Community Pain Points). Four of the 35 tests are runner-only and are excluded from every score, so all pass rates in this section are out of **31 scorable tests**. An extended 42-test version exists locally and is not yet published; the numbers here are not measured against it. Driver model was Claude Opus 4.6 and competitor versions were not recorded. Each run is independent, values on the benchmark page are randomized per page-load, all runs started in a fresh Claude Code session out of `/tmp` (no project context bias), and **all metrics measured post-hoc from the session JSONL** via [`test-hardest/measure-tool-calls.sh`](test-hardest/measure-tool-calls.sh) — no self-reporting, no MCP-side instrumentation, just counting `tool_use` blocks and `tool_result` char lengths.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-dark.svg">
  <img alt="April 2026, 24- and 35-test suites, Opus 4.6 — historical, superseded by the September 2026 numbers above. Public Browser versus Playwright MCP, lower is better. Each bar is what Public Browser needed where the full track is Playwright MCP. Tool calls to pass all 24 tests: 71 of 138, 49% fewer. Page snapshot: 1,124 of 6,084 chars, 5.4x smaller. P95 tool response: 2,328 of 8,068 chars, 3.5x smaller. Average tool response: 201 of 362 tokens, 1.8x smaller. Pass rate is a tie at 30 of 31 each." src="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-light.svg" width="880">
</picture>

April 2026 data, 24- and 35-test suites, superseded by the September 2026 rerun above.

#### Head-to-Head (24-test suite, April 2026 — historical suite version)

All rows LLM-driven by Claude Opus 4.6 on the same test page, one recorded run each. Public Browser ran
2026-04-05, the other servers 2026-04-02. This is the older 24-test version of the suite — do not compare
these rows against the 31-scorable-test numbers below.

| MCP Server | Tests Passed | Duration | Tool Calls | Speed vs PB |
|---|---:|---:|---:|---|
| **Public Browser** | **24/24** | **350s** | **71** | -- |
| Playwright MCP | 24/24 | 570s | 138 | 1.6x slower |
| browser-use skill | 24/24 | 725s | 117 | 2.1x slower |
| claude-in-chrome | 24/24 | 772s | 193 | 2.2x slower |
| browser-use | 16/24 | 1813s | 124 | 5.2x slower |

In this one April 2026 run each (24-test suite, Opus 4.6), Public Browser needed **71 tool calls where Playwright
MCP needed 138** — roughly half the roundtrips for the same 24 passes. The September 2026 re-run above is the
current figure: 84 and 86 calls against 137 and 151. Raw data: `test-hardest/benchmark-*.json` (Public Browser row:
`benchmark-silbercuechrome_mcp-llm-2026-04-05.json`, `type: llm-driven`).

#### Pass Rate + Duration (31 scorable tests, LLM-driven)

Every row is one recorded run; the run id is named so each number is traceable to a single run JSON in
[`test-hardest/results/`](test-hardest/results). No averaging across runs.

| MCP | Passed | Duration | Run |
|---|---|---|---|
| **Public Browser** | **30/31 (97%)** | **598s** | Run 5 |
| Playwright MCP | 29/31 (94%) | 563s | Run 2 |
| Playwright CLI | 28/31 (90%) | 376s | Run 1 |
| Chrome DevTools MCP (Google) | 27/31 (87%) | 535s | Run 2 |
| browser-use | 21/31 (68%) | 1870s | Run 5 |
| Browser MCP (browsermcp) | 6/31 (19%) | 294s, aborted | Run 1 |
| claude-in-chrome | 24-test data only, not re-benched | — | — |

Servers with several recorded runs, so you can see the spread rather than only the row above: **Playwright MCP**
ranges 29–30/31 across three runs (Runs 2–4), its best being 30/31 in 449s (Run 3); **Chrome DevTools MCP** ranges 27–29/31,
its best 29/31 in 518s (Run 1). Run 2 is quoted for both because that is the run the tool-efficiency analysis below
instruments end to end. On pass rate this field is effectively a tie — the durable difference is response size, and
that holds across every Playwright run measured (avg 1,216–1,467 chars in Runs 2–4).

#### Tool-Efficiency (the fair metric)

We measure each tool call's response char length directly, group by tool name, estimate tokens via `chars/4`. Why this metric: in these April runs, session-level token deltas were dominated by LLM overhead (system prompt + CLAUDE.md + conversation history = ~80-90% of the budget) and only showed 5-15% differences between MCPs — untrustworthy for comparing browser servers. Tool-response size is the part the MCP server actually controls. *(The September 2026 runs are different: they are blind sessions out of `/tmp` with no CLAUDE.md and 170–304 fresh input tokens per run, so their session totals are comparable and are quoted above.)*

Public Browser Run 5 vs Playwright MCP Run 2 — the same two runs as the pass-rate table above.

| Metric | Public Browser | Playwright MCP | Difference |
|---|---:|---:|---:|
| Tool calls (MCP-only) | 151 | 121 | +25% (PB uses more, smaller calls) |
| Avg Response size | **807 Chars** | 1,448 Chars | **PB 1.8x smaller** |
| Avg Response tokens est. | **201** | 362 | **PB 1.8x smaller** |
| P95 Response | **2,328 Chars** | 8,068 Chars | **PB 3.5x smaller** |
| Total response content | **128k Chars** | 175k Chars | **PB 27% less** |

#### Per-Tool Breakdown (where the difference comes from)

| Tool | Public Browser Avg | Playwright MCP Avg | Verdict |
|---|---:|---:|---|
| `view_page`¹ / `browser_snapshot` | **1,124 Chars** (21 calls) | 6,084 Chars (8 calls) | **PB 5.4x more compact per call** |
| `evaluate` / `browser_evaluate` | **510 Chars** (33 calls) | 2,155 Chars (47 calls) | **PB 4.2x more compact per call** |
| `type` / `browser_type` | **88 Chars** (13 calls) | 147 Chars (13 calls) | PB 1.7x more compact |
| `click` / `browser_click` | 1,278 Chars (63 calls) | **463 Chars** (44 calls) | Playwright 2.8x leaner — but see trade-off below |

¹ recorded as `read_page` in the April 2026 runs; the tool was renamed to `view_page` afterwards.

#### The Ambient-Context trade-off

> **Ambient Context — Claude sees DOM changes for free, no extra `view_page` needed**

Public Browser's `click` is 2.8x larger than Playwright's because every click response embeds the DOM diff (NEW/REMOVED/CHANGED lines). Playwright returns a bare confirmation, so the LLM typically follows up with a `browser_snapshot` or `browser_evaluate` to see what happened. Over a full benchmark run, Playwright MCP spends **47 `browser_evaluate` calls** averaging 2,155 chars against Public Browser's 33 at 510 chars. Public Browser delivers the diff inline. Net result: PB's click+read_page+evaluate total is **120k chars vs Playwright MCP's 170k** — 30% less response content overall.

> **April 2026, Opus 4.6: `view_page` was 5.4x more compact than Playwright MCP's `browser_snapshot`** (superseded — against Playwright MCP 0.0.80 in September 2026 it is not)

Measured on the 35-test benchmark (2026-04-09): Public Browser's `view_page` averages **1,124 chars per call** vs Playwright MCP's `browser_snapshot` at **6,084 chars**. Same page, same test suite, same LLM driver. The a11y-tree compression + Ambient Context pipeline meant we only sent what the agent actually needed — smaller responses, less context pressure, cheaper runs. That was the April 2026 picture. Against Playwright MCP 0.0.80 it no longer holds — that release made the snapshot format much more compact, and in the September runs `browser_snapshot` averages 1,911 and 2,269 chars against `view_page` at 2,841 and 3,398; see [September 2026 (current)](#september-2026-current) above.

See [`test-hardest/README.md`](test-hardest/README.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

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

## Related

Building for iOS too? [SilbercueSwift](https://github.com/silbercue/SilbercueSwift) is the same idea for the iOS Simulator.

## Links

- [GitHub Repository](https://github.com/Silbercue/public-browser)
- [npm Package](https://www.npmjs.com/package/public-browser)
- [Benchmark Test Site](https://mcp-test.second-truth.com)
