# Stacker News stewardship

PortOS provides a Comms > Stacker News workspace for independently configured
Stacker News accounts and the communities they monitor or own. Account labels,
usernames, rules, territory ownership, monitoring opt-in, and model choices are
local runtime configuration; PortOS ships no account or community defaults.

## Safety model

- API keys are encrypted at rest and are never returned in API responses, logs,
  or model prompts.
- The GraphQL adapter accepts only named, typed operations against the fixed
  Stacker News endpoint. It does not relay arbitrary GraphQL or URLs.
- Posts, comments, URLs, images, and browser content are untrusted. The first
  analysis stage bounds and screens text for instruction-shaped content. A hit
  prevents the optional local Ollama text stage from receiving that content.
- Local Ollama output is parsed into a narrow schema and can only inform a
  recommendation. It has no account credential, browser, filesystem-write,
  shell, or external-action capability.
- Every proposed action starts pending review. Approving an action records the
  reviewer decision but does not enable automatic wallet, zap, boost, downzap,
  or Lightning-extension behavior.

## Current capability boundary

The initial integration supports account/territory configuration, protected API
connection checks, untrusted-content ingestion, deterministic screening,
optional local text analysis, and a review-gated action ledger. Monitoring is
off by default and no LLM call occurs at boot. Browser automation and
content-derived browser control are deliberately unavailable; PortOS never
extracts or stores browser cookies.

## Setup

1. Open **Comms > Stacker News > Accounts & Safety** and add an account.
2. Optionally enter its API key, then run the constrained connection check.
3. Add each territory/community and mark ownership per account.
4. Enter stewardship guidance at the account and territory level.
5. Configure a local Ollama text model only if you want on-demand analysis.

Do not enable automated money-moving behavior: it is deliberately unsupported.
