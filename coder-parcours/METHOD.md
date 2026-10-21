# Coder Parcours: method

Status: fixed before the baseline measurement. Rows marked **(to be filled at publication)** are filled in
the commit that publishes this document and are never changed afterwards without an entry under
"Changes after the trial run".

Published: **(to be filled at publication: date and commit)**

This document is written for people who want to repeat the measurement or attack it. Everything the
harness does is in this folder; commands are in [README.md](README.md).

## 1. What is measured

Four browser tools are driven by the same AI model through the same two kinds of task against the same
small web app. The app contains known problems. They are switched on by a seed and are not disclosed in
this document, in the harness prompts or in the app's front-end code.

- **Explore:** check one stated change, then explore the app at three window widths and report problems.
  Measured: was the change judged correctly, which known problems were found, how many false alarms and
  duplicates, whether a session-limited login was handled, cost.
- **Capture:** turn one flow into a test that runs without AI. Measured: is the test valid (see 5.4).

There is no overall score and no ranking. The results table lists participants in alphabetical order.
No claim of a winner is made by this document.

One disclosure: the maintainer of this repository also develops Public Browser, one of the participants.
That is a reason for the controls below (identical task texts, a different grader model, blinded grading,
a sealed part of the catalog, published raw logs), not a replacement for them.

## 2. Participants

Each participant is configured as its own documentation describes. Versions are pinned; the pinned values
are in `harness/participants.mjs` and `harness/toolchain/`. The Chrome version and the `claude` client
version of every session are stored in its result file.

| Participant | Kind | Version | Start |
|---|---|---|---|
| Public Browser | MCP server | 3.0.0 | `npx -y public-browser@3.0.0`; own Chrome on port 9333, visible window, fresh state folder per session, friction log off |
| Chrome DevTools MCP | MCP server | 1.11.0 | `npx -y chrome-devtools-mcp@1.11.0 --isolated --executable-path <chrome>`; usage statistics off |
| agent-browser | command line | 0.39.1 | `agent-browser`, visible window, Chrome via `AGENT_BROWSER_EXECUTABLE_PATH`; its own skill texts (core and `dogfood`) |
| Playwright CLI | command line | `@playwright/cli` 0.1.22 | `playwright-cli`, isolated in-memory profile, visible window, Chrome via `executablePath` |

All participants use the same Chrome binary (`CODER_PARCOURS_CHROME` or the default for the platform),
except that Chrome DevTools MCP and Public Browser receive it through their own documented options. Capture
sessions can additionally use Playwright Test 1.64.1 and the Python package `publicbrowser` 2.0.0
(with `websockets` 16.1.1), which are installed for everybody.

Differences in what each participant ships, stated as facts:

- Command-line participants get the skill files of their pinned package (agent-browser: core skill, the
  `dogfood` skill with its issue taxonomy and report template, and the files they link; Playwright CLI: its
  skill and the linked reference files). They are copied unchanged into the session folder
  (`skill/`) and appended to the system prompt; a short preface says where the files are and what
  `{SKILL_DIR}` means. MCP participants get no skill text, only their tool descriptions. The `dogfood` skill
  is a bug-hunting procedure; the others have no equivalent.
- Command-line participants may read image files inside the session folder (screenshots they took).
  MCP participants receive images directly in the tool result. No participant may read other files.
- The task text is identical for all participants except the name of the tool.

### 2.1 Capability matrix: setting the three window widths

Determined from the tool list of the pinned MCP version (`tools/list`, recorded in each result as
`server_info`) or from the skill text of the pinned CLI version.

| Participant | How 390 / 768 / 1440 px can be set |
|---|---|
| Public Browser 3.0.0 | No tool for window size or viewport in its tool list. The browser starts with its default emulated size. A participant can only change the width indirectly (for example by running script in the page), which is not documented as a feature. |
| Chrome DevTools MCP 1.11.0 | Tools `resize_page` (window size) and `emulate` (viewport, device pixel ratio, mobile/touch emulation). |
| agent-browser 0.39.1 | `agent-browser set viewport <width> <height>`. |
| Playwright CLI 0.1.22 | `playwright-cli resize <width> <height>`. |

Consequence, decided before measuring and not explained afterwards: problems that appear only at phone or
tablet width are harder to reach for Public Browser than for the other three. A large part of the public
catalog is purely visual (layout and styling) and can be found only by screenshot, geometry measurement or
computed style, and many of those only at phone or tablet width. All four participants can take
screenshots. The results table reports hits by width class so that this effect is visible.

## 3. Model, grader and prompts

- **Agent model:** one model, pinned by identifier prefix (`claude-opus-5`). The exact model ID returned by
  the first session of a round must be the same in every session of the round; if it changes the round
  stops, and the affected sessions are re-run. The ID is printed in the results table.
- **Grader:** an independent model (`sonnet` alias of the `claude` client; the harness refuses a grader that
  reports the agents' model). It runs with the flags `GRADER_FLAGS`: `--setting-sources project
  --strict-mcp-config --mcp-config <empty config> --tools ""`, in an empty temporary folder, with provider
  keys removed from the environment. One grader model and one prompt per round: mixed configurations stop
  scoring. The grader prompt is `harness/grader-prompt.md`.
  sha256 of `harness/grader-prompt.md`: **(to be filled at publication)**
  Grader model ID: reported in the results table.
- **Task texts:** `harness/prompts/explore.md` and `harness/prompts/capture.md`, quoted in full in section
  11. They contain no hint about the kinds of problems.
- The grader sees, for each explore session, the active bugs with the title, symptom and grading note
  of the catalog, up to five **distractors** (inactive bugs, at a width drawn from their own widths), the
  decoys that apply (section 4.3) and the findings. Active bugs, distractors and unplanned bugs are one
  id-sorted list with identical fields, so the grader cannot tell which are active. The participant's name,
  tool names and tool-specific references are replaced in the findings before grading.

## 4. Seeds and the catalog

### 4.1 Seeds

Five seeds, in `harness/seeds.json`: 2601, 2602, 2603, 2606, 2611. Every participant runs every seed in both
session types: 5 x 4 x 2 = 40 sessions per round. The trial run uses the first seed only (8 sessions).

### 4.2 Active bugs per seed

- The public catalog is a pool of bugs. Each bug belongs to one category (`fiddly`, `next-step`, `layout`,
  `function`, `timing`, `background`), applies to one or more parts of the app and to one or more width classes
  (phone up to 600 px, tablet 601 to 1100 px, desktop from 1101 px, or all).
- Number of active bugs in an explore session: `round(0.4 x pool size)`, plus one of -1, 0 or +1
  (one pseudo-random draw), at least 1.
- The public part is **stratified**: at least one bug that applies at each width class, and at least one of
  the categories `fiddly` and `next-step`, and, if the pool has one, one bug that needs a particular situation
  to be passed (see "silent bypass" in section 6), where the pool allows; the rest is filled at random.
- Pseudo-random numbers come from `sha256(seed + ":" + purpose)`, one stream per purpose. The streams for the
  **public** part and for the **sealed** part are separate, so the public activations of a seed are
  identical whether or not the sealed part is loaded. The public activations are therefore the same in the
  baseline measurement (phase 1) and in the final measurement (phase 3).
- Change target of the explore task: one public bug with a described feature. The seed alone decides
  (probability 0.5) whether the feature is broken in that session. A finding about the change target counts
  neither as a hit nor as a false alarm.
- Capture task: one public bug defines the flow; the capture check (5.4) switches it on in one of the
  three runs.
- A seed never changes between rounds. The catalog may grow between phases; the fingerprint (section 8)
  shows what changed.

Pool sizes **(to be filled at publication)**: public pool: `<n>` bugs; sealed part: `<n>` bugs (one third
of the whole catalog is sealed).

### 4.3 Decoys

Decoys are places that look odd but behave correctly (for example something disabled that explains why).
Reporting one counts as a false alarm. Each decoy lists bugs it conflicts with (`conflicts`), and each bug
may list decoys whose explanation it removes (`removesDecoys`). A decoy is only used in a session if none
of its conflicting bugs is active **and** no active bug removes it, so the rule holds in both directions.
Sealed bugs must declare `removesDecoys`.

### 4.4 Healthy behaviour is not a finding

Expected validation answers of the app (a wrong password, a duplicate registration, an invalid coupon code
answered with a 4xx status) are normal web behaviour and not findings; the grader treats them the same for
everybody. The healthy app produces no console errors and no failed requests otherwise (guarded by tests).

## 5. Session mechanics

### 5.1 Isolation

Each session runs in a fresh folder, with a fresh app instance on a free port, a fresh browser profile and
a fresh `claude` session with strict tool lists. Environment variables beginning with `PUBLIC_BROWSER_` or
`SILBERCUE_`, and provider keys, are removed from the environment the tools inherit. The test accounts are
in the task text.

### 5.2 Tool restrictions in the `claude` client

The agent may use Write, its own browser tool and a short list of commands. MCP participants: only their
own MCP tools and Write (in capture: also the command `run-my-test`). Command-line participants: Write,
Read (images inside the session folder only), Bash limited to their own command plus the helpers their
skill needs (`mkdir`, `cp` only with paths inside the session folder; `sleep` for agent-browser) and, in
capture, `run-my-test`. A pre-tool hook rejects command substitution, file redirection and everything
else. Violations abort the session (it is re-run).

### 5.3 Beacons

The app sends the same-looking signal on every click (random id; the harness maps it to a bug with a short
MAC). Someone who only watches the network traffic cannot learn where bugs are. **Residual risk:** the key
is in the delivered script, so a participant that reads that script could rebuild beacons, and the CSS
of a bug is in the page. The task text forbids reading the app's script files, and after each session the
harness searches the tool calls and tool results for such reads and records the flag
`read_bug_script` in the result and in the table.

### 5.4 Capture check

The agent writes its test files and a one-line command into `RUN`. `run-my-test` (the only way to run it
during the session) executes the command with the test folder as working directory and the app address
in `APP_URL`. After the session the harness runs the test three times, each time on a fresh copy of the test
folder and a fresh app, two healthy and one broken, with the position of the broken run drawn from the seed and a random salt per
check (so it cannot be predicted from anything the agent sees). The environment is reduced to a whitelist with its own HOME and
TMPDIR per run; the variant is not visible to the test. A capture is **valid** if the test exits 0 on both
healthy runs and non-zero on the broken run, and it really used the app (requests to pages or the API,
counted by the app in memory; a health check alone does not count). Invalid reasons are recorded
(`RUN` missing, ports busy, timeout, test did not exercise the app, healthy run failed, healthy run flaky,
broken run passed).

### 5.5 Ports

Capture sessions need ports 9222 and 9223 free at session start; otherwise the session is aborted and
re-run. Public Browser runs its own Chrome on port 9333. After a capture session the harness ends
processes that listen on 9222/9223 or run Chrome with that debugging port **and were not present at session
start**, because a test that connects through `publicbrowser` may leave a browser behind that Public Browser
does not close itself.

## 6. Metrics

Per explore session, from the grader's matches and the stored events:

- **Hit rate:** hits / active bugs. Active bugs exclude the change target. The first finding that is matched
  to a bug is a hit; further findings for the same bug are **duplicates** and count nowhere else.
- **Hits by category / by width class:** hits / active bugs, summed over sessions.
- **False alarms:** findings matched to a decoy, plus findings the maintainer decided to be false alarms
  (section 7). Findings still undecided are counted separately as **unreviewed**.
- **Change verdict:** the verdict "works" or "broken" compared with the truth of the seed; **false "works"**
  is the verdict "works" where the feature was broken.
- **Silent bypass:** for bugs of the category `timing` that have a recorded situation the agent must pass
  through: reached, reported (a hit), passed without a report, got stuck, not reached. The table shows
  silently passed / reached.
- **Login:** whether a login led to an authenticated successful request, how many logins were made, and for
  sessions where the app ends the login session: whether the agent logged in again afterwards.
- **Capture valid:** x of n.
- **Integrity flags:** sessions that read the bug script (5.3); capture tests that touched things outside
  their folder (5.6).
- **Cost:** tokens (de-duplicated), tool calls, wall clock and list price in USD, per participant, shown
  separately for explore and capture with the median and range over sessions. The cost table also includes
  the grader (every call, including failed ones), as a separate line and as a total with the agents.
- **Human reference:** for seeds that a human tester played, the agent's hits relative to the human's hits
  and the share of the human's hits the agent also found. Human rows have no cost.

## 7. Review and leniency

- The grader's answers are not final for **open findings**: findings that match nothing in the catalog
  are listed blinded and shuffled (participant and tool names replaced) for the maintainer, who decides
  per finding: false alarm; an existing bug the grader missed; or a new bug not planned in the catalog
  (which is then added to the list of unplanned bugs for that seed and counts for everybody with that
  seed, after a regrade). Decisions are stored with a key bound to the text of the finding; if the finding
  changes, the decision is reported as stale and not applied.
- A **sample** of grader answers (20, low confidence first, a quarter of them "no match" answers) is
  checked by hand, also blinded. The agreement rate is published with the table.
- All decisions are stored in `results/<round>/review/` and published.

## 8. Fingerprint and changes after the trial run

Every round starts by writing `results/<round>/fingerprint.json`: checksum of the public catalog files,
decoys and seeds; checksum of the sealed file (`missing` if it is absent); checksums of the task texts and
the grader prompt; per participant a checksum over package, version, start command and skill files; and the
budgets. `node harness/fingerprint.mjs --compare <a> <b>` compares two fingerprints; resuming a round with
a different fingerprint stops. Mixed grader models or participant versions inside a round stop scoring.

Budgets (per session, from `harness/prompt.mjs`): explore 120 tool calls told to the agent, hard limit 160
turns and 45 minutes; capture 60 tool calls told, hard limit 80 turns and 25 minutes.

### Changes after the trial run

The trial run (one seed, 8 sessions) does not count in the results. Only budgets may differ between its
fingerprint and the baseline fingerprint; every other difference is listed here with its reason.

| Field | Trial run | Baseline | Reason |
|---|---|---|---|
| budgets | (to be filled at publication) | (to be filled at publication) | (to be filled at publication) |
| all other fields | identical | identical | (to be filled at publication; list each difference with its reason) |

## 9. The sealed part

About one third of the catalog is sealed. It was written by a separate session from the one that builds
the public parts, encrypted to a public key committed in `secret/recipient.pub` (X25519 key agreement,
HKDF-SHA256, AES-256-GCM) and stored as `secret/sealed.bin`. The private key is encrypted with a
passphrase of at least 20 characters, held only by the maintainer.

sha256 of `secret/sealed.bin`: **(to be filled at publication)**

- The baseline measurement (phase 1) runs **without** the sealed part. Phase 3 unseals it, adds it to the
  active bugs by the rule in 4.2 (a separate random stream, so the public activations stay the same) and
  measures again. After the final measurement the sealed part is published.
- Unsealing requires `--expect-sha256` with the checksum from the author's reply (not the file in the
  repository), refuses to write into a git working tree, and needs the passphrase.
- **Frozen until phase 3:** `app/` and `server/` stay unchanged from the moment the sealed part was
  written, because its bugs target this surface. The sealed package contains its own check spec that
  phase 3 runs after unsealing and before measuring; it shows whether a later change made a sealed bug
  ineffective. Any change to `app/` or `server/` before phase 3 is listed here: **(none so far)**.

## 10. Human reference run

People test the same app: one seed per person, explore only, 30 to 45 minutes, in Chrome on a computer at
the same three fixed widths, in the same seed state as the agents (the hosted app builds the explore
configuration of the seed, including whether the change target is broken). They get no hint about the
catalog and report through a "Report a problem" button; instructions in [HUMANS.md](HUMANS.md). The
maintainer plays first, before seeing the catalog or any graded file. Human findings go through the same
grader and review. The run does not count toward the agents' results; it is a reference.

## 11. Task texts (verbatim)

Placeholders in double braces are filled per session: the app address, the tool name (`the <cli> command`
or `the <name> MCP tools`), the two test accounts, the change or flow description, the call budget, report
path and test folder.

### Explore

```
You are testing a web app for a developer. It runs at {{APP_URL}}. Use {{TOOL_NAME}} to control the browser.
Test accounts: {{ACCOUNTS}}

Part 1 — check a change. The developer says: "{{CHANGE}}"
Find out whether this works. Decide "works" or "broken" and back it up with what you did and what you saw.

Part 2 — explore. Use the app the way real visitors would, at three screen widths: phone (390 px wide), tablet (768 px) and desktop (1440 px). You may use several tabs or windows at the same time. Report every problem you notice. Do not report things that work as intended. Do not read the app's source code or script files; judge only what you see and what the browser shows you.

Budget: about {{BUDGET}} tool calls. Write the report early and overwrite it after every new finding, so nothing is lost if you run out of budget.
Only the report file below counts. You may keep screenshots or notes of your own, but they are not read.
Report file: {{REPORT_PATH}} (JSON, exactly this shape):
{"change_check":{"verdict":"works|broken","evidence":"..."},"findings":[{"title":"...","where":"page or area","viewport":"phone|tablet|desktop|all","steps":"...","expected":"...","actual":"...","severity":"low|medium|high"}]}
```

### Capture

```
A developer wants an automated regression test for a web app that runs at {{APP_URL}}. Use {{TOOL_NAME}} to look at the app.
Test accounts: {{ACCOUNTS}}

Turn this flow into a test that runs without AI: "{{FLOW}}"
Use any tool you like: Playwright Test (@playwright/test is installed), a shell script, Python with the publicbrowser package, or your browser CLI. Put all test files into {{TEST_DIR}} and write the one shell command that runs the test into {{TEST_DIR}}/RUN. The command runs with {{TEST_DIR}} as working directory and gets the app address in the environment variable APP_URL; do not hard-code the address. Every run starts a fresh copy of the app, so the test must log in by itself. Exit code 0 means the flow works, any other exit code means it is broken. Your test will later also run against other builds of the app.
Do not read the app's source code or script files; your test may use the app only through the browser and its web address.

You may run the command `run-my-test` (no arguments) as often as you like; it runs your test against the app and prints the exit code and output. No other shell commands are available.
Budget: about {{BUDGET}} tool calls.
```

In smoke mode (harness self-test only, never in a measured round) one more sentence asks for a minimal run.

## 12. Raw data

Result files (sessions, graded, review decisions, fingerprint, scoreboard) are published immediately after
each round. The raw session logs (`raw/`) are published with the final measurement (phase 3), after the
sealed part is made public, because they contain what the agents saw and did. Home directory paths in them
are replaced by `~`.

## 13. Known limits

- **`run-my-test` runs arbitrary commands** of the agent on the measuring machine, as the measuring user, **without
  a sandbox** (restricted environment, own HOME and TMPDIR, fresh copy of the test folder, but no isolation).
  A test could read files of the user or keep a counter at an absolute path outside its folder. Mitigation:
  after each session the harness searches the test files, `RUN` and the protocol for the paths of the
  harness, the results folder, any secret folder, `runtime.js`, the home directory and process listings, and sets the flag
  `capture_outside_access`. It is a search, not a guarantee. Raw logs are published for that reason.
- **Tool lock of the `claude` client.** The restrictions in 5.2 rest on the client's permission rules and
  a hook. A hole there would show in the raw logs; it is not proven absent.
- **Ports.** Capture sessions require free ports 9222 and 9223 at the start. A browser the user starts there
  during a run is ended afterwards, as it cannot be told apart from a test leftover.
- **Beacons and CSS** can be read by someone who reads the delivered script (5.3).
- **Grader.** One model grades; a sample is checked by hand, not every answer. The grader sees distractors.
- **Window widths** are not equally available to all participants (2.1).
- **Chrome only, Claude only.** No other browsers, no other agent models, no mobile devices (widths are
  emulated or set by window size).
- **Five seeds, one model, one app.** Small numbers; the table shows ranges, not significance.
- **Maintainer disclosure** as in section 1.
- Other published bug sets could be added later as additional catalogs. None are included.
