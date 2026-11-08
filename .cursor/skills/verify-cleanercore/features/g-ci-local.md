# CI runs the cleaner suite both ways

Every pull request to master installs, typechecks, builds, runs the full test suite (the cleaner-core flag tests set the flag on and off themselves), scans for configured scratch codes, and checks that the Grok setup prompt is unchanged. GitHub Actions runs `scripts/ci-check.sh` for that, then `scripts/ci-proofs.sh` for the verify-cleanercore proofs. In that CI job the step G gate is skipped, because `ci-check.sh` already ran.

`prove-step-g.sh` does not run that full script on every local proof. It reads the git diff and picks one gate.

## Sub-features

- `ci-commands` runs `npx vitest related --run` on the changed files, then `npm run typecheck`, when the diff stays off the path list below.
- `ci-commands` runs `bash scripts/ci-check.sh` when the diff touches a path on that list.
- `flag-off-smoke` exits 2 and sends nothing when the flag is unset, even with a freshness watch and a review.

## How the script chooses

Changed files are the names from `git diff` between `HEAD` and the merge-base with `origin/master`, plus staged files, unstaged files, and untracked files. The script sorts them and drops duplicates. If `origin/master` is missing, the base is `master`.

If any changed file matches the list, the script runs `bash scripts/ci-check.sh` and requires exit 0. Otherwise it runs `npx vitest related --run` with those changed files that still exist, then `npm run typecheck`. A deleted path still counts for the list. It is not passed to Vitest. Either command failing makes the script exit nonzero.

`--run` is on the Vitest command so the process exits. Without it, Vitest stays in watch mode when stdin is a terminal and `CI` is unset.

A directory entry matches every file under that directory. A file entry matches that path only.

### CI files

These are the workflow and the script it calls.

- `.github/workflows/` is every GitHub Actions workflow. A change here can call `scripts/ci-check.sh` differently than this gate, so the local proof runs that same script.
- `scripts/ci-check.sh` is the script the workflow runs. A change to it is the check itself, so the proof runs it.

### Shared pipeline code

These files are what `scripts/ci-check.sh` executes, or the configs those commands read. A Cleaner Core product change does not touch them. A change here can make related tests pass while the pipeline the workflow runs does something else, so the proof runs `scripts/ci-check.sh`.

- `scripts/build.mjs` is `npm run build`.
- `scripts/scan-cleaner-secrets.mjs` is the secret scan.
- `scripts/scratch-pin-pattern.mjs` is imported by that scan.
- `scripts/cleaner-seal-test-key.mjs` is imported by that scan.
- `package.json` defines `typecheck`, `build`, `test`, and `test:eval`.
- `package-lock.json` is the tree `npm ci` installs.
- `tsconfig.json` is what `npm run typecheck` reads.
- `vitest.config.ts` is what `npm test` reads.
- `vitest.eval.config.ts` is what `npm run test:eval` reads.
- `grok-template/SETUP_PROMPT.md` is the file `scripts/ci-check.sh` compares to `origin/master`. A diff there fails that check, so the local proof runs the same check.

## How to get to it (user POV)

- A pull request to master starts the CI workflow.
- With the flag unset, nobody at Scratch Lane receives a text.

## Driving it with the cleaner doctor/smoke CLI

Preconditions:

- Node 22.13 or newer, `npm ci` already done, and doctor on before the flag-off smoke.
- `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` exits 0 with `sends` false.

- **Related tests.** When the diff matches none of the paths above, run `npx vitest related --run` on the changed files. Exit code 0. Vitest exits 0 when no changed file has a related test.
- **Typecheck.** Then run `npm run typecheck`. Exit code 0.
- **Full check.** When the diff matches a path above, run `bash scripts/ci-check.sh`. Exit code 0. The log names typecheck, build, the default test suite, cleaner-core tests with the flag on, the same tests with the flag off, the secret scan, the baseline eval, and an unchanged `grok-template/SETUP_PROMPT.md`.
- **Flag off.** Run `env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --watch-freshness --feed src/cleaner-core/fixtures/guesty-lite-scratch.ics --review stale-source`. Exit code 2. `sent` is `[]` and `reason` is `disabled`.

`PROVE_STEP_G_CI_ONLY=1` runs only this gate and skips the journeys. `PROVE_STEP_G_EVIDENCE` sets the output directory. Both are unset on a normal run. A normal run still removes `evidence/step-g/` and writes it again. The gate writes `ci-local/decision.txt` as `related` or `ci-check`, plus the command, stdout, stderr, and exit code for each command it ran.

## Gotchas

- Node before 22.13 cannot open the SQLite backup store, and bootstrap refuses it. CI uses Node 22.
- The secret scan allowlists the historical tenant store and the step D through F proofs. A new file that contains a configured scratch code fails the scan.
- `prove-step-g.sh` runs this gate after the step D, E, and F proofs.
- A related-test failure exits before typecheck. A typecheck failure exits before the flag-off smoke.
