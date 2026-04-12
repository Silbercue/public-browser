# SilbercueChrome

[![GitHub Release](https://img.shields.io/github/v/release/Silbercue/silbercuechrome)](https://github.com/Silbercue/silbercuechrome/releases)
[![npm version](https://img.shields.io/npm/v/@silbercue%2Fchrome)](https://www.npmjs.com/package/@silbercue/chrome)
[![Free — 2 tools + fallback](https://img.shields.io/badge/Free-2_tools_+_fallback-brightgreen)](https://github.com/Silbercue/silbercuechrome#free-vs-pro)
[![Pro — 2 tools + fallback](https://img.shields.io/badge/Pro-2_tools_+_fallback-blueviolet)](https://polar.sh/silbercueswift/silbercuechrome-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

The most token-efficient MCP server for Chrome browser automation. Two top-level tools (`operator` + `virtual_desk`) replace 20+ primitives — the LLM picks from annotated action cards instead of raw tool lists. Direct CDP, a11y-tree refs, multi-tab ready. **30/31 on the hardest 35-test benchmark (97% pass rate) — `read_page` is 5.4× more compact than Playwright MCP's `browser_snapshot`, and our P95 tool response is 3.5× smaller.**

Built for [Claude Code](https://claude.ai/claude-code), [Cursor](https://cursor.sh), and any MCP-compatible client.

> **Looking for an alternative to Playwright MCP, Browser MCP, or claude-in-chrome?** SilbercueChrome talks to Chrome directly via the DevTools Protocol — no Playwright dependency, no Chrome extension bridge, no single-tab limit. One command to install, zero config, and the best benchmark score in the category. The Operator mode means the LLM sees two tools instead of twenty, picks from matched action cards, and falls back to direct primitives when no card fits. [See comparison below](#benchmarks).

## Why SilbercueChrome?

Every Chrome MCP server has the same problem: **too many tokens, too few reliable refs.** Screenshots eat 10-30x more tokens than text trees. Selector-based refs break the second the DOM rerenders. Extension bridges (Browser MCP) get stuck on the connected tab. Playwright wrappers spin up a new browser instance for every session.

SilbercueChrome fixes this. It talks directly to Chrome via CDP (same protocol Playwright and Puppeteer use internally), returns an accessibility-tree-based reference map, and caches it across calls so `click(ref: 'e5')` and `type(ref: 'e7', ...)` survive scrolls and DOM updates.

| What you get | Playwright MCP | Browser MCP | claude-in-chrome | browser-use | **SilbercueChrome** |
|---|---|---|---|---|---|
| Hardest benchmark (35 tests, LLM-driven) | 29/31 (563s) | **cannot finish** | (pending re-bench) | (pending re-bench) | **30/31 Free: 598s** |
| ∅ Tool-Response (Tokens est.) | 362 | — | — | — | **201 (1.8× smaller)** |
| P95 Tool-Response (Chars) | 8.068 | — | — | — | **2.328 (3.5× smaller)** |
| `read_page` avg (Chars) | 6.084 (`browser_snapshot`) | — | — | — | **1.124 (5.4× smaller)** |
| Multi-tab support | Yes | **No (single tab)** | Yes | Partial | **Yes** |
| Connection | New browser | Extension bridge | Extension | Subprocess | **Direct CDP (pipe or WebSocket)** |
| Ref system | Playwright refs | Playwright refs | CSS selectors | Screenshots | **A11y-tree refs (stable across DOM changes)** |
| Read page | Screenshot + DOM | Snapshot | DOM dump | Screenshot-heavy | **`read_page` — 10-30x fewer tokens** |
| Drag & drop | Yes | No | Partial | No | **Yes (native CDP mouse events)** |
| Shadow DOM + iframe | Yes | Yes | Partial | No | **Yes (with OOPIF session support)** |
| Keyboard shortcuts | Yes | Yes | Partial | No | **Yes (`press_key` with real CDP keyboard events)** |
| localStorage/cookies | Yes | No | Partial | No | **Yes (via `evaluate`)** |
| Multi-step plan execution | — | — | — | — | **`operator` — card-based automation with fallback to direct primitives** |
| LLM tool overhead | 20+ tools | 20+ tools | 10+ tools | Screenshot-driven | **2 tools (operator + virtual_desk)** |
| Zero-config install | Yes | Yes | Built-in | Yes | **Yes (one `claude mcp add` line)** |

### Where SilbercueChrome really shines

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **Ambient Context — Claude sees DOM changes for free, no extra `read_page` needed**

After every `click`, SilbercueChrome's response includes **NEW / REMOVED / CHANGED** lines showing exactly what changed on the page. Playwright MCP's `browser_click` only returns "clicked element X" — Claude then has to call `browser_snapshot` or `browser_evaluate` to figure out what happened. Over a full benchmark run, this means Playwright needs **47 extra `browser_evaluate` calls** averaging 2.155 chars each just to reconstruct page state. SC delivers the diff inline, so the same workflow needs only **33 evaluate calls averaging 510 chars**. Result: **~30% less total response content** across the three main tools (click + read_page + evaluate: 120k vs 170k chars).

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **`read_page` is 5.4× more compact than Playwright MCP's `browser_snapshot`**

Measured on the 35-test hardest benchmark (2026-04-09): SC's `read_page` averages **1.124 chars per call** vs Playwright MCP's `browser_snapshot` at **6.084 chars**. Same page, same test suite, same LLM driver. The difference is the Ambient Context pipeline + a11y-tree compression — we only send what the agent actually needs, filtered to interactive elements by default. Smaller responses mean less context pressure, more room for reasoning, and cheaper runs.

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **P95 Tool-Response is 3.5× smaller than Playwright MCP**

The worst-case tool response is what really eats context budgets. SC's 95th-percentile response is **2.328 chars** vs Playwright MCP's **8.068 chars**. Even the most expensive SC call is cheaper than Playwright's typical snapshot. This compounds over long agent runs where the biggest responses decide whether the context window survives.

> ![killer feat](https://img.shields.io/badge/killer%20feat-%23FFD700?style=flat-square) **True multi-tab — `virtual_desk`, `switch_tab`, parallel tabs in `run_plan`** <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center">

Browser MCP binds to a single "connected" tab via its Chrome extension — cross-tab operations are architecturally impossible. SilbercueChrome uses CDP `Target` API to enumerate, open, close, and switch between tabs. `virtual_desk` lists every open tab with stable IDs. `switch_tab` moves between them without touching the user's active tab. `run_plan` even supports parallel tab execution.

> ![strong](https://img.shields.io/badge/strong-%23C0C0C0?style=flat-square) **`fill_form` — one call for a complete form**

Other MCPs make you emit N `type` calls for an N-field form. `fill_form` takes a single `fields[]` array with refs and values, handles text inputs, `<select>` (by value or label), checkboxes, and radios in one CDP round-trip, and reports per-field status.

> ![strong](https://img.shields.io/badge/strong-%23C0C0C0?style=flat-square) **`observe` — watch DOM changes without writing JavaScript**

Two modes: `collect` (watch for N ms, return every text/attribute change) and `until` (wait for a condition, then auto-click). Use `click_first` to trigger the action that causes changes — the observer is set up *before* the click, so nothing is missed. Replaces the typical `setInterval`/`MutationObserver`/`evaluate` dance.

> ![strong](https://img.shields.io/badge/strong-%23C0C0C0?style=flat-square) **`run_plan` — server-side multi-step automation**

Execute a sequence of tool steps server-side with variables (`$varName`), conditions (`if`), `saveAs`, error strategies (`abort`/`continue`/`screenshot`), and suspend/resume for long-running workflows. Parallel tab execution is a Pro feature.

## Quick Start

### Install in Claude Code

One command — installs globally for all projects:

```bash
claude mcp add --scope user silbercuechrome npx -y @silbercue/chrome@latest
```

**Important:** after `claude mcp add` you must **fully quit and reopen Claude Code**. `/mcp reconnect` is not enough — Claude Code reads the `mcpServers` config only at session start and caches it. After the restart, the first tool call auto-launches Chrome **visible** (no headless, no port setup). Done.

You now have two tools: `operator` (scans pages, matches action cards, executes tasks) and `virtual_desk` (tab management). Ask Claude to "open example.com and tell me what you see" — the operator scans the page, returns a structured reading with action cards, and you pick a card to execute. If no card matches, SilbercueChrome automatically falls back to direct primitives (`click`, `type`, `read_page`, etc.).

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

### Install in other MCP clients

Any client that supports stdio MCP servers: `npx -y @silbercue/chrome@latest` with no arguments.

### Install Pro via Homebrew

Pro adds `switch_tab`, `dom_snapshot`, parallel tab execution, ambient context hooks, and an operator hook pipeline on top of the Free tier. Three commands, no JSON edits:

```bash
brew install silbercue/silbercue/silbercuechrome
claude mcp add --scope user silbercuechrome /opt/homebrew/bin/silbercuechrome
silbercuechrome activate SCC-XXXX-XXXX-XXXX-XXXX
```

**Important — restart Claude Code completely after `claude mcp add`.** `/mcp reconnect` is *not* enough. Claude Code reads the `mcpServers` config only at session start and caches it; the old command is re-used even after `reconnect`. Fully quit Claude Code and reopen it so the new `silbercuechrome` server is picked up.

After the restart, `silbercuechrome status` should print `Tier: Pro`. Get a license at [polar.sh/silbercueswift](https://polar.sh/silbercueswift/silbercuechrome-pro) — the key arrives by email and can be activated as shown above.

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

## Free vs Pro

Both Free and Pro expose two top-level tools (`operator` + `virtual_desk`) in the default Operator mode. When no action card matches, SilbercueChrome falls back to six direct primitives (`click`, `type`, `read_page`, `wait_for`, `screenshot`, `virtual_desk`). Pro adds deeper capabilities on top.

| | Free | Pro |
|---|---|---|
| Top-level tools | `operator` + `virtual_desk` | `operator` + `virtual_desk` |
| Fallback primitives | `click`, `type`, `read_page`, `wait_for`, `screenshot` | Same + `dom_snapshot` (spatial queries) |
| Tab management | `virtual_desk` | + `switch_tab`, parallel tab execution |
| Card execution | Seed-card library, automatic matching | Same + operator hook pipeline |
| Observation | Ambient Context (DOM diffs inline) | Same + ambient page-context hooks |
| Legacy mode | `SILBERCUE_CHROME_FULL_TOOLS=true` (20 tools) | `SILBERCUE_CHROME_FULL_TOOLS=true` (23 tools) |

See the **[Benchmarks](#benchmarks)** section below for per-tool-call response-size numbers and head-to-head comparisons with Playwright MCP, Browser MCP, claude-in-chrome, and browser-use.

Pro costs €12/month. [Get a license on Polar.sh](https://polar.sh/silbercueswift/silbercuechrome-pro), then follow [Install Pro via Homebrew](#install-pro-via-homebrew) above — three commands, no manual download, no env-var editing. License keys arrive by email and are activated with `silbercuechrome activate <YOUR-LICENSE-KEY>`. (The `SILBERCUECHROME_LICENSE_KEY=...` env var still works as an alternative for non-Homebrew installs.)

## Tools

### Default mode — Operator (2 tools)

In the default Operator mode, your MCP client sees exactly two tools:

| Tool | Description |
|---|---|
| `operator` | The primary tool. **Two-call interface:** (1) Call without arguments to scan the current page — returns a structured page reading with matched action cards. (2) Call with `card` + `params` to execute a card — returns the result plus a fresh scan of the new page state. When no card matches, automatically switches to fallback mode. |
| `virtual_desk` | Lists all open tabs with stable IDs, connection status, and active-tab marker. Call first in every session for orientation. |

### Fallback mode (6 primitives)

When the operator scan finds no matching action card, SilbercueChrome automatically switches to fallback mode — six direct primitives appear in `tools/list`:

| Tool | Description |
|---|---|
| `virtual_desk` | Same as above — always available |
| `click` | Real CDP mouse events. Click by ref, selector, text, or coordinates. Response includes DOM diff. |
| `type` | Type into an input by ref/selector |
| `read_page` | Accessibility tree with stable `e`-refs. 10-30x cheaper than screenshots. |
| `wait_for` | Wait for element visible, network idle, or JS expression true |
| `screenshot` | WebP capture, max 800px, <100KB. Visual verification only. |

When the next operator scan matches a card again, SilbercueChrome switches back to operator mode automatically. Fallback is not an error state — it is a fully supported work mode for any page.

### Legacy mode (20+ tools)

Set `SILBERCUE_CHROME_FULL_TOOLS=true` to expose all individual tools (click, type, fill_form, read_page, navigate, screenshot, scroll, press_key, evaluate, run_plan, observe, wait_for, console_logs, network_monitor, file_upload, handle_dialog, tab_status, configure_session, and Pro tools). This is the v0.5.0-compatible mode for users who prefer direct tool access.

### Pro tier (additional)

| Tool | Description |
|---|---|
| `switch_tab` <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center"> | Open, switch to, or close tabs by ID from `virtual_desk` |
| `dom_snapshot` <img src="https://img.shields.io/badge/Pro-blueviolet?style=flat-square" align="center"> | Bounding boxes, computed styles, paint order, colors. For spatial questions `read_page` cannot answer. |

## Migrating from v0.5.0

If you have been using SilbercueChrome v0.5.0, here is what changed and what you need to do (short answer: nothing).

**What changed.** SilbercueChrome moved from a toolbox model (18-23 individual tools like `click`, `type`, `read_page`, `navigate`) to a card-table model. The LLM now sees two tools — `operator` and `virtual_desk` — instead of twenty. When the operator scans a page, it matches the page structure against a library of action cards (login forms, search bars, cookie banners, multi-step wizards) and offers them as annotated choices. The LLM picks a card, passes parameters, and the operator executes the entire sequence server-side.

**Why it changed.** Token efficiency and structural pattern recognition. With 20+ tools, the tool definitions alone consumed thousands of tokens in every MCP session. Worse, the LLM had to decide which primitive to call next at every step — leading to unnecessary evaluate calls, wrong tool choices, and spiral failures. The operator model cuts tool-definition overhead below 3000 tokens and replaces per-step LLM decisions with pre-validated card sequences.

**What you need to do.** Nothing. If you update to the new version, your existing workflows keep working through two mechanisms:

1. **Seed cards match common patterns automatically.** Login forms, search fields, cookie consent dialogs, and multi-step wizards are covered by the built-in seed-card library. The operator recognizes these and offers the right card without any configuration.

2. **Fallback mode catches everything else.** When no card matches — a proprietary intranet page, a custom dashboard, a niche web app — SilbercueChrome automatically switches to fallback mode. Six direct primitives (`click`, `type`, `read_page`, `wait_for`, `screenshot`, `virtual_desk`) appear in the tool list, and you work exactly like before.

**Tool mapping (old to new):**

| v0.5.0 tool | Operator mode equivalent |
|---|---|
| `navigate` + `read_page` + `click` + `type` | `operator()` — scan, pick a card, execute |
| `read_page` | Embedded in the operator's return (structured page reading with refs) |
| `click`, `type`, `fill_form` | Card execution (operator handles these internally) or fallback primitives |
| `run_plan` | `operator(card, params)` in standard mode, or `run_plan` via `SILBERCUE_CHROME_FULL_TOOLS=true` (legacy mode) |
| `screenshot`, `wait_for` | Available in fallback mode or legacy mode |
| `evaluate` | Available in legacy mode (`SILBERCUE_CHROME_FULL_TOOLS=true`) |

**Want the old tool set back?** Set `SILBERCUE_CHROME_FULL_TOOLS=true` as an environment variable. This exposes all 20+ tools exactly like v0.5.0. No other changes needed.

## Walkthroughs

### Migration: Marek upgrades from v0.5.0

Marek has been using SilbercueChrome v0.5.0 for three months. He has workflows that automate login flows and data extraction using individual tool calls.

**Before (v0.5.0) — individual tool calls:**

```
1. navigate({ url: "https://app.example.com/login" })
2. read_page({ filter: "interactive" })
3. type({ ref: "e5", text: "marek@example.com" })
4. type({ ref: "e7", text: "my-password" })
5. click({ ref: "e9" })           // Submit button
6. read_page({ filter: "all" })   // Check result
```

Six tool calls, six LLM decisions, six round-trips.

**After (Operator mode) — two calls:**

```
1. operator()
   → Returns: page reading + matched card "login-form"
     with slots: username, password, submit

2. operator({ card: "login-form", params: { username: "marek@example.com", password: "my-password" } })
   → Executes: fill username → fill password → click submit
   → Returns: new page state after login
```

Two tool calls, one LLM decision. The operator fills the form and clicks submit server-side.

**Fallback for unmatched pages:**

Marek opens a custom internal dashboard that has no matching card. The operator scan returns:

```
operator()
→ "No card matched the current page structure — switching to direct-primitive mode"
→ tools/list now shows: virtual_desk, click, type, read_page, wait_for, screenshot
```

Marek's LLM uses the familiar primitives — `read_page`, `click`, `type` — exactly like v0.5.0. When he navigates to a page with a matching card, SilbercueChrome switches back to operator mode automatically.

Your existing workflows keep working. The operator just makes them faster when a card matches.

### First Contact: Annika's first ten minutes

Annika has never used SilbercueChrome. She wants to automate a browser task from Claude Code.

**Step 1 — Install** (one command, takes 30 seconds):

```bash
claude mcp add --scope user silbercuechrome -- npx -y @silbercue/chrome@latest
```

Then fully quit and reopen Claude Code. That is the entire setup.

**Step 2 — Start:** Chrome launches automatically when Claude Code makes the first tool call. No port setup, no flags, no manual browser start.

**Step 3 — First scan:** Annika asks Claude: "Log me into my account on example.com."

```
Claude calls: virtual_desk({ navigate: "https://example.com/login" })
→ Chrome opens the login page

Claude calls: operator()
→ Operator scans the page, returns:
  - Page reading: "Login page — email field, password field, submit button"
  - Matched card: "login-form" (confidence: 0.91)
    Slots: username, password
```

**Step 4 — Card execution:** The operator matched a login-form card. Annika's LLM calls it with parameters:

```
Claude calls: operator({ card: "login-form", params: { username: "annika@example.com", password: "my-password" } })
→ Executes: fill email → fill password → click submit
→ Returns: new page state after login — "Dashboard — welcome, Annika"
```

Annika sees the result in Claude Code — logged in, dashboard visible. Total time: under 10 minutes from install to first successful browser task.

### Fallback: Jamal navigates an unknown site

Jamal is an experienced SilbercueChrome user. He opens a proprietary intranet page that no seed card covers.

**Operator scan — no match:**

```
operator()
→ Page reading: "Internal HR Portal — employee search, leave requests, payroll links"
→ Matched cards: (none)
→ "No card matched the current page structure — switching to direct-primitive mode"
```

This is not an error. The `tools/list` now shows six primitives.

**Working with fallback primitives:**

```
read_page()
→ e3: textbox "Employee search"
→ e5: button "Search"
→ e8: link "Leave requests"
→ e12: link "Payroll"

type({ ref: "e3", text: "Smith" })
click({ ref: "e5" })
→ Search results appear, DOM diff shows new elements
```

Jamal works exactly like he would with v0.5.0 — ref-based clicks and types, DOM diffs in responses.

**Automatic return to operator mode:**

Jamal clicks a link that leads to the company's standard login page. The operator detects the login-form pattern:

```
operator()
→ Page reading: "Company SSO Login"
→ Matched card: "login-form" (confidence: 0.92)
→ tools/list switches back to: operator, virtual_desk
```

Jamal picks the login card, passes credentials, and the operator handles the rest.

Fallback is not an error state — it is a fully supported work mode that covers any page.

## Benchmarks

Measured on `https://mcp-test.second-truth.com` — **35 tests in 5 levels** (Basics, Intermediate, Advanced, Hardest, Community Pain Points). Each run is independent, values on the benchmark page are randomized per page-load, all runs started in a fresh Claude Code session out of `/tmp` (no project context bias), and **all metrics measured post-hoc from the session JSONL** via [`test-hardest/measure-tool-calls.sh`](.claude/skills/benchmarkTest/measure-tool-calls.sh) — no self-reporting, no MCP-side instrumentation, just counting `tool_use` blocks and `tool_result` char lengths.

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
| `read_page` / `browser_snapshot` | **1.124 Chars** (21 calls) | 6.084 Chars (8 calls) | **SC 5.4× more compact per call** |
| `evaluate` / `browser_evaluate` | **510 Chars** (33 calls) | 2.155 Chars (47 calls) | **SC 4.2× more compact per call** |
| `type` / `browser_type` | **88 Chars** (13 calls) | 147 Chars (13 calls) | SC 1.7× more compact |
| `click` / `browser_click` | 1.278 Chars (63 calls) | **463 Chars** (44 calls) | Playwright 2.8× leaner — but see trade-off below |

**The Ambient-Context trade-off (worth understanding):** SC's `click` is 2.8× larger than Playwright's because every SC click response embeds the DOM diff (NEW/REMOVED/CHANGED lines). Playwright returns a bare confirmation, which means the LLM has to follow up with a `browser_snapshot` or `browser_evaluate` to see what happened. Over the full run, this cascade costs Playwright MCP **47 extra `browser_evaluate` calls**. Net result: SC's click+read_page+evaluate total is **120k chars vs Playwright MCP's 170k** — 30% less response content overall, despite the "thicker" click responses.

See [`test-hardest/BENCHMARK-PROTOCOL.md`](test-hardest/BENCHMARK-PROTOCOL.md) for the full protocol, per-test breakdown, and raw JSON runs with `tool_efficiency` blocks.

## Architecture

```
SilbercueChrome (Node.js MCP server, @silbercue/chrome)
├── @modelcontextprotocol/sdk (stdio transport)
├── CDP Client
│   ├── WebSocket transport (existing Chrome on :9222)
│   └── Pipe transport (auto-launched Chrome with --remote-debugging-pipe)
├── Auto-Launch: Chrome + optimal flags, visible by default
├── Operator Pipeline
│   ├── Signal Extractor (a11y-tree → page signals)
│   ├── Aggregator + Matcher (signals → card matches)
│   ├── Seed-Card Library (YAML action cards)
│   ├── State Machine (IDLE → SCANNING → AWAITING_SELECTION → EXECUTING)
│   └── Fallback Registry (automatic mode switch to 6 primitives)
├── A11y-tree cache + Selector cache
├── Session Manager (OOPIF support for iframes and Shadow DOM)
├── Tab State Cache (URL/title/ready across tabs)
└── 2 top-level tools (operator + virtual_desk)
    + 6 fallback primitives (click, type, read_page, wait_for, screenshot, virtual_desk)
    + legacy mode: 20+ tools via SILBERCUE_CHROME_FULL_TOOLS=true
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
| `SILBERCUE_CHROME_FULL_TOOLS` | `true` / `false` | `false` | Legacy mode: expose all 20+ individual tools instead of the 2-tool operator mode |
| `CHROME_PATH` | path | — | Path to Chrome binary (overrides auto-detection) |
| `SILBERCUECHROME_LICENSE_KEY` | license key | — | Pro license key (e.g. `SC-PRO-...`) |

## License

The core server, the operator pipeline, the seed-card library, and all fallback primitives are **MIT licensed** — see [LICENSE](LICENSE). Use them however you want, commercially or otherwise.

Pro features (switch_tab, dom_snapshot, parallel tab execution, ambient context hooks, operator hook pipeline) require a [paid license](https://polar.sh/silbercueswift/silbercuechrome-pro). The license validation code is in the separate private Pro repository.

## Contributing

Issues and pull requests welcome at [github.com/Silbercue/silbercuechrome](https://github.com/Silbercue/silbercuechrome).

## Privacy

SilbercueChrome runs entirely on your machine. All browser automation happens locally via CDP. No telemetry, no remote calls, no data sent to any third party.
