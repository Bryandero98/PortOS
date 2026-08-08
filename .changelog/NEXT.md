# Unreleased

## Fixed

- CoS agents whose deliverable is a **commit** are no longer scored as failures. The idle reaper's "did this agent do anything?" gate read only *uncommitted* changes, so a `/do:release` or `/do:pr` run that committed, pushed, and opened its PR — leaving a clean tree *because it succeeded* — was recorded as `idle-no-changes` and retried. Two consecutive release runs on 2026-08-08 each did their whole job (cut the release commit, opened the release PR, then repaired it against review findings) and were both reported failed, holding the release for two days. The gate now counts commits made inside the run window as evidence of work, alongside a dirty tree. The report-shaped half of the same problem (`/do:review`, `/do:scan`, `/do:plan-task`, `/do:replan`, whose deliverable lands outside the repo) is tracked in #3636, and the unsatisfiable `[task-<id>]` success criterion one layer up in #3637.
