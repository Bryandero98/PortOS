# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite has passed on the exact tree being released.

## Where the suite actually runs

Every change reaches `main` through a pull request, and `main` reaches
`release` through a pull request, so the suite runs once per gate rather than
once per event:

| Event | What runs |
|-------|-----------|
| PR into `main` | Impact-scoped plan (only the surfaces the diff touches) |
| Push/merge to `main` | **Nothing** — no push trigger; the PR gate already passed |
| PR `main` → `release` | **Full suite**, forced regardless of the diff |
| Push/merge to `release` | Reuses the release PR's green gate; full suite only if it cannot be verified |
| Nightly 09:17 UTC | Full suite — the `main`-branch health signal |
| `workflow_dispatch` | Full suite |

A release therefore pays for one full run (on its PR), not three.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Merge `main` into `release` to trigger releases |

## CI Workflow (`ci.yml`)

PRs into `main` use `scripts/ci-test-plan.js` to classify the changed files
before installing dependencies. Directory-scoped features run their server and
client feature tests; flat modules fall back to Vitest's import-graph-aware
`--changed` mode. The planner deliberately chooses full CI for shared
composition roots, test configuration, dependency manifests, workflow changes,
unknown artifacts, or wide diffs.

PRs into `release` skip the planner entirely and force the full suite: that PR
is the single gate a release ships behind.

A short always-run list (`ALWAYS_RUN_TESTS` in the planner) is added to every
plan, so no impact scope can drop it — currently
`server/services/taskPromptDefaults.test.js` (cross-install prompt-upgrade). A
documentation-only PR therefore still runs the server job with that file
selected.

### Vitest runner tuning

On GitHub Actions, `CI=true` caps each Vitest runner at `maxWorkers: 2`
(`scripts/vitestCiPool.js`, spread into `server/vitest.config.js` and
`client/vitest.config.js`). Standard hosted runners are 2 vCPU / 7GB;
uncapped forks oversubscribe those cores during transform. Local `npm test`
is unbounded. File-level parallelism stays on for unit tests so the two
workers stay busy; the DB suite already serializes files because those tests
share one Postgres.

Each test job restores Vite/Vitest transform artifacts
(`node_modules/.vite`, `node_modules/.vitest`) **after** `npm ci` — install
wipes `node_modules`, so a pre-install restore is lost. `scripts/run-ci-tests.js`
writes Vitest wall time to the job summary so later runs can be compared
against the pre-change full-suite job wall on `main` (2026-08-16, run
`31951919659`): server ~300s, client+build ~467s, Windows ~463s.

The selected work is split across parallel jobs:

- **Server tests** — full, related, or explicit feature test files. Smoke-boots
  the server on the same job when server source changed (the smoke path uses the
  file backend under `NODE_ENV=test` and does not need Postgres). Always-run-only
  plans skip the native-addon rebuild.
- **Client tests and build** — affected client tests; production build whenever
  client source changed; client lint on the same install so Biome does not pay a
  second `npm ci`.
- **DB tests** — provisions only the isolated `portos_test` database and runs
  the serial DB suite when database-sensitive files changed.
- **Windows server tests** — the same server selection, but only on full CI
  (the `main` → `release` PR, nightly, release, workflow dispatch) or when a
  Windows-sensitive surface changed (`.ps1` / `.cmd` spawn, PowerShell BOM,
  `bufferedSpawn`, `cos-runner`, shell/PM2, etc.). Docs-only and ordinary
  Linux-faithful PRs skip this job. `pinPlatform('win32')` tests still run on
  Linux.
- **lint** — historical required-check name. The real lint step lives in the
  client job; this job only mirrors that result.
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled.

Targeted `files` / `related` plans run **one** Vitest process for the union of
planner-selected files and Vitest's `--changed` import graph. The two sets are
listed then merged — they cannot share one argv, because Vitest ANDs
`--changed` with path selectors.

No third-party change-filter action is used. The planner passes test paths as a
JSON argument array to `spawnSync`, never through shell interpolation.

### Full CI

The complete server, client, DB, lint, build, and smoke suite runs:

- on every pull request whose base branch is `release` (the release gate);
- nightly at 09:17 UTC;
- from manual workflow dispatch;
- as a reusable workflow called by a release whose tree has no verifiable gate.

There is **no push trigger on `main`**. A merge commit on `main` re-tests a
tree whose PR gate is already green, so the run was pure duplication; the
nightly full run is what catches a semantic conflict between two independently
green PRs, and the `main` → `release` PR catches it before a release ships.

Changes to CI/test configuration also force the full suite on their own PR.
`[skip ci]` remains honored for push events only; PR CI always runs.

### Impact-planner safety rules

- A directory feature such as `server/services/sprites/` selects tests carrying
  the same feature segment across server and client, plus every test Vitest's
  import graph relates to the changed files.
- Directly changed tests and co-located sibling tests are always included.
- Barrel/catalog guards are added when reusable `lib`, `hooks`, or `utils`
  directories change; JSX changes include the global accessibility convention
  guard.
- Database adapters, DB scripts, and relevant migrations add the complete
  serial DB suite.
- Unmapped executable files use related-test mode. Unclassified artifacts,
  shared roots/config, more than 30 executable changes, or more than 120
  selected tests fail safe to full CI.

## Release Workflow (`release.yml`)

Triggers on push to `release` branch. Steps:

1. Runs `scripts/verify-ci-status.js` to look for a full CI run that already
   covered this exact tree (see below).
2. Calls `ci.yml` with `full: true` **only if** step 1 found nothing.
3. Reads version from `package.json`.
4. Checks if the git tag already exists (skips release creation if so).
5. Looks for a changelog file:
   - First: `.changelog/v{version}.md` (exact match)
   - Then: `.changelog/v{major}.{minor}.x.md` (pattern match, replaces placeholders)
   - Fallback: generates changelog from commit messages
6. Creates the GitHub release with tag `v{version}`.
7. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used,
   archives it on `main` (renames `.x.md` to the exact version).
8. If the archive step ran, fast-forwards `release` to match `main`.

### Reusing the release PR's CI run

`scripts/verify-ci-status.js` decides whether the push already has a green
gate. The rule is **content-based, not SHA-based**: a commit vouches for this
push only when its git tree is byte-identical to the tree being released *and*
it carries a completed, successful `CI Gate` check run. It considers the pushed
commit itself and its direct parents.

The ordinary release merge satisfies this — `release` is strictly behind
`main`, so the merge commit's tree equals the `main` tip it merged, and that
tip is exactly the SHA the release PR ran full CI on.

Everything else fails closed and runs the complete suite again: a direct push to
`release`, a hotfix committed on `release` that changes the merge tree, a
missing or failed gate, or an unreachable checks API.

## Working with CI

### Skip CI

Add `[skip ci]` to push commit messages for generated documentation-only
changes. Auto-generated commits from the release workflow include this
automatically. Pull-request checks ignore this marker so a PR cannot bypass its
required CI gate.

### Force Full CI

Use the workflow-dispatch button for an immediate full run. A PR also chooses
full CI automatically when its impact cannot be classified safely.

### Rebase Before Push

Since CI may auto-commit changelog archives, always rebase before pushing:

```bash
git pull --rebase --autostash && git push
```

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different
