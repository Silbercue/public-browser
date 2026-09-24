# <img src="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/logo-400.png" width="30" alt=""> Public Browser

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/public-browser)](https://github.com/Silbercue/public-browser/releases)
[![npm version](https://img.shields.io/npm/v/public-browser)](https://www.npmjs.com/package/public-browser)
[![Tool definitions < 5k tokens](https://img.shields.io/badge/tool_definitions-%3C5k_tokens-brightgreen)](#why-an-mcp-server-and-not-a-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

Lets Claude Code, Cursor and any MCP client drive Chrome. In a blind benchmark on a 30-test page, five runs each, Public Browser 3.0 passed 30/30 in every run and used a median of **3.0M session tokens where agent-browser 0.38.1 used 4.5M — a third fewer tokens, a third less cost, a quarter fewer tool calls and a third less time** ([Benchmarks](#benchmarks), including where it loses). Measured 2026-09-23/24 with Claude Code 2.1.281, driver Claude Opus 5 and Chrome 153; agent-browser ran through its CLI with its official skill file, and the test page is our own. Direct CDP, a11y-tree refs, several steps per call with `run_plan` — 2,700+ TypeScript tests, 280+ Python tests.

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client — and, without an LLM in the loop, for decision models like [Jev](#perfect-for-jev--a-decision-model-needs-a-menu-public-browser-hands-it-one).

> **Looking for an alternative to agent-browser, Playwright MCP, Chrome DevTools MCP or Browser MCP?** Public Browser is an MCP server that talks to Chrome directly over the DevTools Protocol — no Playwright dependency, no extension bridge, no shell command per step. One command to install, zero config. [See the benchmark comparison below](#benchmarks).

## Why Public Browser?

- **Fewer tokens per task.** Every tool call makes the model re-read the conversation so far, so the session total is what you pay for. On the benchmark page Public Browser 3.0 needed 3.0M tokens (median of five runs) where agent-browser needed 4.5M. In the field run a day earlier, with Public Browser still at 2.10.6, Playwright MCP needed 7.8M and Chrome DevTools MCP 10.3M. The lead comes from fewer, denser steps: `run_plan` executes several actions with variables and conditions in one call, and since 3.0 the responses carry less repetition — diffs show only what changed, text the parent line already shows is not repeated, a tip appears once per session.
- **Loud failures instead of silent ones.** A CSS selector that matches several elements does nothing and returns the candidates with their refs. Refs are kept per tab and never reused, so a ref from a page you left reports `stale ref` instead of clicking whatever node now has that number. `drag` answers `Drag not confirmed` when nothing reacted, and a click that opens a tab names the new tab.
- **Nested cross-origin iframes and shadow DOM.** Clicks reach elements in a cross-origin iframe that sits inside another cross-origin iframe — agent-browser 0.38.1 reads one level ([#1784](https://github.com/vercel-labs/agent-browser/issues/1784)). Open and closed shadow roots are read as well.
- **Two ways in without an LLM.** A Node library (`createSession()`) and a Python client (`pip install publicbrowser`) run the same tool handlers as the MCP server.

**What agent-browser does better:** it can copy your Chrome profile so its logins come along (Public Browser's profile mode does not carry site logins on macOS, see [Chrome Profiles](#chrome-profiles)), records HAR files and intercepts requests, saves PDFs and video, and drives iOS Safari. If your agent works from the shell rather than through an MCP client, it is a strong choice.

| Blind benchmark, median of 5 runs each | **Public Browser 3.0** | agent-browser 0.38.1 (CLI) |
|---|---|---|
| Passed (30 scored tests) | **30/30 in 5 of 5 runs** | 29/30 in 5 of 5 runs — misses T5.2, a `navigator.webdriver` check |
| Session tokens, whole run | **3.02M** (2.47–3.15M) | 4.53M (4.40–5.33M) |
| Cost per run, Opus 5 list price | **$2.40** | $3.56 |
| Tool calls | **79** | 104 |
| Time to finish, wall clock | **261 s** | 386 s |
| Tool-response volume | **78.9k chars** | 84.4k chars |
| Average tool response | 1,040 chars | **754 chars** |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-2026-09-24-dark.svg">
  <img alt="Public Browser 3.0 against agent-browser 0.38.1, blind benchmark, 30 scored tests, median of 5 runs each, driver model claude-opus-5. Each bar is the Public Browser median as a share of the agent-browser median on the same metric; the vertical line is agent-browser at 100 percent and shorter is better. Session tokens: 3.02M against 4.53M, 33 percent fewer. Cost per run: $2.40 against $3.56, 33 percent less. Tool calls: 79 against 104, 24 percent fewer. Time to finish: 261 s against 386 s, 32 percent less. Total response volume: 78.9k against 84.4k, 7 percent less. Avg response size: 1,040 against 754, 38 percent larger — Public Browser loses this one. Passed 30/30 in all 5 runs against 29/30 in all 5 runs (agent-browser misses T5.2, a navigator.webdriver check)." src="https://raw.githubusercontent.com/Silbercue/public-browser/master/.github/assets/benchmark-2026-09-24-light.svg" width="880">
</picture>

2026-09-23/24, Claude Code 2.1.281, driver `claude-opus-5`, Chrome 153.0.8010.53. Method, per-run table and the rest of the field: [Benchmarks](#benchmarks).

## Quick Start

### Install in Claude Code

One command — installs globally for all projects:

```bash
claude mcp add --scope user public-browser -- npx -y public-browser@latest
```

**Important:** after `claude mcp add` you must **fully quit and reopen Claude Code**. `/mcp reconnect` is not enough — Claude Code reads the `mcpServers` config only at session start and caches it. After the restart, the first tool call auto-launches Chrome **visible** (no headless, no port setup). Done.

> To enable parallel Python [Script API](#script-api-python--perfect-for-jev-loops) access, add `--script` to the args:
> `claude mcp add --scope user public-browser -- npx -y public-browser@latest -- --script`

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

> For parallel Python [Script API](#script-api-python--perfect-for-jev-loops) access, use `"args": ["-y", "public-browser@latest", "--", "--script"]`

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

By default, Public Browser starts Chrome with a fresh temp profile — no cookies, no logins, no extensions. You can also start Chrome with one of your own Chrome profiles.

### List available profiles

```bash
npx public-browser profiles
```

### Launch with a profile

Three ways — pick whichever fits your setup:

```bash
# CLI flag
npx public-browser --profile "Work"

# Environment variable
PUBLIC_BROWSER_PROFILE="Work" npx public-browser

# MCP tool (call BEFORE any browser interaction)
configure_session({ profile: "Work" })
```

Chrome refuses remote control on its default data directory, so Public Browser creates a lightweight wrapper directory with a symlink to your profile folder and starts Chrome on that. The wrapper is removed when Public Browser closes Chrome, and wrappers left behind by a crash are removed on the next start; your profile folder itself is never deleted.

**What carries over, and what does not.** Bookmarks, history, extensions and Chrome's own Google sign-in come along, so Google sites are signed in. **Other sites are not, at least on macOS:** current Chrome (tested with 153) does not load the profile's cookies through the symlink — the sandbox of Chrome's network service only allows paths below the wrapper — so sites start logged out, and logins made during the session are not saved to your profile. Linux and Windows are untested. Copying the profile at start, as agent-browser does, is planned.

**No open debugging port.** A real profile is driven over `--remote-debugging-pipe`: CDP runs through a pipe that only Public Browser holds, and nothing listens on a TCP port — other programs on your machine cannot take over your browser. The flip side: `--attach` and the Script API escape hatch (`page.cdp`) do not work with a real profile. Should Chrome ever refuse the pipe, Public Browser restarts it with a random debugging port (never 9222) and says so on stderr and once in the next tool response: while that Chrome runs, the profile is reachable for local programs.

### If Chrome is already open

Public Browser detects this via lock-file inspection. If Chrome is running with remote debugging enabled, it attaches via CDP. If not, it shows a clear error asking you to close Chrome first. A profile can be open in only one Public Browser at a time: a second instance stops with an error naming the PID of the Chrome that holds it.

## Perfect for Jev — a decision model needs a menu, Public Browser hands it one

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) (TypeSafe AI, announced 15 September 2026, early access) is not a chat model. It takes program state plus a bounded set of options and returns **one typed choice with calibrated probabilities** in 70–500 ms, at $0.042 per million input tokens with free output — it cannot produce free text, so it cannot invent a selector that does not exist. TypeSafe calls this a "System One model". Two browser agents already run on it: [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (Google Flights search in 7.1 s, $0.0039, 91% fewer browser-protocol calls) and [jev-browser](https://github.com/MahmoudAdelbghany/jev-browser) (1.5× faster and 1.6× cheaper than Playwright MCP on a 12-task suite, 97% autonomous success at ~$0.0005 per task).

Every one of those loops needs the same three things from the browser side, and they are exactly what Public Browser is built around:

| Jev needs | Public Browser delivers |
|---|---|
| A **bounded menu** of actions, not a screenshot or a raw DOM | `view_page` (`filter: "interactive"`) — the a11y-tree elements an agent can act on, each with a stable `e`-ref. Ø 1.2–1.3k chars per view in the September benchmark, well inside Jev's ~32k-token page budget and 255-option choice cap. |
| **Refs that survive the action** so the chosen option can be executed and verified | `e`-refs are cached across calls and survive scrolls and DOM re-renders; `click`/`type`/`fill_form` return a DOM diff (NEW/REMOVED/CHANGED) that serves as the deterministic verification signal Jev-style loops use instead of a second model call. |
| A **programmatic driver without an LLM in the loop** | The [Script API (Python)](#script-api-python--perfect-for-jev-loops) over HTTP and the [Node Library API](#node-library-api-multiple-instances-in-one-process--perfect-for-jev) in-process — same tool handlers as the MCP server, one Chrome per Jev worker, headless or with one of your Chrome profiles. |

**Measured, not claimed.** [`examples/jev-loop.mjs`](examples/jev-loop.mjs) is that loop in ~150 lines on the Node Library: `view_page` on the test card → one Jev `choice` over the card's refs (plus a `boolean` "already done?") → `click` / `type` / `fill_form` → repeat. Jev cannot write text, so when it picks a "type" action, `gpt-4.1-nano` writes the literal value for that one field — the same split browser-use/jev-ultrafast uses. Run on the six Level-1 cards of the [public benchmark page](https://mcp-test.second-truth.com), two runs, 2026-09-18, Jev via Vercel AI Gateway, headless Chrome:

| | Run 1 | Run 2 |
|---|---|---|
| Cards passed | **6/6** | **6/6** |
| Steps = Jev calls (one decision per step) | 23 | 21 |
| Text-model calls (form fields, secret code, table sum) | 8 | 7 |
| Wall-clock, all six cards | 20.2 s | 16.4 s |
| Cost, all six cards (Jev $0.042/M in, nano $0.10/M in, $0.40/M out) | $0.0012 | $0.0011 |

Per card that is ~3 s and ~$0.0002. The same six cards inside the LLM-driven September runs above (Opus 5 over MCP, 30 cards in 281–296 s for $3.35–3.41) come to roughly 9–10 s and $0.11 per card — a different setup (a frontier model reads the whole page and plans; Jev only picks from a menu), so read it as "what the cheap path costs", not as a benchmark of equals. Level 1 is the easy tier; whether a Jev-only loop survives Level 2–4 (observe, shadow DOM, canvas, races) is the open question, and the harness for asking it is in the repo. Raw data: [`test-hardest/results/jev-loop-run1.json`](test-hardest/results/jev-loop-run1.json), [`run2`](test-hardest/results/jev-loop-run2.json). Setup: `npm i ai @ai-sdk/openai public-browser`, `AI_GATEWAY_API_KEY` + `OPENAI_API_KEY`, `node examples/jev-loop.mjs`.

## Script API (Python) — perfect for Jev loops

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

Your script sends HTTP requests to the Public Browser server on port 9223. The server executes the exact same tool handlers that the MCP server uses — one codebase, one test suite (2,700+ tests), two access paths.

### Auto-Start

`Chrome.connect()` finds and starts the server automatically:

1. **Running server** — asks `GET /health` on port 9223 and connects only if a Public Browser server answers and accepts the key; any other program on that port is reported, never used
2. **PATH binary** — finds `public-browser` in PATH, starts it with `--script`
3. **npx fallback** — runs `npx -y public-browser@latest -- --script`
4. **Explicit path** — `Chrome.connect(server_path="/path/to/public-browser")` for custom setups

### Access key

The Script API only answers requests that carry its key (`Authorization: Bearer <key>`), so web pages and programs running under another user account cannot drive your browser through it. Programs running under your own user account can read the key file, just as they can read your browser profile — the key does not protect against them. You rarely see the key:

- When `Chrome.connect()` starts the server itself, it generates a key and hands it over in the `PUBLIC_BROWSER_SCRIPT_TOKEN` environment variable.
- A server started with `--script` (for example from your MCP config) generates its own key and writes it to `~/.public-browser/script-api-<port>.token`, readable only by your user. `Chrome.connect()` reads it from there.
- To use a key of your own, set `PUBLIC_BROWSER_SCRIPT_TOKEN` for both sides or pass `Chrome.connect(token=...)`.

Two scripts that call `Chrome.connect()` at the same moment while no server runs each start a server with their own key. One of them gets the port, the other gets a `PermissionError`. Connect once and open one page per task from that connection (`chrome.new_page()` can be called from several threads), or start the server beforehand with `public-browser --script`, so that every script reads the same key file.

Requests without the key get `401`. Requests from a browser (with an `Origin` header) or with a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` get `403` — that blocks web pages and DNS rebinding even if they guess the port.

**Upgrading:** the server and the `publicbrowser` Python client go together: `publicbrowser` 2.0.0 needs Public Browser 3.0.0 or newer, and `publicbrowser` 1.0.0 does not work with 3.0.0 — it does not send the key, so it reports `ConnectionError: Public Browser server not reachable` although the server runs. An MCP config with `npx -y public-browser@latest -- --script` picks up the new server on its next start — update the client at the same time (`pip install -U publicbrowser`).

### Example: Login + Data Extraction

```python
from publicbrowser import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://shop.example.com/login")
    page.fill({"#email": "me@example.com", "#password": "***"})
    page.click("button[type=submit]")
    page.wait_for("text=Dashboard")

    for cat in ["electronics", "furniture", "toys"]:
        page.navigate(f"https://shop.example.com/orders/{cat}")
        rows = page.evaluate(
            "[...document.querySelectorAll('tr')].map(r => r.textContent)"
        )
        save_csv(cat, rows)

chrome.close()
```

### Methods

| Method | Description |
|---|---|
| `Chrome.connect()` | Connect to or auto-start the Public Browser server |
| `chrome.new_page()` | Context manager — opens a new tab, auto-closes on exit |
| `page.navigate(url)` | Navigate and wait for load |
| `page.click(selector)` | Click by CSS selector (must match exactly one element), visible text (`"text=Sign in"`) or ref (`"e12"`) |
| `page.type(selector, text)` | Type text into an input |
| `page.fill({"sel": "val"})` | Fill multiple form fields at once |
| `page.wait_for(condition)` | Wait for page text (`"text=..."`), a ref, a CSS selector (`#`, `.`, `[`), `"network_idle"` or a JS condition |
| `page.evaluate(expression)` | Run JavaScript, return result |
| `page.download()` | Wait for pending downloads, return the download report (JSON or a notice) |
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

The Escape Hatch communicates directly with Chrome via WebSocket (port 9222), bypassing the server. It connects lazily on the first `send()` call and reuses the connection for subsequent calls. Each page gets its own WebSocket routed to the correct tab. It needs Chrome's debugging port, so it is not available when the server drives a real profile (`--profile`), which runs without one: `/session/create` then returns `cdp_ws_url: null` plus a `cdp_ws_note`, and `page.cdp` raises `RuntimeError`.

### MCP Coexistence

When the MCP server and Python scripts need to run at the same time, add `--script` to the MCP config. `Chrome.connect()` handles the rest automatically — each script works in its own tab, MCP tabs are never touched.

### Enabling `--script` in MCP Config

**Claude Code:**
```bash
claude mcp add --scope user public-browser -- npx -y public-browser@latest -- --script
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

## Node Library API (multiple instances in one process) — perfect for Jev

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
client and no `attach`; combining `"pipe"` with `attach` fails at
`createSession()` rather than at the first tool call. A named `profile` always
runs over the pipe, whatever `transport` says — `"pipe"` only forbids the
random-port fallback Public Browser would otherwise use if Chrome refused the
pipe. `session.transport` reports the actual connection, and `session.cdpPort`
is `undefined` when nothing listens — reporting the default would name
whatever Chrome the user has open on 9222.

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
| `cdpPort` / `cdpHost` | `9222` / `127.0.0.1` | CDP endpoint this session drives. `session.cdpPort` is `undefined` when nothing listens (`transport: "pipe"`, or a named `profile`) |
| `userDataDir` | — | Chrome `--user-data-dir` for auto-launch. One directory per instance |
| `profile` | — | Named Chrome profile instead of a raw directory. Runs over the pipe — no CDP port. On macOS, site logins do not carry over ([Chrome Profiles](#chrome-profiles)) |
| `headless` | `false` | Launch Chrome headless |
| `stealth` | `true` | `false` disables all `navigator.webdriver` masking |
| `attach` | `false` | Never auto-launch; attach to a running Chrome and fail fast if there is none |
| `downloadDir` | temp dir | Where downloads land. A directory you supply is never deleted |
| `downloadHash` | `false` | Report `sha256` for every completed download |
| `downloadNaming` | `"guid"` | `"suggested"` renames finished files to the server-supplied name |
| `cortexDir` | `~/.public-browser/cortex` | Per-instance cortex store |
| `transport` | `"port"` | `"pipe"` launches Chrome with no listening CDP port (no attach/reconnect) |
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

With `--profile` Chrome runs over the pipe and `--port` stays unused; only if Chrome refused the pipe would it get a random port, with a warning.

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
| `click` | Real CDP mouse events by ref, selector, text, or coordinates. The answer names the element it hit (`Clicked [e12] button "Save"`). The DOM diff (NEW/REMOVED/CHANGED) arrives with the next page action, or in this one with `wait_for_diff: true`. |
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

**Selectors are strict.** Where a tool takes a CSS selector (`click`, `type`, `fill_form`, `press_key`, `scroll`, `drag`, `file_upload`, `observe`), it has to match exactly one element in the page's main document. With several matches the call does nothing and returns up to five candidates with their refs — use one of the refs or a narrower selector.

## Why an MCP server and not a CLI?

Several browser-automation projects ship a CLI and tell coding agents to call it from the shell — agent-browser and Playwright CLI among them. A CLI adds no tool definitions to the context, and in the field run on 2026-09-23 both CLIs were ahead of Public Browser 2.10.6 on session tokens: agent-browser 4.22M and Playwright CLI 4.61M against 4.89M (medians of three runs). That result is what 3.0 was built to answer. Against agent-browser, 3.0 now needs a third fewer tokens (3.02M against 4.53M, five runs each); Playwright CLI was not re-run.

It gets there while still paying for an MCP surface. Its 25 tool definitions take about **4,837 tokens** of context as delivered over the wire (characters / 4 of the `tools/list` response, `npm run token-count`; a test keeps them under 4,990, so they cannot creep back up). agent-browser's skill file costs about 900 tokens by the same measure — Public Browser pays more up front and wins it back through fewer, denser steps. That is what `run_plan` is for: N steps in one call, executed server-side with variables, conditions and suspend/resume, where agent-browser's `batch` takes a flat list of commands and leaves the control flow to the model. In the five 3.0 runs the model used `run_plan` 28–43 times per run.

Whether models are more fluent with an MCP tool surface or with a CLI's `--help` output is an open question. One practitioner's side-by-side of Chrome DevTools MCP and the agent-browser CLI found the MCP surface better and the models "do not seem deeply fluent with it yet" ([Pasi Huuhka, 28 Jan 2026](https://www.huuhka.net/browser-verification-for-coding-agents-chrome-devtools-mcp-vs-agent-browser/)) — one comparison, not a study.

## Coming from Browser MCP?

[Browser MCP](https://browsermcp.io) (`@browsermcp/mcp`) has had no release since 0.1.3 on 11 April 2025, and its extension bridge works on one tab. If you picked it for its four promises, here is where Public Browser stands on each: **Fast** — talks to Chrome directly over CDP, no extension bridge, no cloud hop; **Private** — runs on your machine, no telemetry; **Logged In** — only partly: one of your Chrome profiles brings bookmarks, extensions and Chrome's own Google sign-in, but on macOS other sites start logged out (see [Chrome Profiles](#chrome-profiles)); **Stealth** — not in the bot-evasion sense: `navigator.webdriver` is not `true` by default and clicks are real CDP mouse events, but serious bot detection still sees an automated browser, and `--no-stealth` makes it identifiable on purpose. Install with one command ([Quick Start](#quick-start)). Tool names differ: `browser_snapshot` → `view_page`, `browser_click` → `click`, `browser_type` → `type`; `view_page` returns the refs that `click` and `type` take. Multi-tab works.

## Benchmarks

Four data sets, all measured on our own page `https://mcp-test.second-truth.com` — 35 tests, 30 scored (T5.3–T5.6 can only be started by the page's own runner; T4.7 grades a self-reported token count and is dropped for everyone): Public Browser 3.0 against agent-browser on **2026-09-24** (current), the whole field on **2026-09-23**, Public Browser 2.10.1 against Playwright MCP on **2026-09-03**, and the **April 2026** runs kept for history. Compare rows only inside one data set. The page source stays private; every run records the page hash (`suite.html_sha256` = `81e4b7aa…bed2` for all September runs) and the test IDs. Raw run JSONs and the full method: [`test-hardest/README.md`](test-hardest/README.md).

Every September run is one fresh blind Claude Code session in print mode with driver model `claude-opus-5` and an identical prompt. An MCP participant is the only MCP server of its session, with the built-in tools cut down to `Write`; a CLI participant may use `Bash` only for its own command (a `PreToolUse` hook, [`test-hardest/cli-guard.mjs`](test-hardest/cli-guard.mjs), blocks everything else) and gets the tool's official skill file as extra system prompt. Everything is counted post-hoc from the session transcript — nothing is self-reported by the participants. Session tokens are input + output + cache writes + cache reads, each API message counted once (`tokens.dedup: "message.id"`); cost is the Opus 5 list price.

### 2026-09-24 (current): Public Browser 3.0 vs agent-browser 0.38.1

Claude Code 2.1.281, Chrome 153.0.8010.53, five scored runs per side. agent-browser ran through its CLI; its MCP mode was not measured. Output of `node test-hardest/blind-run.mjs compare` over the ten runs:

| MCP | Version | Model | Date | Run | Status | Passed | Duration | Rounds | Tokens | MCP calls | Response total | Ø response | P95 | Snapshot tool Ø |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| agent-browser | 0.38.1 | claude-opus-5 | 2026-09-23 | agent-browser-run4 | ok | 29/30 | 333s | 107 | 4.40M | 104 | 76k | 732 | 1982 | 2131 (2×) |
| agent-browser | 0.38.1 | claude-opus-5 | 2026-09-23 | agent-browser-run6 | ok | 29/30 | 624s | 123 | 5.33M | 121 | 85k | 702 | 2036 | 388 (19×) |
| agent-browser | 0.38.1 | claude-opus-5 | 2026-09-23 | agent-browser-run7 | ok | 29/30 | 303s | 101 | 4.48M | 99 | 84k | 852 | 4041 | 2281 (1×) |
| agent-browser | 0.38.1 | claude-opus-5 | 2026-09-23 | agent-browser-run8 | ok | 29/30 | 349s | 104 | 4.53M | 102 | 85k | 837 | 2733 | 2139 (2×) |
| agent-browser | 0.38.1 | claude-opus-5 | 2026-09-23 | agent-browser-run10 | ok | 29/30 | 372s | 112 | 4.97M | 110 | 83k | 754 | 2506 | 2018 (5×) |
| Public Browser | 2.10.6 | claude-opus-5 | 2026-09-24 | public-browser-run18 | ok | 30/30 | 223s | 68 | 2.47M | 66 | 69k | 1040 | 5597 | 4150 (3×) |
| Public Browser | 2.10.6 | claude-opus-5 | 2026-09-24 | public-browser-run19 | ok | 30/30 | 245s | 83 | 3.15M | 81 | 79k | 973 | 5049 | 1344 (11×) |
| Public Browser | 2.10.6 | claude-opus-5 | 2026-09-24 | public-browser-run20 | ok | 30/30 | 223s | 83 | 3.03M | 81 | 117k | 1445 | 5602 | 1909 (12×) |
| Public Browser | 2.10.6 | claude-opus-5 | 2026-09-24 | public-browser-run21 | ok | 30/30 | 235s | 81 | 2.99M | 79 | 69k | 867 | 5372 | 2855 (7×) |
| Public Browser | 2.10.6 | claude-opus-5 | 2026-09-24 | public-browser-run22 | ok | 30/30 | 223s | 76 | 3.02M | 74 | 129k | 1748 | 5866 | 2590 (11×) |

Medians: 3.02M against 4.53M session tokens (−33%), $2.40 against $3.56 (−33%), 79 against 104 tool calls (−24%), 261 s against 386 s wall clock (−32%; 223 s against 349 s on the page's own timer, the Duration column). The Public Browser rows say 2.10.6 because they ran against the local build at commit `366c194` before the version bump ([`test-hardest/results-local/`](test-hardest/results-local), acceptance report [`acceptance-stage2-366c194.json`](test-hardest/results-local/acceptance-stage2-366c194.json)); that commit's code is what ships as 3.0.0 — later commits changed documentation, help texts, metadata and release tooling, nothing on the benchmark path. Two more agent-browser runs (`agent-browser-run5`, `run9`) were aborted by the harness because the session used a tool outside the allowlist (`Read`) and are not counted; both had 29/30.

**Where Public Browser loses.** Its single responses are larger: Ø 1,040 chars against 754 and P95 5,597 against 2,506 (medians). It pays more context up front — tool definitions and handshake instructions against a skill file (both are inside the session totals). The pass-rate gap is T5.2 alone, a `navigator.webdriver` check rather than a browser capability. And agent-browser has features Public Browser lacks (see [Why Public Browser?](#why-public-browser)).

**Before and after 3.0.** Public Browser 2.10.6, measured the same evening under the same conditions, came to 4.31M tokens (median of five, 30/30 each) against agent-browser's 4.53M ([`baseline-2026-09-aufschliessen.json`](test-hardest/results/baseline-2026-09-aufschliessen.json)) — a near tie, and in the morning series below agent-browser was ahead. The 3.0 changes (loud errors, shorter responses) moved Public Browser to 3.02M. A probe on real sites (Hacker News, Wikipedia, a demo shop; Public Browser only, two runs per task) passed every task before and after the changes ([`real-sites-probe.mjs`](test-hardest/real-sites-probe.mjs)).

### Public Browser 3.0 against the 2026-09-23 field

The 2026-09-24 and 2026-09-23 data sets ran one day apart under the same conditions: same harness, same page (`suite.html_sha256` = `81e4b7aa…bed2`), same driver model `claude-opus-5`, same Chrome 153.0.8010.53; only Claude Code moved from 2.1.280 (2026-09-23) to 2.1.281 (2026-09-24). The agent-browser row of the 2026-09-24 comparison already comes from runs made on 2026-09-23. The table sets the Public Browser 3.0 medians (30/30 ×5, 79 tool calls, 3.02M session tokens, $2.40, 261 s) against each participant's medians; a negative number means Public Browser 3.0 needs less. For agent-browser it uses the five-run medians from 2026-09-24, not the three-run row of the field table.

| Participant | Version | Passed | Tool calls | Session tokens | Cost | Wall clock |
|---|---|---|---:|---:|---:|---:|
| agent-browser | 0.38.1 | 29/30 ×5 (T5.2) | 104 (−24%) | 4.53M (−33%) | $3.56 (−33%) | 386 s (−32%) |
| Playwright CLI | 0.1.21 | 30/30 ×3 | 107 (−26%) | 4.61M (−34%) | $3.52 (−32%) | 454 s (−43%) |
| Playwright MCP | 0.0.82 | 30/30 ×3 | 162 (−51%) | 7.84M (−61%) | $5.22 (−54%) | 494 s (−47%) |
| Chrome DevTools MCP | 1.9.0 | 29/30 ×3 (T5.2) | 169 (−53%) | 10.33M (−71%) | $6.78 (−65%) | 535 s (−51%) |
| browser-use | 0.13.10 | 24/30, 26/30 | 384 (−79%) | 63.68M (−95%) | $36.06 (−93%) | 2,187 s (−88%) |

Limits: Public Browser 3.0 has five runs, the other participants three (browser-use two), and none of them was measured again after 2026-09-23. Run files: Public Browser 3.0 in [`test-hardest/results-local/`](test-hardest/results-local) (`public-browser-run18`–`22`), everything else in [`test-hardest/results/`](test-hardest/results) as listed in the two sections around this one.

### 2026-09-23: the whole field (Public Browser 2.10.6)

Claude Code 2.1.280, Chrome 153.0.8010.53, three runs per participant (two for browser-use), medians:

| Participant | Version | Via | Passed | Session tokens | Cost | Tool calls | Wall clock |
|---|---|---|---|---:|---:|---:|---:|
| Public Browser | 2.10.6 | MCP | 30/30 ×3 | 4.89M | $3.75 | 90 | 323 s |
| agent-browser | 0.38.1 | CLI | 29/30 ×3 (T5.2) | 4.22M | $3.39 | 93 | 385 s |
| Playwright CLI | 0.1.21 | CLI | 30/30 ×3 | 4.61M | $3.52 | 107 | 454 s |
| Playwright MCP | 0.0.82 | MCP | 30/30 ×3 | 7.84M | $5.22 | 162 | 494 s |
| Chrome DevTools MCP | 1.9.0 | MCP | 29/30 ×3 (T5.2) | 10.33M | $6.78 | 169 | 535 s |
| browser-use | 0.13.10 | MCP | 24/30, 26/30 | 63.68M | $36.06 | 384 | 2,187 s |

The two CLIs were ahead of Public Browser 2.10.6 on tokens — that is what 3.0 set out to change. Playwright CLI, Playwright MCP, Chrome DevTools MCP and browser-use were not re-run against 3.0. browser-use missed T3.3, T3.6 and T4.4 in both runs and T4.2 in one. Run files in [`test-hardest/results/`](test-hardest/results): `public-browser-run3`–`5`, `agent-browser-run1`–`3`, `playwright-cli-run2`–`4`, `playwright-mcp-run7`–`9`, `chrome-devtools-mcp-run5`–`7`, `browser-use-run7`–`8`.

### 2026-09-03: Public Browser 2.10.1 vs Playwright MCP 0.0.80

Claude Code 2.1.259, two runs each for Public Browser 2.10.1, Playwright MCP 0.0.80 and Chrome DevTools MCP 1.8.0, one run for browser-use 0.12.5. Output of `node test-hardest/blind-run.mjs compare` over these seven runs:

| MCP | Version | Model | Date | Run | Status | Passed | Duration | Rounds | Tokens | MCP calls | Response total | Ø response | P95 | Snapshot tool Ø |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| browser-use | 0.12.5 | claude-opus-5 | 2026-09-03 | browser-use-run6 | ok | 24/30 | 2023s | 278 | 42.46M | 276 | 15800k | 57244 | 321033 | 102819 (18×) |
| Chrome DevTools MCP | 1.8.0 | claude-opus-5 | 2026-09-03 | chrome-devtools-mcp-run3 | ok | 29/30 | 547s | 158 | 9.67M | 156 | 149k | 954 | 5676 | 4718 (12×) |
| Chrome DevTools MCP | 1.8.0 | claude-opus-5 | 2026-09-03 | chrome-devtools-mcp-run4 | ok | 29/30 | 558s | 174 | 9.71M | 172 | 120k | 696 | 5271 | 3593 (14×) |
| Playwright MCP | 0.0.80 | claude-opus-5 | 2026-09-03 | playwright-mcp-run5 | ok | 30/30 | 468s | 139 | 6.20M | 137 | 101k | 740 | 3617 | 1911 (17×) |
| Playwright MCP | 0.0.80 | claude-opus-5 | 2026-09-03 | playwright-mcp-run6 | ok | 30/30 | 493s | 153 | 7.03M | 151 | 99k | 656 | 1587 | 2269 (14×) |
| Public Browser | 2.10.1 | claude-opus-5 | 2026-09-03 | public-browser-run1 | ok | 30/30 | 281s | 85 | 4.53M | 84 | 109k | 1298 | 6077 | 2841 (16×) |
| Public Browser | 2.10.1 | claude-opus-5 | 2026-09-03 | public-browser-run2 | ok | 30/30 | 296s | 88 | 4.49M | 86 | 104k | 1214 | 6479 | 3398 (16×) |

Public Browser needed 84 and 86 tool calls where Playwright MCP needed 137 and 151 and Chrome DevTools MCP 156 and 172, and it finished the page in 281 s and 296 s against 468/493 s and 547/558 s (page timer). Session tokens were 4.53M and 4.49M against 6.20M and 7.03M for Playwright MCP (−32%), cost $3.41 and $3.35 against $4.28 and $4.78 (−25%), at 30/30 in all four runs. Playwright MCP returned the smaller responses (Ø 740 and 656 chars against 1,298 and 1,214). Earlier versions of this README quoted 6.3M/6.5M against 8.8M/9.6M tokens for these runs: that count added a message's usage once per content block; the recount per API message changed the totals, not the ratio (−30% before, −32% now). Chrome DevTools MCP's only miss was T5.2; `browser-use-run6` is incomplete (two tests never started).

<details>
<summary><b>April 2026 (historical)</b> — 24- and 35-test suites, driver Opus 4.6, superseded by the September runs</summary>

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
MCP needed 138** — roughly half the roundtrips for the same 24 passes. The September 2026 runs above are the
current figures. Raw data: `test-hardest/benchmark-*.json` (Public Browser row:
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

Measured on the 35-test benchmark (2026-04-09): Public Browser's `view_page` averages **1,124 chars per call** vs Playwright MCP's `browser_snapshot` at **6,084 chars**. Same page, same test suite, same LLM driver. The a11y-tree compression + Ambient Context pipeline meant we only sent what the agent actually needed — smaller responses, less context pressure, cheaper runs. That was the April 2026 picture. Against Playwright MCP 0.0.80 it no longer holds — that release made the snapshot format much more compact, and in the September runs `browser_snapshot` averages 1,911 and 2,269 chars against `view_page` at 2,841 and 3,398; see [September 2026 (current)](#2026-09-03-public-browser-2101-vs-playwright-mcp-0080) above.

See [`test-hardest/README.md`](test-hardest/README.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

</details>

## Cortex — Local Tool-Sequence Hints

Public Browser includes a small learning layer called **Cortex**. It writes down which tool sequences succeeded on which kind of page and, when the agent later lands on the same kind of page, adds one line to the `navigate` and `view_page` response with the most likely next tools once the top one reaches P ≥ 0.9, e.g. `Cortex (login): next → fill_form (P=0.92), click (P=0.08)`. No ML model, no training step, no network access.

### How it works

1. **Page Classification** — Every page is classified by its accessibility tree into one of 16 functional types: `login`, `signup`, `mfa`, `search_form`, `search_results`, `data_table`, `form_simple`, `form_wizard`, `article`, `navigation`, `dashboard`, `settings`, `media`, `checkout`, `profile`, `error` (or `unknown`). The classifier is rule-based (ARIA roles, landmarks, keyword signals) — no domains or URLs are involved.

2. **Pattern Recording** — A sequence that starts with `navigate` and continues with successful tool calls (2–20 calls within 60 seconds, e.g. `navigate → view_page → fill_form → click` on a `login` page) is stored in `~/.public-browser/cortex/patterns.jsonl`, with a Merkle hash tree over the entries (`tree-head.json`) for integrity checks. Only the most recent sequence per page type is kept, so the file holds at most one line per page type. Only page type, tool names, a content hash, and a timestamp are stored — no URLs, no page content, no PII.

3. **Markov Predictions** — The stored sequences are turned into a first-order Markov table that models `P(next_tool | last_tool, page_type)`; its top predictions make up the hint line. Stale entries decay (0.95/week) and are removed after 30 days.

4. **Starter table** — A hand-written transition table (`community-markov.json`) ships with the package so that a fresh install gets hints before anything has been recorded. Despite the file name it contains no collected usage data. The table is SHA-256 verified at load time and merged with local patterns (local data takes precedence).

### Privacy by design

The Cortex stores only structural metadata, and only on your machine — page types (not domains), tool names (not arguments), and content hashes (not content). A `login` pattern reveals nothing about *which* login page was visited. Nothing is uploaded.

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
+-- Cortex (local tool-sequence hints)
|   +-- Page Classifier (16 page types from a11y-tree)
|   +-- Pattern Recorder + Merkle Log (local persistence)
|   +-- Markov Table (transition predictions)
|   +-- Starter Table (hand-written, shipped, SHA-256 verified)
|   +-- Hint Matcher (delivers predictions to tool responses)
+-- Script API (Python, `pip install publicbrowser`)
|   +-- Shared Core via HTTP (:9223) — same tool handlers as MCP
|   +-- Escape Hatch via WebSocket (:9222) — direct CDP for power users
+-- 25 tools
    Reading - Interaction - Navigation - Scripting - Observation
```

Connection priority:
1. **Auto-Launch (default, zero-config)** — starts Chrome as a child process via `--remote-debugging-pipe`, visible as a window, with all flags set for reliable screenshots and keyboard focus.
2. **WebSocket (optional)** — if you already run Chrome with `--remote-debugging-port=9222`, Public Browser connects to that instead. Use this to drive a Chrome you started yourself with its own `--user-data-dir` (Chrome refuses remote debugging on its default profile directory).

## Requirements

- Node.js >= 20
- Google Chrome, Chromium, or any Chromium-based browser (auto-detected on macOS/Linux/Windows; override with `CHROME_PATH`)

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` | Auto-launch Chrome if no running instance found |
| `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `false` | Opt-in headless mode for CI/server environments |
| `SILBERCUE_CHROME_PORT` | `1`–`65535` | `9222` | CDP debugging port. Non-default values spawn an isolated Chrome instance (separate `--user-data-dir`) that won't conflict with the user's browser. Alias: `PUBLIC_BROWSER_CHROME_PORT` |
| `SILBERCUE_CHROME_HOST` | host | `127.0.0.1` | CDP host. Alias: `PUBLIC_BROWSER_CHROME_HOST` |
| `SILBERCUE_SCRIPT_PORT` | `1`–`65535` | `9223` | Script API port (needs `--script`). Alias: `PUBLIC_BROWSER_SCRIPT_PORT` |
| `PUBLIC_BROWSER_SCRIPT_TOKEN` | string | — (random) | Script API key. Unset: a server started with `--script` generates one and writes it to `~/.public-browser/script-api-<port>.token` (mode 0600) |
| `SILBERCUE_STEALTH` | `0` / `1` | `1` | `0` disables the `navigator.webdriver` masking. Alias: `PUBLIC_BROWSER_STEALTH` |
| `PUBLIC_BROWSER_DOWNLOAD_DIR` | path | — (temp dir) | Directory downloads are written to. Created if missing, never deleted |
| `PUBLIC_BROWSER_DOWNLOAD_HASH` | `1` / `true` | — (off) | Report a `sha256` for every completed download |
| `PUBLIC_BROWSER_DOWNLOAD_NAMING` | `guid` / `suggested` | `guid` | `suggested` renames finished downloads to the server-supplied filename |
| `PUBLIC_BROWSER_CORTEX_DIR` | path | `~/.public-browser/cortex` | Per-instance cortex pattern store |
| `SILBERCUE_CHROME_PROFILE` | path | — | Chrome user profile directory (auto-launch only). Alias: `PUBLIC_BROWSER_PROFILE` (profile *name*) |
| `CHROME_PATH` | path | — | Path to Chrome binary (overrides auto-detection) |

Invalid values fail loudly: an unparseable port or naming mode aborts startup
with a named error instead of silently falling back to 9222. Sessions created
through the Node library ignore every variable in this table except
`CHROME_PATH` — see [Node Library API](#node-library-api-multiple-instances-in-one-process--perfect-for-jev).

## License

MIT licensed — see [LICENSE](LICENSE). Use it however you want, commercially or otherwise.

## Contributing

Issues and pull requests welcome at [github.com/Silbercue/public-browser](https://github.com/Silbercue/public-browser).

## Privacy

Public Browser runs entirely on your machine. All browser automation happens locally via CDP. The Cortex learning layer stores only structural metadata locally (page types, tool names, content hashes — no URLs, no domains, no page content, no PII). There is no telemetry upload; the Cortex data never leaves your machine.

When Chrome runs visibly, a small Public Browser bar sits in the page for the person watching (it is `aria-hidden`, so the agent never sees it). From the fifth tool call on, it shows a link for 20 seconds every 10 minutes — a GitHub star or a Jev hint. Click or close it once and it never comes back (remembered in `~/.public-browser/nudge.json`); headless sessions never show it.

## Related

Building for iOS too? [SilbercueSwift](https://github.com/silbercue/SilbercueSwift) is the same idea for the iOS Simulator.

## Links

- [GitHub Repository](https://github.com/Silbercue/public-browser)
- [npm Package](https://www.npmjs.com/package/public-browser)
- [Benchmark Test Site](https://mcp-test.second-truth.com)
