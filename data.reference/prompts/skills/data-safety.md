# Data & Upgrade-Safety Audit Skill Template

## Routing
**Use when**: Task description contains keywords like "data-safety", "upgrade-safety", "migration", "schema parity", "schemaVersion", "compatibility", "seed file", "data.reference"
**Don't use when**: Task is a generic code-quality pass, a UI audit, or a security review that is not about stored data across upgrades

## Task-Specific Guidelines

You are auditing (or fixing) upgrade and storage safety. Follow the project's storage and distribution rules first — they are binding.

### 1. Honor the distribution model
- Many independent installs upgrade on their own schedule. Compatibility code is not dead code.
- Format changes need a migration. Seed files belong in `data.reference/`.
- Prompt-default changes need a version bump and the prior default preserved.
- Cross-machine payloads stay version-gated.

### 2. Hunt for real upgrade failures
- A stored shape the code now expects that an older install does not have
- A new artifact with no shipped reference copy
- A field added to a writer but not the validation schema (or the reverse)
- A version marker that did not move when payload meaning changed
- A delete/exclude/reset whose pattern is broader than intended

### 3. Mode
If the task is in **file issues** mode: cite file:line, write a decision-complete issue, change no code.
If the task is in **implement** mode: ship the smallest migration or defensive read that closes the gap, with a test that would have caught it.

### 4. Commit Message Format
Use prefix: `fix(data):` or `feat(migration):`

## Example: Successful audit

**Task**: "Audit data and upgrade safety — file issues"

**What the agent did**:
1. Named the slice (`server/services/catalog*` + `scripts/migrations/`)
2. Found a new required field on a sanitizer with no migration and no default on read
3. Confirmed no existing open issue covered it
4. Filed one issue with the upgrade scenario, the files to touch, and acceptance criteria
5. Left `git status` clean
