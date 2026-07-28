# Unreleased Changes

## Quota burn

- **[issue-3179] Quota-burn no longer spends window budget on runs that never happened** — a scheduled quota-burn run counted against the family's per-window dispatch cap as soon as it was considered, even when it was subsequently skipped and no agent was ever started. Those phantom dispatches ate the budget, so a family configured for e.g. 5 burns per reset window could fire far fewer — and a family capped at 1 could never fire at all, because the skipped run consumed the only slot before the next gate re-read it. A burn is now counted once its agent has actually run, and a burn that is queued or in progress holds its slot in the meantime, so the cap stays accurate without letting a second app or a repeated "Run" overshoot it.
