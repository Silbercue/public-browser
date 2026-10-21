# Coder Parcours

A measurement setup for browser tools that AI coding agents use. It answers one question: when an agent
checks a web app the way a developer would, how many of the real problems does it find, and can it turn a
flow into an automated test that holds up?

The app is a small yoga studio site ("Stillwater Yoga"): schedule, class pages, cart, checkout, accounts,
bookings. Known problems ("bugs") are switched on per seed, a fixed integer that decides which ones are
active, where and at which window width. Every participant gets the same seeds and the same task text.

Why a second benchmark next to `test-hardest/`: `test-hardest/` measures whether a tool can operate
difficult pages (cost and success per task). This one measures whether a tool lets an agent notice what is
wrong with an app it did not write, and whether a recorded flow survives as a test. The two do not share
scoring.

The full method, including its limits, is in [METHOD.md](METHOD.md). Human testers use
[HUMANS.md](HUMANS.md).

## Two session types

- **Explore.** The agent first checks one stated change ("works" or "broken"), then explores the app at
  phone (390 px), tablet (768 px) and desktop (1440 px) width and writes a JSON report of everything it
  considers a problem.
- **Capture.** The agent turns one flow into a test that runs without AI and writes the command that runs
  it into a `RUN` file. The harness then runs that test against three fresh copies of the app: two
  healthy and one with the flow broken. The capture is valid if the test passes on both healthy copies and
  fails on the broken one.

## Start the app with one command

```bash
cd coder-parcours
./start.sh                 # first seed from harness/seeds.json, port 4300
./start.sh --seed 2602 --port 4301
```

It installs dependencies (`npm ci`) and builds the front end on first use, then prints the address. Add
`?report=1` to the address to show the "Report a problem" button (see HUMANS.md).

## Re-measure everything

Requirements: Node 24 or newer (the participant `agent-browser` declares `node >= 24`), Google Chrome,
the `claude` command-line client logged in with a subscription or API access, `python3`, `jq`, `lsof`.
Tested on macOS; Linux is supported (a visible display is required, browsers run with a window).

```bash
cd coder-parcours
node harness/setup.mjs                      # install the pinned tool chain (npm packages, Python venv)
node harness/doctor.mjs                     # check the machine; fix everything that says FAIL

node harness/round.mjs run --round my-round              # 5 seeds x 4 participants x 2 session types = 40 sessions
node harness/round.mjs run --round my-trial --probe      # first seed only (8 sessions)
node harness/round.mjs run --round my-round --resume     # continue an interrupted round
node harness/round.mjs report --round my-round           # token, price and wall-clock report

node harness/grade.mjs --round my-round                  # an independent grader model matches findings to the catalog
node harness/review.mjs pending --round my-round         # blinded list of findings nobody could classify
node harness/review.mjs apply --round my-round           # apply review/decisions.json and regrade
node harness/review.mjs sample --round my-round --n 20   # blinded sample of grader answers to check by hand
node harness/review.mjs agreement --round my-round       # agreement between grader and hand check
node harness/score.mjs --round my-round                  # results table: results/my-round/scoreboard.md
```

A single session: `node harness/run-session.mjs --participant <slug> --type explore|capture --seed <n>
--round <name> [--smoke] [--replace]`. Slugs: `public-browser`, `chrome-devtools-mcp`, `agent-browser`,
`playwright-cli`. `--smoke` shortens the task to a self-test of the harness. Human reports become
session files with `node harness/human-import.mjs --reports <file> --round <name>`.

`round.mjs` writes `results/<round>/fingerprint.json` before the first session and refuses to start over
an existing one (`--overwrite-fingerprint`) or to resume after a change of the setup (`--accept-drift`).
Compare two fingerprints with `node harness/fingerprint.mjs --compare <a.json> <b.json>` (exit 0 if only
the budgets differ). The exact model ID must stay identical within a round; the round stops if it changes.

Grading costs tokens too: the grader runs once per explore session that has findings.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CODER_PARCOURS_CHROME` | harness | Chrome binary used by all participants. Default: the macOS application path, or the first of the usual Linux paths. |
| `CODER_PARCOURS_CLAUDE_BIN` | harness | Path of the `claude` client. Default: first `claude` on `PATH`, else `~/.local/bin/claude`. |
| `CODER_PARCOURS_GRADER_CMD` | `grade.mjs` | Shell command that replaces the grader call. It gets the prompt on stdin and writes JSON (`{"matches": [...], "model": "..."}`) to stdout. Meant for tests and for using another grader model; the grader must not be the agents' model. |
| `CODER_PARCOURS_PYTHON` | `setup.mjs` | Python used to create the venv. Default `python3`. |
| `CODER_PARCOURS_PUBLIC_DIR` | catalog loader | Folder of the public bug modules. Default `bugs/public`. Used by tests. |
| `CODER_PARCOURS_ADMIN_TOKEN` | hosted app | Admin token (at least 32 random characters, for example `openssl rand -base64 32`) for the report export. Passed with `--admin-token-env`. |
| `CODER_PARCOURS_TRUST_PROXY` | hosted app | Number of reverse proxies in front of the app (`0` = none). Required in hosted mode. |
| `CODER_PARCOURS_COMMIT` | hosted app, Docker build argument | Commit the hosted build was made from. Reported by the app so that human reports can be tied to a catalog state. |
| `CP_TEST_DOCKER` | `harness/start.test.mjs` | Set to `1` to include the Docker build test. |

## Hosting for human testers

```bash
npm run start:hosted        # needs CODER_PARCOURS_ADMIN_TOKEN and CODER_PARCOURS_TRUST_PROXY
docker build --build-arg CODER_PARCOURS_COMMIT=$(git rev-parse HEAD) -t coder-parcours .
```

Hosted mode must run behind HTTPS (session cookies are `Secure`). Put `data/` on a persistent volume, or
human reports are lost when the container restarts. The admin export is `GET /api/admin/reports` with
`Authorization: Bearer <token>`; five wrong tokens lock the client IP out for ten minutes. The hosted app
never loads the sealed part of the catalog, and the Docker image does not contain it.

## Tests of the harness itself

```bash
npm run typecheck && npm run test:unit && npm run e2e
```

## Folders

| Folder | Content |
|---|---|
| `app/`, `server/`, `shared/` | the app and its server |
| `bugs/public/` | the public part of the bug catalog (modules; the contract for authors is `bugs/README.md`) |
| `secret/` | the sealed part of the catalog (encrypted; see METHOD.md) |
| `catalog/` | catalog loader, validation, decoys |
| `harness/` | session runner, capture check, grader, review, scoring, tool chain pins |
| `results/` | one folder per round: `sessions/`, `graded/`, `review/`, `fingerprint.json`, `scoreboard.md`. The raw session logs under `raw/` are published together with the final measurement (phase 3). |

## Ports

Capture sessions need ports **9222 and 9223 free** when the session starts. The Python library
`publicbrowser` connects to a Chrome with remote debugging on 9223 by default, and 9222 is the usual
debugging port; a browser that is already listening there would be taken over by a test. `doctor`
warns, and a capture session started with a busy port is aborted. Public Browser itself runs its own Chrome
on port 9333 during the sessions. Details and consequences in METHOD.md, section "Known limits".
