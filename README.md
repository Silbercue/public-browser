# SilbercueChrome

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/silbercuechrome)](https://github.com/Silbercue/silbercuechrome/releases)
[![npm version](https://img.shields.io/npm/v/@silbercue%2Fchrome)](https://www.npmjs.com/package/@silbercue/chrome)
[![Free — 18 tools](https://img.shields.io/badge/Free-18_tools-brightgreen)](https://github.com/Silbercue/silbercuechrome#free-vs-pro)
[![Pro — 23 tools](https://img.shields.io/badge/Pro-23_tools-blueviolet)](https://polar.sh/silbercuechrome)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

The most token-efficient MCP server for Chrome browser automation. Direct CDP, a11y-tree refs, multi-tab ready — 1670+ TypeScript tests, 235+ Python tests.

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client.

> **Looking for an alternative to Playwright MCP, Browser MCP, or claude-in-chrome?** SilbercueChrome talks to Chrome directly via the DevTools Protocol — no Playwright dependency, no Chrome extension bridge, no single-tab limit. One command to install, zero config. [See benchmark comparison below](#benchmarks).

## Why SilbercueChrome?

Every Chrome MCP server has the same problem: **too many tokens, too few reliable refs.** Screenshots eat 10-30x more tokens than text trees. Selector-based refs break the second the DOM rerenders. Extension bridges (Browser MCP) get stuck on the connected tab. Playwright wrappers spin up a new browser instance for every session.

SilbercueChrome fixes this. It talks directly to Chrome via CDP (same protocol Playwright and Puppeteer use internally), returns an accessibility-tree-based reference map, and caches it across calls so `click(ref: 'e5')` and `type(ref: 'e7', ...)` survive scrolls and DOM updates.

| What you get | Playwright MCP | Browser MCP | claude-in-chrome | browser-use | **SilbercueChrome** |
|---|---|---|---|---|---|
| Hardest benchmark (35 tests, LLM-driven) | 29/31 (563s) | **cannot finish** | (pending re-bench) | (pending re-bench) | **30/31 Free: 598s** |
| ∅ Tool-Response (Tokens est.) | 362 | — | — | — | **201 (1.8× smaller)** |
| P95 Tool-Response (Chars) | 8.068 | — | — | — | **2.328 (3.5× smaller)** |
| `view_page` avg (Chars) | 6.084 (`browser_snapshot`) | — | — | — | **1.124 (5.4× smaller)** |
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
claude mcp add --scope user silbercuechrome npx -y @silbercue/chrome@latest
```

**Important:** after `claude mcp add` you must **fully quit and reopen Claude Code**. `/mcp reconnect` is not enough — Claude Code reads the `mcpServers` config only at session start and caches it. After the restart, the first tool call auto-launches Chrome **visible** (no headless, no port setup). Done.

> To enable parallel Python [Script API](#script-api-python) access, add `--script` to the args:
> `claude mcp add --scope user silbercuechrome npx -y @silbercue/chrome@latest -- --script`

### Install in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "silbercuechrome": {
      "command": "npx",
      "args": ["-y", "@silbercue/chrome@latest"]
    }
  }
}
```

> For parallel Python [Script API](#script-api-python) access, use `"args": ["-y", "@silbercue/chrome@latest", "--", "--script"]`

### Install in Cline

Add to your `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "silbercuechrome": {
      "command": "npx",
      "args": ["-y", "@silbercue/chrome@latest"]
    }
  }
}
```

### Install in other MCP clients

Any client that supports stdio MCP servers: `npx -y @silbercue/chrome@latest` with no arguments.

### Try it — your first prompt

After installing, paste this into your AI coding assistant:

> Open mcp-test.second-truth.com, read the page, and fill the contact form with Name "Test User" and Email "test@example.com".

This exercises three core tools in sequence: `navigate` loads the page, `view_page` reads the accessibility tree with stable element refs, and `fill_form` fills multiple fields in one call. You should see Chrome open, the page load, and the form filled — all without writing a single line of code.

### Install Pro via Homebrew

Pro adds `virtual_desk`, `switch_tab`, `dom_snapshot`, parallel tabs in `run_plan`, ambient context hooks, and an operator hook pipeline on top of the 18 Free tools. Three commands, no JSON edits:

```bash
brew install silbercue/silbercue/silbercuechrome
claude mcp add --scope user silbercuechrome /opt/homebrew/bin/silbercuechrome
silbercuechrome activate SCC-XXXX-XXXX-XXXX-XXXX
```

**Important — restart Claude Code completely after `claude mcp add`.** `/mcp reconnect` is *not* enough. Claude Code reads the `mcpServers` config only at session start and caches it; the old command is re-used even after `reconnect`. Fully quit Claude Code and reopen it so the new `silbercuechrome` server is picked up.

After the restart, `silbercuechrome status` should print `Tier: Pro, Tools: 23`. Get a license at [polar.sh/silbercuechrome](https://polar.sh/silbercuechrome) — the key arrives by email and can be activated as shown above.

Google Chrome must be installed on the machine — SilbercueChrome auto-launches Chrome via CDP at runtime, but it does not install Chrome for you.

**Upgrading an existing install:**

```bash
brew update && brew upgrade silbercue/silbercue/silbercuechrome
```

Your license key stays in `~/.silbercuechrome/license-cache.json` and survives the upgrade — no re-activation needed.

### Uninstall

```bash
# Free (npx install)
claude mcp remove --scope user silbercuechrome

# Pro (Homebrew install)
silbercuechrome deactivate   # wipes license cache
claude mcp remove --scope user silbercuechrome
brew uninstall silbercue/silbercue/silbercuechrome
```

## Script API (Python)

A third way to use SilbercueChrome — deterministic browser automation from Python, without an LLM in the loop. Scripts use the same tool implementations as the MCP server (Shared Core) — every improvement to `click`, `navigate`, `fill_form` etc. automatically benefits your scripts too. The MCP server handles AI-driven workflows; the Script API is for repeatable scripts you write yourself.

### Installation

```bash
pip install silbercuechrome
```

That's it. `Chrome.connect()` auto-starts the SilbercueChrome server as a subprocess — no manual Chrome launch or port setup needed.

> **Legacy single-file alternative:** For quick prototyping you can copy [`python/silbercuechrome.py`](python/silbercuechrome.py) into your project. This uses v1 direct CDP and does not benefit from server-side improvements — use `pip install` for the full Shared Core experience.

### How it works

```
Python Script                        Escape Hatch (Power User)
    │                                    │
    ▼                                    ▼
HTTP POST /tool/{name}              WebSocket (CDP)
Port 9223                           Port 9222
    │                                    │
    ▼                                    │
SilbercueChrome Server                   │
    │                                    │
    ▼                                    │
registry.executeTool()                   │
    │                                    │
    ▼                                    │
Tool Handler                             │
(click.ts, navigate.ts, ...)             │
    │                                    │
    ▼                                    ▼
Chrome ◄─────────── CDP ────────────────►
```

Your script sends HTTP requests to the SilbercueChrome server on port 9223. The server executes the exact same tool handlers that the MCP server uses — one codebase, one test suite (1670+ tests), two access paths.

### Auto-Start

`Chrome.connect()` finds and starts the server automatically:

1. **Running server** — checks if port 9223 already responds, connects immediately
2. **PATH binary** — finds `silbercuechrome` in PATH (e.g. via Homebrew), starts it with `--script`
3. **npx fallback** — runs `npx -y @silbercue/chrome@latest -- --script`
4. **Explicit path** — `Chrome.connect(server_path="/path/to/silbercuechrome")` for custom setups

### Example: Login + Data Extraction

```python
from silbercuechrome import Chrome

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
| `Chrome.connect()` | Connect to or auto-start the SilbercueChrome server |
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
claude mcp add --scope user silbercuechrome npx -y @silbercue/chrome@latest -- --script
```

**Cursor / Cline (`mcp.json`):**
```json
{
  "mcpServers": {
    "silbercuechrome": {
      "command": "npx",
      "args": ["-y", "@silbercue/chrome@latest", "--", "--script"]
    }
  }
}
```

See [`python/README.md`](python/README.md) for the full API reference and advanced examples.

## Free vs Pro

The Free tier gives you 18 tools that cover the entire benchmark suite. Pro adds `virtual_desk`, `switch_tab`, `dom_snapshot`, parallel tabs in `run_plan`, ambient-context hooks, and an operator hook pipeline on top — 23 tools in total.

| | Free | Pro |
|---|---|---|
| Tools | 18 | **23** |
| Page understanding | `view_page` | `view_page` + `dom_snapshot` (spatial queries) |
| Tab management | `navigate`, `tab_status` | + `virtual_desk`, `switch_tab`, parallel tabs in `run_plan` |
| Interaction | `click`, `type`, `fill_form`, `press_key`, `scroll`, `file_upload`, `handle_dialog` | Same |
| Observation | `capture_image`, `wait_for`, `observe`, `console_logs`, `network_monitor` | Same + ambient page-context hooks |
| Scripting | `run_plan` (sequential) | `run_plan` (sequential + parallel + operator hooks) |
| Last resort | `evaluate` | `evaluate` + anti-pattern scanner hints |

Pro costs €12/month. [Get a license on Polar.sh](https://polar.sh/silbercuechrome), then follow [Install Pro via Homebrew](#install-pro-via-homebrew) above — three commands, no manual download, no env-var editing. License keys arrive by email and are activated with `silbercuechrome activate <YOUR-LICENSE-KEY>`. (The `SILBERCUECHROME_LICENSE_KEY=...` env var still works as an alternative for non-Homebrew installs.)

## Tool Overview

| Tool | Tier | Description |
|---|---|---|
| **Reading & Observation** | | |
| `view_page` | Free | A11y-tree with stable `e`-refs — primary way to understand the page. Filter by `interactive` (default) or `all`. 5.4× more compact than Playwright's `browser_snapshot`. |
| `capture_image` | Free | WebP screenshot, max 800px, <100KB. For visual verification only — refs come from `view_page`. |
| `console_logs` | Free | Browser console output with level/pattern filters |
| `network_monitor` | Free | Start/stop/query network requests with filtering |
| `observe` | Free | Watch DOM changes: `collect` (buffer over time) or `until` (wait for condition, then auto-click) |
| `wait_for` | Free | Wait for element visible, network idle, or JS expression true |
| `tab_status` | Free | Active tab's cached URL/title/ready/errors (0ms) |
| **Interaction** | | |
| `click` | Free | Real CDP mouse events by ref, selector, text, or coordinates. Response includes DOM diff (NEW/REMOVED/CHANGED). |
| `type` | Free | Type into an input by ref/selector |
| `fill_form` | Free | Fill a complete form in one call — text, `<select>`, checkbox, radio. Per-field status. |
| `press_key` | Free | Real CDP keyboard events — Enter, Escape, Tab, arrows, shortcuts (Ctrl+K, etc.) |
| `scroll` | Free | Scroll page, element into view, or inside a specific container |
| `file_upload` | Free | Upload file(s) to `<input type="file">` |
| `handle_dialog` | Free | Configure `alert`/`confirm`/`prompt` handling before triggering actions |
| **Navigation** | | |
| `navigate` | Free | Load a URL. First call per session auto-redirected to `virtual_desk` to prevent overwriting the user's tab. |
| **Scripting** | | |
| `run_plan` | Free (3) / Pro (∞) | Multi-step batch execution with variables, conditions, `saveAs`, error strategies, suspend/resume. Parallel tabs require Pro. |
| `configure_session` | Free | View/set session defaults (tab, timeout) and accept auto-promote suggestions |
| `evaluate` | Free | Execute JS in page context. Anti-pattern scanner warns on `querySelector`/`.click()`. |
| **Pro** | | |
| `virtual_desk` | Pro | Lists all tabs with stable IDs. Call first in every session. |
| `switch_tab` | Pro | Open, switch to, or close tabs by ID from `virtual_desk` |
| `dom_snapshot` | Pro | Bounding boxes, computed styles, paint order. For spatial questions `view_page` cannot answer. |

## Benchmarks

Measured on `https://mcp-test.second-truth.com` — **35 tests in 5 levels** (Basics, Intermediate, Advanced, Hardest, Community Pain Points). Each run is independent, values on the benchmark page are randomized per page-load, all runs started in a fresh Claude Code session out of `/tmp` (no project context bias), and **all metrics measured post-hoc from the session JSONL** via [`test-hardest/measure-tool-calls.sh`](.claude/skills/benchmarkTest/measure-tool-calls.sh) — no self-reporting, no MCP-side instrumentation, just counting `tool_use` blocks and `tool_result` char lengths.

### Head-to-Head (24-Test Suite, 2026-04-04)

All four servers ran the same 24-test suite on [mcp-test.second-truth.com](https://mcp-test.second-truth.com), same LLM (Claude Opus 4.6), same test page. Raw data in `test-hardest/benchmark-*.json`.

| MCP Server | Tests Passed | Duration | Tool Calls | Speed vs SC |
|---|---:|---:|---:|---|
| **SilbercueChrome** | **24/24** | **21s** | **116** | -- |
| Playwright MCP | 24/24 | 570s | 138 | 27x slower |
| claude-in-chrome | 24/24 | 772s | 193 | 37x slower |
| browser-use | 16/24 | 1813s | 124 | 86x slower |

### Pass Rate + Duration (35-Test Suite, 2026-04-09)

| MCP | Passed | Duration |
|---|---|---|
| **SilbercueChrome Free** | **30/31 (97%)** | **598s** |
| Playwright MCP | 29/31 (94%) | 563s |
| Playwright CLI | 28/31 (90%) | 376s |

**Pending re-bench on the new 35-test suite:** SilbercueChrome Pro, chrome-browser, claude-in-chrome, browser-use, Browser MCP. The previous 24-test results are archived in the git history.

### Tool-Efficiency (the fair metric)

We measure each tool call's response char length directly, group by tool name, estimate tokens via `chars/4`. Why this metric: session-level token deltas are dominated by LLM overhead (system prompt + CLAUDE.md + conversation history = ~80-90% of the budget) and only show 5-15% differences between MCPs — untrustworthy for comparing browser servers. Tool-response size is the part the MCP server actually controls.

| Metric | SC Free | Playwright MCP | Difference |
|---|---:|---:|---:|
| Tool calls (MCP-only) | 151 | 121 | +25% (SC uses more, smaller calls) |
| ∅ Response size | **807 Chars** | 1.448 Chars | **SC 1.8× smaller** |
| ∅ Response tokens est. | **201** | 362 | **SC 1.8× smaller** |
| P95 Response | **2.328 Chars** | 8.068 Chars | **SC 3.5× smaller** |
| Total response content | **128k Chars** | 175k Chars | **SC 27% less** |

### Per-Tool Breakdown (where the difference comes from)

| Tool | SC Free ∅ | Playwright MCP ∅ | Verdict |
|---|---:|---:|---|
| `view_page` / `browser_snapshot` | **1.124 Chars** (21 calls) | 6.084 Chars (8 calls) | **SC 5.4× more compact per call** |
| `evaluate` / `browser_evaluate` | **510 Chars** (33 calls) | 2.155 Chars (47 calls) | **SC 4.2× more compact per call** |
| `type` / `browser_type` | **88 Chars** (13 calls) | 147 Chars (13 calls) | SC 1.7× more compact |
| `click` / `browser_click` | 1.278 Chars (63 calls) | **463 Chars** (44 calls) | Playwright 2.8× leaner — but see trade-off below |

### The Ambient-Context trade-off

> ![key feature](https://img.shields.io/badge/key%20feature-%23FFD700?style=flat-square) **Ambient Context — Claude sees DOM changes for free, no extra `view_page` needed**

SC's `click` is 2.8× larger than Playwright's because every click response embeds the DOM diff (NEW/REMOVED/CHANGED lines). Playwright returns a bare confirmation, forcing the LLM to follow up with a `browser_snapshot` or `browser_evaluate` to see what happened. Over a full benchmark run, this cascade costs Playwright MCP **47 extra `browser_evaluate` calls** averaging 2.155 chars each. SC delivers the diff inline. Net result: SC's click+read_page+evaluate total is **120k chars vs Playwright MCP's 170k** — 30% less response content overall.

> ![key feature](https://img.shields.io/badge/key%20feature-%23FFD700?style=flat-square) **`view_page` is 5.4× more compact than Playwright MCP's `browser_snapshot`**

Measured on the 35-test benchmark (2026-04-09): SC's `view_page` averages **1.124 chars per call** vs Playwright MCP's `browser_snapshot` at **6.084 chars**. Same page, same test suite, same LLM driver. The a11y-tree compression + Ambient Context pipeline means we only send what the agent actually needs — smaller responses, less context pressure, cheaper runs.

See [`test-hardest/BENCHMARK-PROTOCOL.md`](test-hardest/BENCHMARK-PROTOCOL.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

## Architecture

```
SilbercueChrome (Node.js MCP server, @silbercue/chrome)
├── @modelcontextprotocol/sdk (stdio transport)
├── CDP Client
│   ├── WebSocket transport (existing Chrome on :9222)
│   └── Pipe transport (auto-launched Chrome with --remote-debugging-pipe)
├── Auto-Launch: Chrome + optimal flags, visible by default
├── A11y-tree cache + Selector cache
├── Session Manager (OOPIF support for iframes and Shadow DOM)
├── Tab State Cache (URL/title/ready across tabs)
├── Script API (Python, pip install silbercuechrome)
│   ├── Shared Core via HTTP (:9223) — same tool handlers as MCP
│   └── Escape Hatch via WebSocket (:9222) — direct CDP for power users
└── 18 Free-tier tools + 3+ Pro-tier tools
    Reading · Interaction · Navigation · Scripting · Observation
```

Connection priority:
1. **Auto-Launch (default, zero-config)** — starts Chrome as a child process via `--remote-debugging-pipe`, visible as a window, with all flags set for reliable screenshots and keyboard focus.
2. **WebSocket (optional)** — if you already run Chrome with `--remote-debugging-port=9222`, SilbercueChrome connects to that instead. Use this to control your own browser with its extensions and login sessions.

## Requirements

- Node.js >= 18
- Google Chrome, Chromium, or any Chromium-based browser (auto-detected on macOS/Linux/Windows; override with `CHROME_PATH`)

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `SILBERCUE_CHROME_AUTO_LAUNCH` | `true` / `false` | `true` | Auto-launch Chrome if no running instance found |
| `SILBERCUE_CHROME_HEADLESS` | `true` / `false` | `false` | Opt-in headless mode for CI/server environments |
| `SILBERCUE_CHROME_PROFILE` | path | — | Chrome user profile directory (auto-launch only) |
| `SILBERCUE_CHROME_FULL_TOOLS` | `true` / `false` | `false` | Expose the full tool set (21 tools) instead of the leaner default set (10 tools) in tools/list |
| `CHROME_PATH` | path | — | Path to Chrome binary (overrides auto-detection) |
| `SILBERCUECHROME_LICENSE_KEY` | license key | — | Pro license key (e.g. `SC-PRO-...`) |

## Known Issues

### BUG-003: WebSocket `Sec-WebSocket-Accept` Mismatch (Node 22 + Chrome 146)

When connecting to an already-running Chrome via `--remote-debugging-port=9222` (WebSocket transport), Node 22's undici 6.21.1 produces a different `Sec-WebSocket-Accept` hash than Chrome 146 expects. This is a confirmed bug in Node 22's native WebSocket implementation.

**Workaround:** The Accept validation is skipped — safe because the connection is to a localhost CDP endpoint. The workaround is already active in the shipped code.

**Auto-Launch is NOT affected.** The default mode (auto-launch) uses `--remote-debugging-pipe` which bypasses WebSocket entirely. You only hit this if you manually start Chrome with `--remote-debugging-port` and connect via `--attach`.

## License

The core server and all 18 Free-tier tools are **MIT licensed** — see [LICENSE](LICENSE). Use them however you want, commercially or otherwise.

Pro tools (3+ gated tools, parallel tab execution, ambient context, operator hooks, faster internals) require a [paid license](https://polar.sh/silbercuechrome). The license validation code is in the separate private Pro repository.

## Contributing

Issues and pull requests welcome at [github.com/Silbercue/silbercuechrome](https://github.com/Silbercue/silbercuechrome).

## Privacy

SilbercueChrome runs entirely on your machine. All browser automation happens locally via CDP. No telemetry, no remote calls, no data sent to any third party.

## Links

- [GitHub Repository](https://github.com/Silbercue/silbercuechrome)
- [npm Package](https://www.npmjs.com/package/@silbercue/chrome)
- [Benchmark Test Site](https://mcp-test.second-truth.com)
- [Pro License (Polar.sh)](https://polar.sh/silbercuechrome)
