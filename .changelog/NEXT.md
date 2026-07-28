# Unreleased Changes

## Fixed

- **Branch reconciler no longer hands long-lived shared branches to the coordinator agent.** `gh-pages` (the GitHub Pages publishing branch) is now protected alongside `main`/`master`/`dev`/`develop`/`release`, so the scheduled `branch-reconcile` task never tries to "open a PR" merging it into the default branch (which would break the published site). The reconciler now reuses the single canonical `PROTECTED_BRANCHES` set in `server/lib/gitArgs.js` instead of its own narrower list, so it also picks up `dev`/`develop` protection.

## Changed

- **Branch reconciler prioritizes recognized work branches.** The in-flight set handed to the coordinator agent is now ordered by branch prefix — `claim/`, `cos/`, `next/`, `feature/`, `fix/`, and other conventional prefixes are reconciled ahead of unrecognized/ad-hoc branches — so a bounded run spends its budget on real deliverables first. Both `/` and `-` separators match.
