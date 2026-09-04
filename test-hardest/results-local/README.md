Acceptance runs for the shortened tool definitions (branch tool-defs-5k, commit 9c1e056; run 2 ran on commit 51b4a74, which adds only run 1's JSON — identical source).
Tool definitions on the wire: 4,990 tokens (chars/4, `npm run token-count`), down from 7,607 in v2.10.3.
Run 1: 30/30, 79 calls, 294 s. Run 2: 30/30, 79 calls, 289 s. Baseline v2.10.1: 30/30, 84/86 calls, 281/296 s.
Tool calls vs Playwright MCP 0.0.80 (Sep 2026, 137/151): -45%
First attempt on the shortened wording without the run_plan batching sentence: two runs, 30/30 each, 94 calls each (above the ≤ 90 gate) — the sentence was added and the runs repeated.

## Runs after the Codex acceptance fix wave (2026-09-04)

The tool texts changed again (rule statements restored, `view_page` as the last plan step now
returns the full page output), so run1/run2 above are historical only.

Run 3: 30/30, 82 calls, 284 s — commit 97971b1.
Run 4: 30/30, 99 calls, 318 s — commit 45bb50c (adds run 3's JSON only, identical source); the model batched `run_plan` only 17 times and sent
25 single clicks instead, above the <= 90 gate.
Adjustment: the batching sentence moved to the front of the `run_plan` description and the server
instructions now name the trigger (2+ known follow-up actions -> one `run_plan`), commit 385df7c.
Run 5: 30/30, 80 calls, 281 s — commit 385df7c.
Run 6: 30/30, 68 calls, 250 s — commit 0fe49e9 (adds run 5's JSON only, identical source).
Tool calls vs Playwright MCP 0.0.80 (Sep 2026, 137/151): -49% (mean 74).
