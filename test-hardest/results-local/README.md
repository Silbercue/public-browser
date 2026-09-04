Acceptance runs for the shortened tool definitions (branch tool-defs-5k, commit 9c1e056; run 2 ran on commit 51b4a74, which adds only run 1's JSON — identical source).
Tool definitions on the wire: 4,992 tokens (chars/4, `npm run token-count`), down from 7,607 in v2.10.3.
Run 1: 30/30, 79 calls, 294 s. Run 2: 30/30, 79 calls, 289 s. Baseline v2.10.1: 30/30, 84/86 calls, 281/296 s.
Tool calls vs Playwright MCP 0.0.80 (Sep 2026, 137/151): -45%
First attempt on the shortened wording without the run_plan batching sentence: two runs, 30/30 each, 94 calls each (above the ≤ 90 gate) — the sentence was added and the runs repeated.
