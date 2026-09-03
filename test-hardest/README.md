# Benchmark raw data

This folder holds every benchmark run behind the numbers in the main README — including the runs Public Browser loses. The benchmark page itself is live at https://mcp-test.second-truth.com; its source is not part of this repository (the author's decision). Every September run JSON carries `suite.html_sha256`, so a run can be tied to one version of that page — all seven September runs share `81e4b7aa…bed2`.

## Three data sets

| Files | Suite | When | Driver model | How it was run |
|---|---|---|---|---|
| `benchmark-*.json` | 24 tests (4 levels) | 2026-04-05 | Claude Opus 4.6 | interactive Claude Code session from `/tmp`, one MCP at a time |
| `results/*-run*.json` dated April 2026 | 35 tests, 31 scored (T5.3–T5.6 runner-only; files vary, see below) | 2026-04-09 … 04-12 | Claude Opus 4.6 | same; competitor versions were not recorded (`mcp_version: null`) |
| `results/*-run*.json` with `"harness": {"mode": "blind-print"}` | 35 tests, **30 scored** | 2026-09-03 | Claude Opus 5 (`claude-opus-5`) | `blind-run.mjs`, see below; package versions pinned and recorded |

Cross-suite comparisons are not valid. Compare rows only within one data set. The April files are also internally uneven: `silbercuechrome-pro-run9.json` reports `37/31` — its `.tests` object holds 41 entries (37 `pass`, 4 `skip`) while `summary.counted` says 31 — and `-run8.json` counts 30 with 35 entries. Treat these as dev-session artefacts. They are kept unedited as they were written.

## Why 30 of 35 in the September runs

T5.3–T5.6 can only be started by the page's own runner, not by an agent. T4.7 grades a token count the agent reports about itself, which is a property of one server's API rather than a browser capability, so it was dropped for everyone. (April runs still counted T4.7, hence "/31" there.)

## File names: `silbercuechrome-pro-*` and `silbercuechrome-free-*`

These are Public Browser runs. The project was called SilbercueChrome until 2026-04-26 and briefly had a paid "Pro" tier; that tier was discontinued and everything is MIT-licensed and free since. Files keep their original names because notes and protocols reference them. New runs are named `public-browser-runN.json`.

## How the September runs were made

`blind-run.mjs` starts one fresh Claude Code session per run in print mode (`claude -p`) from an empty `/tmp` directory: no CLAUDE.md, no skills, no plugins, exactly one MCP server (`--strict-mcp-config`), and the built-in tool set cut down to `Write` via `--tools Write` — so the session has that one server's tools plus `Write` and nothing else. Every run records `harness.tool_lock.non_mcp_executed`; it is empty in all seven official runs. The prompt is identical for every server (`blind-prompt.md`). Public Browser runs with an empty pattern store (`PUBLIC_BROWSER_CORTEX_DIR` fresh, community patterns only) and telemetry off.

Every MCP server may send an `instructions` string in the handshake, and Claude Code passes it to the model: Public Browser sends 1,601 characters of tool guidance (among other things, a pointer to `run_plan`), Playwright MCP and Chrome DevTools MCP send none (`mcp_server_info.instructions: null`). That is within the rules for all of them, but it does influence the call counts.

Browser profiles differ per server and are recorded in `harness.profile_isolation`:

| Server | `harness.profile_isolation` |
|---|---|
| Public Browser | auto-launched Chrome, fresh temp user-data-dir, CDP port 9333 |
| Playwright MCP | `--isolated` (in-memory profile) |
| Chrome DevTools MCP | `--isolated` (temp user-data-dir) |
| browser-use | default browser-use profile (**not** isolated) — its `--mcp` mode bypasses the profile flags |

Metrics are measured after the run from the session transcript (`measure-tool-calls.sh`, `measure-session-cost.sh`): tool calls, response sizes and latencies come from counting `tool_use`/`tool_result` blocks, nothing is self-reported by the servers. `tool_efficiency` only counts tools of the benchmarked server; `non_mcp_calls` lists everything else.

What "duration" means: `summary.duration_s` is the page's own timer — it starts with the first test the agent begins and stops when the export button is clicked. Server start, `npx` cold start, Chrome start and the first navigation are **not** in it. The harness additionally records `harness.wall_clock_s` for the whole run: Public Browser 331 / 346 s, Playwright MCP 501 / 527 s, Chrome DevTools MCP 583 / 597 s, browser-use 2071 s. The ranking is the same either way.

Two runs each for Public Browser, Playwright MCP and Chrome DevTools MCP. browser-use has **one** run: the rule set before the session was "a second run only if the first finishes under 30 minutes", and it took 34.

Absolute paths in `harness.run_dir` and `harness.flags` are machine-local (`/tmp/bench-*`) and irrelevant to the numbers.

Reproduce: `node blind-run.mjs run playwright-mcp` (needs Claude Code CLI, Node 22, jq, Google Chrome). It also needs an account with access to `claude-opus-5` — the model is hard-pinned, a session that falls back to another model aborts the run. Binaries and the output directory are overridable through `BLIND_RUN_CLAUDE_BIN` (default `~/.local/bin/claude`), `BLIND_RUN_CHROME_BIN` (default the `/Applications` Chrome), `BLIND_RUN_BROWSER_USE_BIN` and `BLIND_RUN_RESULTS_DIR`. The live page must still serve exactly the 35 test IDs the harness expects, otherwise the run stops with `suite fingerprint mismatch`. `node blind-run.mjs compare` prints the comparison table from `results/`.

## Environment (September runs)

macOS `darwin 25.6.0` · Claude Code `2.1.259` · Node `v22.14.0` · Google Chrome `152.0.7977.65` (the `/Applications` binary the harness measured; browser-use launches its own browser, whose version is not captured) · model `claude-opus-5` · authenticated through a Claude subscription, not an API key. The harness has only been tested on macOS. All values come from the run JSONs (`harness.os`, `harness.claude_code_version`, `harness.node`, `chrome_version`, `model`).

## What changed since April

Playwright MCP 0.0.80 now returns **smaller** responses than Public Browser: Ø 740 / 656 chars per call versus 1298 / 1214, and its `browser_snapshot` averages 1911 / 2269 chars against `view_page` at 2841 / 3398. The April data does not support a clean reversal statement: `tool_efficiency.avg_response_chars` is 1467 (`playwright-mcp-run3`) and 1216 (`-run4`) against a spread of 576 to 2913 across the nine `silbercuechrome-pro-run*` files — six of them above Playwright's 1467, three below its 1216. Public Browser's remaining lead is in tool calls (84 / 86 versus 137 / 151 Playwright and 156 / 172 DevTools) and in page duration (281 / 296 s versus 468 / 493 s and 547 / 558 s; wall clock 331 / 346 s versus 501 / 527 s and 583 / 597 s). Per-call click latency is mixed rather than a clean win: `by_tool.avg_ms` for click is 90 / 435 ms (Public Browser), 625 / 669 ms (Playwright), 251 / 260 ms (DevTools).

browser-use's 15.8M response characters come almost entirely from `browser_screenshot` (Ø 283883 chars) and `browser_get_state` (Ø 102819) returning raw payloads into the transcript. These are characters, not tokens: the bulk of them are base64 image payloads counted at their base64 length, and images are priced differently from text.

## Current comparison (2026-09-03)

The `compare` output below is pasted verbatim from `node blind-run.mjs compare`. The main table lists runs whose harness status is `ok`; a second table "Aborted or incomplete runs" appears only for runs that crashed or timed out — there were none, so it is absent here. Note that `browser-use-run6` has status `ok` but `complete: false` (`notes: "incomplete: T3.5,T4.5"`): those two tests were never run, so its 24/30 is one incomplete run, not a clean loss. All "response" columns are characters, not tokens — browser-use's 15800k are mostly base64 image payloads counted at their base64 length.

| MCP | Version | Model | Date | Run | Status | Passed | Duration | MCP calls | Response total | Ø response | P95 | Snapshot tool Ø |
|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| browser-use | 0.12.5 | claude-opus-5 | 2026-09-03 | browser-use-run6 | ok | 24/30 | 2023s | 276 | 15800k | 57244 | 321033 | 102819 (18×) |
| Chrome DevTools MCP | 1.8.0 | claude-opus-5 | 2026-09-03 | chrome-devtools-mcp-run3 | ok | 29/30 | 547s | 156 | 149k | 954 | 5676 | 4718 (12×) |
| Chrome DevTools MCP | 1.8.0 | claude-opus-5 | 2026-09-03 | chrome-devtools-mcp-run4 | ok | 29/30 | 558s | 172 | 120k | 696 | 5271 | 3593 (14×) |
| Playwright MCP | 0.0.80 | claude-opus-5 | 2026-09-03 | playwright-mcp-run5 | ok | 30/30 | 468s | 137 | 101k | 740 | 3617 | 1911 (17×) |
| Playwright MCP | 0.0.80 | claude-opus-5 | 2026-09-03 | playwright-mcp-run6 | ok | 30/30 | 493s | 151 | 99k | 656 | 1587 | 2269 (14×) |
| Public Browser | 2.10.1 | claude-opus-5 | 2026-09-03 | public-browser-run1 | ok | 30/30 | 281s | 84 | 109k | 1298 | 6077 | 2841 (16×) |
| Public Browser | 2.10.1 | claude-opus-5 | 2026-09-03 | public-browser-run2 | ok | 30/30 | 296s | 86 | 104k | 1214 | 6479 | 3398 (16×) |

**browser-use 0.12.5 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__browser-use__browser_click | 75 | 47 | 60 |
| mcp__browser-use__browser_get_html | 73 | 392 | 1383 |
| mcp__browser-use__browser_screenshot | 49 | 283883 | 395893 |
| mcp__browser-use__browser_type | 22 | 62 | 68 |
| mcp__browser-use__browser_get_state | 18 | 102819 | 279476 |

**Chrome DevTools MCP 1.8.0 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__chrome-devtools__evaluate_script | 60 | 1069 | 6155 |
| mcp__chrome-devtools__click | 57 | 386 | 1357 |
| mcp__chrome-devtools__fill | 12 | 62 | 62 |
| mcp__chrome-devtools__take_snapshot | 12 | 4718 | 5671 |
| mcp__chrome-devtools__press_key | 4 | 60 | 62 |

**Chrome DevTools MCP 1.8.0 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__chrome-devtools__click | 62 | 593 | 5291 |
| mcp__chrome-devtools__evaluate_script | 62 | 488 | 1348 |
| mcp__chrome-devtools__take_snapshot | 14 | 3593 | 5630 |
| mcp__chrome-devtools__fill | 13 | 62 | 62 |
| mcp__chrome-devtools__press_key | 10 | 64 | 68 |

**Playwright MCP 0.0.80 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__playwright__browser_click | 58 | 354 | 381 |
| mcp__playwright__browser_evaluate | 26 | 1223 | 3617 |
| mcp__playwright__browser_snapshot | 17 | 1911 | 7082 |
| mcp__playwright__browser_type | 12 | 173 | 181 |
| mcp__playwright__browser_run_code_unsafe | 8 | 781 | 1029 |

**Playwright MCP 0.0.80 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__playwright__browser_click | 60 | 358 | 381 |
| mcp__playwright__browser_evaluate | 43 | 755 | 1554 |
| mcp__playwright__browser_snapshot | 14 | 2269 | 7082 |
| mcp__playwright__browser_type | 12 | 171 | 162 |
| mcp__playwright__browser_run_code_unsafe | 6 | 701 | 934 |

**Public Browser 2.10.1 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__public-browser__evaluate | 22 | 1913 | 5684 |
| mcp__public-browser__run_plan | 22 | 372 | 487 |
| mcp__public-browser__view_page | 16 | 2841 | 9734 |
| mcp__public-browser__click | 13 | 760 | 1535 |
| mcp__public-browser__observe | 3 | 108 | 122 |

**Public Browser 2.10.1 — top tools**
| Tool | Calls | Ø chars | P95 chars |
|---|---:|---:|---:|
| mcp__public-browser__run_plan | 29 | 345 | 580 |
| mcp__public-browser__evaluate | 21 | 966 | 2985 |
| mcp__public-browser__view_page | 16 | 3398 | 9734 |
| mcp__public-browser__click | 11 | 1512 | 1536 |
| mcp__public-browser__observe | 2 | 103 | 70 |

