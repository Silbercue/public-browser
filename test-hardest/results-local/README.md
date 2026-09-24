# Local acceptance runs

Acceptance runs for the shortened tool definitions (branch tool-defs-5k, commit 9c1e056; run 2 ran on commit 51b4a74, which adds only run 1's JSON — identical source).
Tool definitions on the wire: 4,990 tokens (chars/4, `npm run token-count`), down from 7,607 in v2.10.3.
Run 1: 30/30, 79 calls, 294 s. Run 2: 30/30, 79 calls, 289 s. Baseline v2.10.1: 30/30, 84/86 calls, 281/296 s.
Tool calls vs Playwright MCP 0.0.80 (Sep 2026, 137/151): -45%
First attempt on the shortened wording without the run_plan batching sentence: two runs, 30/30 each, 94 calls each (above the ≤ 90 gate) — the sentence was added and the runs repeated.

## Runs after the acceptance fix round (2026-09-04)

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

## Friction fixes FR-050 to FR-052 (2026-09-14)

Gate: 30/30 and <= 90 calls; one repeat run allowed, the gate applies to the last run.
Run 7: 30/30, 70 calls, 223 s — commit a99a2d0. Gate met.

## Series of 2026-09-23/24: stage 1 (security, loud errors) and stage 2 (shorter responses)

Reference: `../results/baseline-2026-09-aufschliessen.json` — Public Browser 2.10.6 vs agent-browser 0.38.1, n=5 each.
Stage 1 acceptance: `acceptance-stage1-c86f5ad.json` (runs public-browser-run8–12, PASS).
Stage 2 acceptance, first attempt: `acceptance-stage2-aeeef65.json` (runs public-browser-run13–17, FAIL — the TRUNCATED marker pointed to the very call that had produced it).
Stage 2 acceptance after the fix: `acceptance-stage2-366c194.json` (runs public-browser-run18–22, PASS) — local build at commit 366c194, which is the code of 3.0.0.
`mcp_version` in these files reads 2.10.6 because they were measured before the version bump.
