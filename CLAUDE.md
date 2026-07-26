# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Non-obvious invocations only — everything else is in `package.json` scripts.

```bash
npm run install:all   # includes git submodule update --init --recursive

# Tests are PER WORKSPACE — there is no root `npm test` that runs both
cd server && npm test            # Node test runner
cd client && npm test            # Vitest (jsdom) — component/unit tests
npm run test:db                  # DB-backed suites → portos_test ONLY (see Security Model)
```

## Security Model

**Trust model (within one install).** Each PortOS install serves exactly one human user, on a private network behind Tailscale VPN, never exposed to the public internet. Within an install there is one server process and one user — so concurrent *request* races, mutex locking on file I/O, and atomic write patterns are unnecessary as defenses against competing actors and should not be added or flagged as concerns. Simple re-entrancy guards (per-account sync locks to prevent duplicate in-flight operations; serializing two write paths that mutate the same record) are fine and expected. PortOS intentionally omits authentication, CORS restrictions, rate limiting, HTTPS, and full concurrency controls — these are non-issues for a single-user private-network deployment. Do not add them or flag their absence as security concerns. **"Single-user" means: do not defend against multiple competing humans inside one install. It does NOT mean "assume only one install exists."**

**Distribution model (across installs).** PortOS is distributed software: many independent people each run their own install, on their own machine(s), each upgrading on their own schedule — and a single user commonly runs **several machines federated as sync peers**. So backward/forward compatibility across installs and versions is first-class, NOT optional:

- **Never delete or skip migration / compatibility code on the grounds that "there's only one install."** There isn't — other people and other machines run this code and update it independently.
- On-disk format changes need a migration in `scripts/migrations/` (applied-list tracked per install in `data/migrations.applied.json`). Seed files must ship in `data.reference/`.
- Prompt-default changes need a `PROMPT_VERSIONS` bump AND the prior default preserved in `PREVIOUS_DEFAULT_PROMPTS`, so other installs recognize their stored prompt and auto-upgrade it (see `server/services/taskSchedule.js`).
- Cross-machine sync payloads stay version-gated (`server/lib/schemaVersions.js`) so a newer peer can't corrupt an older one.
- The self-update path stays fork-aware (`server/services/updateChecker.js`, `update.sh`) — other users run forks, not just upstream.

The default database password `portos` (in `ecosystem.config.cjs`, `docker-compose.yml`, and `.env.example`) is an intentional backward-compatible fallback for local development. Do not remove it or flag it as a security concern. Production deployments override it via the `PGPASSWORD` environment variable.

**Storage backend policy.** PostgreSQL (system `:5432` or Docker `:5561`) is a **mandatory** dependency for every install and every federated peer — provisioned by `npm run setup:db` (see the ADR `docs/decisions/2026-06-07-postgres-as-primary-datastore.md` and `docs/STORAGE.md`). **`MEMORY_BACKEND=file` is a development/test-only escape hatch, NOT a supported deployment mode** (the creative catalog/pgvector, federation, and backup all assume Postgres and have no file-backed equivalent). When `MEMORY_BACKEND` is unset, `server/services/memoryBackend.js` requires a healthy DB and fails fast with no silent fallback — this is **intentional**; do not "fix" the no-fallback behavior, re-add a file menu choice in `scripts/setup-db.js`, or treat the file backend as a fallback for real installs. The file path stays runnable only because `NODE_ENV=test` selects it (it is guarded from bitrot by the suite, not promoted to a deployment option).

**Third-party API keys for free, non-monetary services are not security findings.** PortOS calls a handful of free external APIs (e.g., CivitAI model downloads) using an API key attached as a query parameter or header. Findings that propose host-allowlisting the download URL before attaching the key, stripping the key across redirects, or similar hardening should be closed as won't-fix: leaking that key to an unintended host has no monetary loss and no meaningful security consequence — worst case is quota abuse against a free service, borne by that service, not the user. This does NOT extend to paid/quota-billed providers (LLM API keys, payment gateways) or to keys that gate money-bearing or destructive actions — those retain full hardening requirements. Precedent: issue #2200 (`ref-watch-phosphene-civitai-token-host-allowlist`, closed 2026-07-04) — a `reference-watch` proposal to allowlist the CivitAI download host before attaching `applyDownloadToken`'s API key in `server/services/loras.js#installFromCivitai`.

**Never run DB-backed tests against the real `portos` database.** There is ONE Postgres per install, shared by every git worktree (including CoS-agent worktrees). The `*.db.test.js` suites `DELETE FROM`/`INSERT` whole tables, so running them against `portos` corrupts the user's real universes/series/writers-room/catalog. They are gated to skip on a non-test DB and run only via `npm run test:db` (→ `portos_test`, provisioned by `npm run setup:db:test`). The gate in `server/lib/db.js` keys on `isTestRunner()` (`NODE_ENV==='test'` **OR** `process.env.VITEST`, not bare `NODE_ENV` — a wrapper that drops `NODE_ENV` must NOT be able to disarm it) and the `query()` backstop refuses ALL row writes (`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`) to a non-test DB under the runner. Do not weaken either to "just `NODE_ENV`" or "DELETE-only" — that's exactly the hole that wiped real data on 2026-06-13/14. See `server/lib/db.guards.test.js`.

## AI Provider Usage Policy

**No cold-bootstrap LLM calls.** PortOS must never queue up AI provider calls a user hasn't knowingly triggered. A new install (or a freshly merged feature) coming online should be silent on the LLM front until the user actually asks for AI-backed work. This rules out:

- Firing LLM calls from server boot / `server/index.js` init sequences (cache warm-ups, pre-generation, startup backfills).
- Any background job that silently expands from "generate the one thing the user asked for" into "generate a whole batch for later," without the user having opted into that batch.

**Scheduled automations are the one sanctioned exception** — a cron-style task, autopilot, or CoS agent the user explicitly configured (see `taskSchedule.js`, `backupScheduler.js`, autopilot gates) is expected to call AI providers on its own schedule, because the user set it up and knows it's running. Anything else that touches an AI provider needs either a direct user action in the same request, or an explicit consent/config step first.

**Pattern for background pre-generation (e.g. caches).** If a feature wants to pre-fill a cache of AI-generated content so future requests are instant:
1. Boot-time init loads only what's already on disk — zero LLM calls.
2. The bulk/cold fill only runs from an explicit user-triggered endpoint, gated behind a UI prompt that names the provider/model about to be used and lets the user change it (or decline and get a single on-demand generation instead).
3. Incremental top-ups after the user has already engaged with the feature (e.g. replenishing one item after they consumed one from an already-primed cache) are fine to run silently — the user already consented once, and a small top-up doesn't route through a slow provider unannounced the way a from-zero batch does.

See `server/services/meatspacePostDrillCache.js` (`initDrillCache` / `requestCacheFill` split) and `client/src/components/meatspace/post/WordplayTrainer.jsx` (`CacheFillConsentModal`) for the reference implementation — added after a fresh MeatSpace POST install triggered an unannounced 40-call sequential TUI backfill on first boot.

## Architecture

The server is always user-facing on `:5555` (HTTP or HTTPS). The client runs on the Vite dev server at `:5554` under `npm run dev`; under `npm start` the built client is served from `:5555` directly. PM2 manages app lifecycles. Where a given record persists (Postgres vs a `data/` file) is decided by the storage-classification contract in `docs/STORAGE.md`.

### Port Allocation

PortOS uses ports 5553–5561 (system PostgreSQL on 5432, Docker PostgreSQL on 5561). The user-facing port is always **`:5555`** — scheme flips between HTTP and HTTPS depending on whether a TLS cert is provisioned (`npm run setup:cert`); when HTTPS is on, a loopback-only HTTP mirror spawns on `:5553` so local curl/scripts skip the cert warning. `:5554` is the Vite dev server (only `npm run dev`).

Define ports in the top-level `PORTS` object in `ecosystem.config.cjs` (canonical re-export at `server/lib/ports.js`). See `docs/PORTS.md` for the full guide and diagram.

### Per-directory conventions

Client-specific and server-specific conventions live in nested memory files that load when you work in those trees:

- `client/src/CLAUDE.md` — UI conventions, routing/deep-linking, the shared `Drawer` convention
- `server/CLAUDE.md` — schema parity, write serialization, peer fan-out in tests, prompt-template migrations

### AI Toolkit (`server/lib/aiToolkit/`)

Vendored in-tree provider/runner/prompt toolkit (self-contained — no imports out to other PortOS modules). PortOS overrides `executeCliRun`/`stopRun`/`isRunActive` and mirrors time-based provider-status recovery on read. **See `server/lib/aiToolkit/CLAUDE.md`** for the override-consistency contract before editing the runner or provider config.

### Command Palette & Voice Nav — shared backbone (`server/lib/navManifest.js`)

`server/lib/navManifest.js` is the single source of truth for navigation: `NAV_COMMANDS` + `resolveNavCommand()`, consumed by both the `⌘K` palette and the voice agent's `ui_navigate` tool. **Adding a `<Route>` without a `NAV_COMMANDS` entry leaves the page unreachable from `⌘K` and un-navigable by voice.**

**Invoke the `portos-add-page` skill** for the entry shape, palette-action wiring, and the fail-fast guards.

### Dashboard Widgets & Layouts (`client/src/components/dashboard/`)

Widgets are registered in `widgetRegistry.jsx` (`{ id, label, Component, width, defaultH?, gate? }`); named layouts persist in `data/dashboard-layouts.json` with free-form 12-column `grid` positions. **See `client/src/components/dashboard/CLAUDE.md`** for the registration steps, grid/arrange mechanics, and ⌘K layout wiring before adding a widget.

### Backup Service (`server/services/backup.js`)

`DEFAULT_EXCLUDES` is **rsync filter syntax** — every path must be anchored with a leading `/`. An unanchored pattern silently drops unrelated user data and is a data-loss bug, not a style nit. See `docs/BACKUP.md` for the anchoring failure mode, the `overridable` tiers, and `computeEffectiveExcludes()`.

### Slashdo Commands (`lib/slashdo`)

PortOS bundles [slashdo](https://github.com/atomantic/slashdo) as a git submodule at `lib/slashdo`. This provides slash commands (`/do:next`, `/do:review`, `/do:pr`, `/do:push`, `/do:release`, etc.) and shared libraries without requiring a separate global install. `/do:next` is the slashdo replacement for the former repo-local `/claim` command — claim the next PLAN.md item (or GitHub issue with `--issues`) in an isolated worktree and ship a PR.

**Key points:**
- CoS agents can use `loadSlashdoCommand(name)` from `subAgentSpawner.js` to inline command content into prompts (resolves `!cat` lib includes automatically)
- The `.claude/commands/do/` symlinks make all `/do:*` commands available as project-level Claude Code slash commands

### Self-update flow (`server/services/updateChecker.js` + `update.sh`)

- The release notification poll **always queries the upstream `atomantic/PortOS`** so users running from a personal fork still see new versions. Constants come from `server/lib/gitRemote.js` (`UPSTREAM_OWNER`, `UPSTREAM_REPO`, `UPSTREAM_FULL_NAME`) — don't re-hardcode `atomantic/PortOS` anywhere else.
- `getOriginInfo()` in `server/lib/gitRemote.js` classifies the local `origin` remote into `{ isUpstream, isFork, isGithub, owner, repo, fullName }`. `getUpdateStatus()` includes this as `remoteInfo` plus a fixed `upstream` block. New UI that says "running from PortOS" must read `remoteInfo.isUpstream` (NOT just `currentVersion`) — otherwise it lies to fork users.
- `update.sh` / `update.ps1` always `git pull --rebase --autostash` from **origin**, not upstream. Fork users who haven't merged upstream into their fork get a silent no-op pull. To prevent that confusion: `POST /api/update/execute` rejects fork runs with 412 `FORK_SYNC_REQUIRED` unless `acknowledgeFork: true` is set in the body OR `lastForkSync.fullName` matches `remoteInfo.fullName` within the last 10 minutes.
- Fork sync happens via `POST /api/update/sync-fork` → `gh repo sync <owner>/<fork> --source atomantic/PortOS --branch <branch>`. `gh` is fast-forward only by default, so a diverged fork main returns 409 `FORK_DIVERGED` — never add `--force` server-side. The error message points users at the explicit `--force` they can run from a terminal if they really want to discard fork commits.
- The UpdateTab UI swaps "Update Now" for three buttons when `isFork`: "Sync Fork & Update", "Sync Fork Only", "Update from Fork As-Is" (the last sends `acknowledgeFork: true`). Keep these three behaviors distinct — collapsing them strips user agency over what touches their GitHub fork.

## Module Organization

PortOS has reached the size where re-implementing a helper is now cheaper to *start* than to find what already exists. To keep that pressure off, every directory that holds reusable code carries a catalog `README.md` and an enumerable `index.js` barrel. **Before writing a helper, grep the catalog.**

### Where new code lives

- **Pure / side-effect-free helpers** → `server/lib/` or `client/src/lib/`
- **React hooks (state + lifecycle)** → `client/src/hooks/`. Names start with `use`.
- **Formatting helpers (pure, no React)** → `client/src/utils/` (`formatters.js`, `cronHelpers.js`, etc.)
- **HTTP / Socket / browser clients** → `client/src/services/`. API wrappers start with `api*`.
- **Express handlers** → `server/routes/`. Use `validateRequest` + `lib/validation.js` schemas.
- **Domain orchestration (multi-step business logic over models + services)** → `server/services/`.
- **Persisted data (where a record lives — PostgreSQL vs a `data/` file)** → decide via the storage-classification contract in `docs/STORAGE.md` *before* defaulting to a new `data/*.json`. App-native relational records are `db-primary` (PostgreSQL); the doc's "Adding a new data store?" checklist is required in PR review.

One concern per file. Tests live next to their source as `<name>.test.js`. Naming is camelCase with a domain prefix (`brainValidation.js`, `creativeDirectorPrompts.js`).

### Discovery rule (BEFORE writing a helper)

Grep the catalog for the directory most likely to hold it:

```
grep -i "what you want to do" server/lib/README.md
grep -i "what you want to do" client/src/lib/README.md
grep -i "what you want to do" client/src/hooks/README.md
grep -i "what you want to do" client/src/services/README.md
```

If a close match exists, **extend it or use it**. Only add a new module when no existing one fits. Examples of pre-existing helpers that are easy to miss but should be reused:

- `tryReadFile` in `server/lib/fileUtils.js` — collapses `readFile(path).catch(() => null)`.
- `atomicWrite` in `server/lib/fileUtils.js` — `ensureDir + writeFile + JSON.stringify` in one call.
- `createCollectionStore` in `server/lib/collectionStore.js` — when a service has outgrown its monolithic single-JSON-file shape (large per-record payload, frequent mutations, want concurrent writes to different records), use this instead of rolling another `readJSONFile`+`atomicWrite`+`createFileWriteQueue`. Lays out `data/{type}/{id}/index.json` with a type-level `data/{type}/index.json` that stamps `schemaVersion` (the storage-layout version, distinct from any per-record-shape `schemaVersion` the sanitizer carries inside each record). Includes per-id write queue and a `verifySchemaVersion` hook used by the boot-time verifier in `server/index.js`. Worked example: `server/services/universeBuilder.js` (migration 034 splits the legacy `universe-builder.json` into this shape).
- `optionalBooleanMap(keys)` in `server/lib/validation.js` — `z.object(Object.fromEntries(KEYS.map(k => [k, z.boolean().optional()])))` collapsed.
- `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` in `server/lib/canonPrompt.js` (mirrored to client) — render `[{ prefix?, value }]` fragments to a sentence string or array.
- `copyToClipboard` / `writeClipboardSilently` / `readClipboard` in `client/src/lib/clipboard.js` — safe across insecure-origin contexts. Do not use `navigator.clipboard.writeText` inline.
- `useLockToggle` in `client/src/hooks/useLockToggle.js` — optimistic-PATCH lock-toggle for any new lock button.
- `useSseProgress` in `client/src/hooks/useSseProgress.js` — generic JSON-frame EventSource subscriber; build new progress hooks on top of this.
- `formatBytes` / `formatTimecode` / `formatDateShort` / `formatDurationMs` / `timeAgo` in `client/src/utils/formatters.js` — do not re-define formatters inside components.

### Maintenance rule (WHEN adding a public module)

Any new file added to `server/lib/`, `client/src/lib/`, `client/src/hooks/`, `client/src/utils/`, or a new `apiX.js` in `client/src/services/` **MUST**:

1. Be re-exported from the same-directory `index.js` barrel (or, for `services/`, from `api.js`).
2. Get a one-line row in the same-directory `README.md`.

This is the one rule that keeps catalogs from rotting. The barrel is enforced by `server/lib/index.test.js` (and matching client tests) which verify that every non-test `.js` file appears both in the barrel AND in the README — boot will fail loudly if either drifts.

**Name collisions.** When two modules in the same directory export the same identifier (e.g. `settingsUpdateInputSchema` in both `brainValidation.js` and `digitalTwinValidation.js`), the barrel uses `export * as <name>` namespace exports so the collision is unambiguous: callers reach for `brainValidation.settingsUpdateInputSchema` explicitly. The catch-all `validation.js` (and similar central modules) stays flat. The collision-detector test fails if two flat-`export *` modules ever share an identifier — forcing namespace resolution at the point the conflict is introduced.

Existing deep imports (`import { x } from '../lib/foo.js'`) keep working — the barrel exists for *discovery*, not to force a re-import. New code may use either form.

The worked example for "barrel + documented exports" is `server/lib/aiToolkit/index.js`.

## Scope Boundary

When CoS agents or AI tools work on managed apps outside PortOS, all research, plans, docs, and code for those apps must be written to the target app's own repository/directory -- never to this repo. PortOS stores only its own features, plans, and documentation. If an agent generates a PLAN.md, research doc, or feature spec for another app, it goes in that app's directory.

## Sensitive Data & Privacy (developing on a live instance)

**This code is written and reviewed on a live install holding one real user's data.** Machine identity, network topology, personal records, and app-specific names read out of the running instance are the user's private data — they must never leak into anything that gets committed, pushed, or published. Treat every artifact an agent produces (source, comments, test fixtures, docs, changelog, commit messages, PR titles/descriptions/review comments, issue text) as world-readable the moment it lands on a branch.

**Never commit, log to a shared file, or write into a PR/issue/commit any of:**

- **Machine identity** — hostnames, machine names, Tailscale node names / MagicDNS names, device IDs, OS usernames, home-directory paths that embed a username (`/Users/<name>/…`, `/home/<name>/…`), user email addresses, account IDs, license keys, serial numbers.
- **Network info** — LAN/Tailscale/public IP addresses, MAC addresses, subnet layouts, port-forwarding maps, router/gateway addresses, VPN keys, `.env` secrets, DB passwords other than the documented `portos` dev fallback, API tokens, session cookies, auth headers.
- **PII** — real names, physical addresses, phone numbers, birthdays, government IDs, payment details, GPS coordinates, biometric data — the user's or anyone in their data.
- **Personal app data** — the actual contents of the running instance: real universe/series/writers-room/catalog records, brain/journal entries, MeatSpace/POST data, media project names, scheduled-task payloads, chat/voice transcripts, or any record pulled from `data/`, the live DB, or a running screen. Do not paste a real record into a test fixture, an example in docs, or a bug report.

**Rules for agents:**

- **Placeholders, not observations.** When code, a test, a comment, or a doc needs an example value, invent an obviously-fake one (`example.com`, `alice@example.com`, `192.0.2.10` (TEST-NET-1), `Acme Corp`, `Example Universe`, `host-XXXX`). Never transcribe a value you observed in the live instance or environment.
- **Reproduce with redaction.** When a bug repro, log excerpt, or stack trace legitimately needs real state to be understood, redact the sensitive fields (`<hostname>`, `<user-email>`, `<tailscale-ip>`, `<record-id>`) before it goes into a commit, PR, issue, or review comment. The point is the shape of the data, not its contents.
- **No environment scraping into artifacts.** Do not run `hostname`, `whoami`, `ifconfig`/`ip addr`, `tailscale status`, `env`, `git config user.*`, or similar and then paste the output into anything committed or published. Read them only for transient in-session logic, never persist them.
- **Scrub before you ship.** Before `git add`/commit and before opening or commenting on a PR/issue, scan your own diff and prose for the categories above. If real data slipped in, replace it with a placeholder; if it was already committed, amend/rewrite the branch before pushing rather than layering a "redaction" commit on top (the history still leaks).
- **Absolute paths.** Prefer repo-relative paths in committed text; when an absolute path is unavoidable in a comment or doc, strip the user segment (`~/…` or `<repo-root>/…`, not `/Users/<name>/…`).

This complements the Security Model (which governs the deployed product) — this section governs what agents are allowed to *write down* while working against real data.

## Code Conventions

- **No try/catch** - errors bubble to centralized middleware. **Exception:** PTY/child-process/`setTimeout`/`setInterval` callbacks and any code that runs *outside* the Express request lifecycle. An uncaught throw there crashes the Node process (there is no `next(err)` to bubble to). At those boundaries, wrap hook invocation in try/catch and log via the emoji-prefixed `console.error` style. Async event handlers that mutate shared module-level state (e.g. the TUI spawner's `handleData`) must also be serialized — chain them onto a per-session/per-actor `Promise.resolve()` queue rather than firing concurrently, otherwise interleaved awaits race on shared buffers.
- **Functional programming** - no classes, use hooks in React
- **Zod validation** - all route inputs validated via `lib/validation.js`
- **Command allowlist** - shell execution restricted to approved commands only
- **Every new page registers in the nav manifest** - when adding a `<Route>` + sidebar link, also add a `NAV_COMMANDS` entry in `server/lib/navManifest.js`. This makes the page reachable via `⌘K` and voice (`ui_navigate`) automatically. Invoke the `portos-add-page` skill for the entry shape.
- **Selection lives in the URL, never in local state** - any view that opens/selects a specific record encodes it as a route param, so it's shareable, bookmarkable, and reachable from ⌘K and voice. Full contract (index + `:id` routes, not-found fallback, Layout scroll mode) in `client/src/CLAUDE.md`.
- **Client UI conventions** (`client/src/CLAUDE.md`, loads when working under `client/src/`) - no `alert`/`confirm`, `htmlFor`/`id` label pairing, mobile responsive, above the fold, no hardcoded localhost, alphabetical nav, reactive local-state updates after mutations, and the shared tabbed `Drawer` convention.
- **Socket-driven UI** - invoke the `portos-socket-ui` skill before wiring or debugging a socket-driven view (event-driven state swaps, single-subscriber resources, pending-request tracking, deferred-work guards).
- **Single-line logging** - use emoji prefixes and string interpolation, never log full JSON blobs or arrays
  ```js
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📜 Processing ${items.length} items`);
  console.error(`❌ Failed to connect: ${err.message}`);
  ```
- **LLM response merging — distinguish absent vs intentionally empty.** When merging an LLM response with existing state, "key absent" must preserve the original while "key present with empty value" must apply the intentional clear. Don't use `.length` truthiness as the signal — that conflates the two cases and silently restores values the user (or LLM) just cleared. Conventions:
  - Strings: treat `null`/`undefined` as absent, `""` as a clear. Server helpers like `universeBuilderExpand.trimField` should return `null` for non-strings, not `""`.
  - Arrays/objects: gate on `Array.isArray(parsed?.field)` / `typeof parsed?.field === 'object'` before deciding to fall back to the original.
  - Keep server-side merges and the client's `pick` helpers mirrored — a one-sided change breaks the round-trip.
- **Sentinel + validate to distinguish "not set / failed" from "present-but-empty / valid".** The `.length`-truthiness footgun above is one instance of a broader rule: never let *absent*, *failed-to-fetch*, or *invalid* collapse into the same value as *fetched-and-legitimately-empty* or *valid*. Use an explicit sentinel and validate before falling through — not `x.length` or `x || fallback`-on-mere-presence. Canonical examples in the local-LLM backends: model-list caches use `null = not fetched` vs `[] = cached-empty`, so a zero-model backend still caches instead of re-hitting the API every call (`server/services/ollamaManager.js` `installedModels`, `lmStudioManager.js` `availableModels`); `getBackend()` validates the `.env` marker first and only then falls back to `process.env`, so a stale/invalid `.env` value can't mask a valid runtime env override (`server/services/localLlm.js`); and a reachable-but-list-failed backend surfaces an explicit `modelsError` rather than reporting `0 models` (`lmStudioManager.js` `getLastListError`).
- **Silent vs. toasting API requests.** The `request()` helper in `client/src/services/apiCore.js` toasts errors by default. When a caller already owns its own error UI — either via `useAsyncAction` (which toasts on throw) or a `.catch(() => fallback)` that intentionally swallows the failure — pass `{ silent: true }` to the API helper so the toast only fires from one layer. Add an `options` parameter to new API wrappers so callers can opt into silent mode. **Custom catch ⇒ `silent: true`.** When you have a custom error toast in `.catch()`, you MUST pass `{ silent: true }` — otherwise both the helper and your custom catch fire and the user sees two toasts back-to-back. If you DON'T have a custom toast, omit `silent` and let the helper handle it (single layer wins either way).
- **"Run Now" actions must gate on saved state, not the form input.** When a settings page has a companion "Run this now" button that triggers a server action reading server-side settings (not the local form values), the button must be gated on the *saved* value, not the in-memory input. Track a parallel `saved*` state for each setting the action depends on, update it on successful save, and use it for the action's enabled gate. Disable the action while the form is dirty *or* a save is in flight — a tooltip-only warning is missed on touch and produces surprising "I edited X and ran, but X didn't apply" bugs.
- **In-flight saves must gate dependent actions, not just the form.** When a field's PATCH is async and a button triggers server-side work that reads that field (auto-run, regenerate, etc.), the button must disable while the PATCH is in flight — not just while the input is "dirty." Otherwise the user picks a new value, the input clears, and they click the action before the server has the new value persisted. Track a `<field>Saving` boolean alongside the action's other disable predicates, set it before the PATCH and clear it in `.finally()`. See `PipelineIssue.jsx` `lengthProfileSaving` for the canonical example.
- **Server conventions** (`server/CLAUDE.md`, loads when working under `server/`) - schema parity when adding fields, serializing async PATCH races on shared records, batching high-frequency state writes, peer fan-out in record-creating tests, and stage-prompt template migrations.

## Git Workflow

- **main**: Active development
- **release**: Push `main` to `release` to trigger GitHub Release workflow
- **Push pattern**: `git pull --rebase --autostash && git push`
- **Changelog**: Append entries to `.changelog/NEXT.md` during development; `/do:release` (Claude Code slash command) finalizes it into a versioned file
- **Versioning**: Version in `package.json` reflects the last release. Do not bump during development — `/do:release` handles version bumps
- After each feature or bug fix, run `/simplify` and then commit and push code
- **Capture deferred work, and decide rather than park it.** Deferred refactors/cleanups go into `PLAN.md` as `- [ ]` items (or a filed issue) specific enough to pick up cold — never left only in chat. When the sole obstacle is an undecided design choice, **make the call yourself** and file it ready-to-work; `future` / `needs-input` are last resorts. Invoke the `portos-file-issue` skill for the full labeling contract.
- **Never link to AI conversation sessions in PR descriptions.** Do not paste `claude.ai`, `chatgpt.com`/`chat.openai.com`, or any other AI chat/session share URL (or a "generated by / view this conversation" link) into a PR description, commit message, issue, or review comment. These links leak session context, aren't durable references, and read as AI attribution — the PR must stand on its own with a Summary and Test plan. Reference durable artifacts instead: issue/PR numbers, commit SHAs, and file paths.
- If we have created enough commits to wrap up a feature or issue to warrant a production release, pull the latest main and release branches and then run `/do:release` from main
- **Archive approved design plans.** When a plan is approved out of plan mode, copy the finalized plan from `~/.claude/plans/` to `./docs/plans/YYYY-MM-DD-<slug>.md` (date of approval) as a design record before implementing. See `docs/plans/README.md`.

See `.changelog/README.md` for detailed format and best practices.
