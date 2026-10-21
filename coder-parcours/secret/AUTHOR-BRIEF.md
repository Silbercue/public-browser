# Brief for the secret bug author

You write the sealed, secret part of the bug catalog of the coder parcours. Nobody who works on the
browser tools under test may see it before the final measurement (phase 3). This brief is public; what
you write is not. Your answer at the end contains **no bug content** at all.

## Ground rules for this session

- **Keyword:** the operator's first message contains a keyword. Write it as a comment in the
  **first line of every file you create** (`// <keyword>` in `.mjs`/`.ts`; `decoys.json` is the only
  exception, JSON has no comments). The operator uses it to find and delete every trace of this
  session afterwards.
- Work **outside every git repository**. Get the app with `git archive`, never with a clone or a copy
  of a working tree:

  ```bash
  mkdir -p ~/coder-parcours-secret && cd ~/coder-parcours-secret
  git -C <path-to-repo> archive coder-parcours coder-parcours | tar -x -C .
  cd coder-parcours && npm ci && npm run build
  ```

  (If the operator already did this, start in the folder you were given.)
- Write **nothing into memory or note files**: no auto-memory, no `CLAUDE.md`, no notes outside the
  work folder. Do not start sub-agents.
- Your final answer names only the three delivered files and their checksums. **No bug IDs with
  titles, no stations, no symptoms, no decoys** in the answer.

## What to write

Create a folder `secret-src/` next to the app (`~/coder-parcours-secret/secret-src/`) with:

```
secret-src/
  bugs/S01-<short>.mjs ... bugs/S08-<short>.mjs
  decoys.json
  e2e/secret-bugs.spec.ts
```

### Bugs `S01`–`S08`

Exactly 8 bugs, IDs `S01` to `S08`, in the module form and under the rules of `bugs/README.md`
(read it completely first; the validator is `catalog/schema.mjs`).

- At least 4 of the 8 in category `fiddly` or `next-step`.
- For each width (`phone`, `tablet`, `desktop`) at least one bug that is specific to that width
  (`widths` lists that width, not `all`).
- **No bug has `roles.change` or `roles.capture`.** Secret bugs are drawn in addition to the public
  ones and never serve as change or capture target. `roles.trap` is allowed only for `timing`.
- **Do not overlap the public catalog:** read every module in `bugs/public` first. None of your bugs
  may have the same station **and** the same kind of symptom as a public bug. Pick other places or
  other kinds of mistakes.
- Same plausibility bar as the public bugs: each one looks like a real developer mistake, an attentive
  person notices it at its station and width without developer tools in under a minute, and it has a
  measurable criterion your test checks.
- Functions are self-contained (no imports, no outside variables), as `bugs/README.md` explains.
- **`removesDecoys` in every bug (required, may be `[]`).** Read `catalog/decoys.json`. For every
  public decoy at one of your bug's stations, decide whether your bug can remove or hide the decoy's
  explanation; list each such decoy ID in `removesDecoys`. A secret bug without the field makes
  `loadCatalog` throw.

### Decoys (optional)

`decoys.json` holds 0 to 2 secret decoys with IDs `D90`–`D99`, in the decoy form of
`bugs/README.md` (`conflicts` may name public and secret bug IDs). Without secret decoys the file is
`[]`.

### Check spec `e2e/secret-bugs.spec.ts`

Phase 3 runs this spec after unsealing and before the measurement, because app changes until then can
silently break bugs that rely on `patch(selector)`. Write it **as if it lived in
`coder-parcours/e2e/`**: imports relative to that folder, the app server via `spawnAppServer` from
`../server/spawn.mjs`, and the secret folder from the environment variable
`CODER_PARCOURS_SECRET_DIR` (passed to the server as its secret folder). For **each** bug three cases,
each with `--activate <id>@<station>:<width>` or `--no-bugs`:

1. active at its station in its width → the measurable criterion is met;
2. same page in another width → the criterion is not met;
3. `--no-bugs` → the criterion is not met.

Also assert that `loadCatalog` with this secret folder loads 8 secret bugs without errors.

## Test

1. Validate: load the catalog with your folder as secret folder (`loadCatalog` in
   `catalog/load.mjs`, option `secretDir`) and fix every reported problem.
2. Look at each bug yourself: start the app with `node server/start.mjs --seed 1 --session explore
   --secret-dir ../secret-src --activate S01@<station>:<width>` and check it in Chrome at 390, 768 or
   1440 px.
3. Run the spec from your archive copy (never from the real repository):

   ```bash
   cp ../secret-src/e2e/secret-bugs.spec.ts e2e/
   CODER_PARCOURS_SECRET_DIR=$(cd ../secret-src && pwd) npx playwright test -c e2e/playwright.config.ts e2e/secret-bugs.spec.ts
   rm e2e/secret-bugs.spec.ts
   ```

   All cases must be green.

## Seal and deliver

Seal the whole `secret-src/` folder (`bugs/`, `decoys.json`, `e2e/secret-bugs.spec.ts`) with the
public key that came with the archive. Sealing needs no passphrase:

```bash
mkdir -p ../out
node harness/seal.mjs seal --in ../secret-src --recipient secret/recipient.pub --out ../out/sealed.bin
```

This writes `sealed.bin`, `sealed.bin.sha256` and `plaintext.sha256` into `../out/`. Then delete the
plaintext: `rm -rf ../secret-src`, and any `e2e/secret-bugs.spec.ts` or `test-results/` left in the
archive copy. Deliver only the three files in `out/`. Your final answer: the path of `out/` and the two
checksums, nothing else.

## After delivery (for the operator)

This part is for the operator, **not for the session**. Once the three files are copied away:

1. Delete the whole work folder (`~/coder-parcours-secret/`, including `out/` after copying).
2. Delete the project folder of the session under `~/.claude/projects/` (its name is the work folder
   path with `-` instead of `/`, e.g. `-Users-<name>-coder-parcours-secret-coder-parcours`).
3. Delete the session leftovers from that time span under `~/.claude/file-history/`,
   `~/.claude/todos/` and `~/.claude/shell-snapshots/`.
4. Delete `cp-*` folders and `test-results/` in the temp folder (`$TMPDIR`).
5. Check: `grep -rl "<keyword>" ~/.claude "$TMPDIR"` finds nothing.

Cleaner alternative: run the author session under a separate macOS user or on another machine.
