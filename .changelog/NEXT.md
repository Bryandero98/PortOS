## Added

- CoS now notices when a scheduled task (the overnight branch-reconcile loop) finishes the same work over and over in short-lived agent runs. It parks a looping coordinator so it stops burning quota, files one GitHub issue to fix the drain, and records per-run duration so the burst is visible as a metric.
- The Usage page can now record what you pay each month for your AI subscriptions (Claude, Codex, Antigravity, Grok) and shows what those plans saved against the estimated API cost. Each plan's price is prorated across whatever report window is selected, so both sides of the comparison cover the same days, and every plan gets its own row: monthly price, cost for this window, the API-rate cost its usage ran up, and the difference. Usage no subscription covers — pay-as-you-go API providers and pre-breakdown legacy rows — is reported separately instead of being credited to a plan.

## Fixed

- Voice dictation into the Shell terminal no longer garbles what you said. Apple dictation streams progressively refined guesses and rewrites what it already typed ("determin" → "determine" → "determines"); the terminal forwarded every insertion but none of the matching deletions, so a dictated sentence arrived at the prompt as an accumulating pile-up ("ddedeterdetermindeterminedetermines if any code…"). Dictation edits are now translated into the deletions and insertions a terminal understands, so the prompt shows the sentence you dictated.
- Tapping the notifications bell on a phone now opens a panel that stays on screen. It was anchored to the bell — which sits mid-screen in the sidebar — so the panel ran off the right edge, clipping notification titles and putting every per-item dismiss button and the mark-all/clear-all controls out of reach with nothing to scroll to them.
- The notification panel's "+N more notifications" line is now a "Show N more" button, so the notifications past the first ten can be read and dismissed instead of being permanently unreachable.
- Notification dismiss and "Mark read" buttons are now full-size, always-visible tap targets on touch devices — they were sized to their bare icon, and the dismiss button was only revealed on hover, which a phone has no way to do.
- The notification panel now closes on Escape, and long notification descriptions wrap to two lines instead of being cut off mid-word.
- Agent tasks run by a provider without slash commands (grok, OpenCode, codex, antigravity) now actually get their pull request merged. PortOS drives the whole push/PR/merge lifecycle for those providers via a follow-up task — and that task was written to the task file with `app: null`, which read back as an app named "null" and blocked the follow-up before it started. The PR, its branch, and its worktree were then left behind with nothing in the system that would ever land them.
- Merge follow-ups already stranded that way are revived on upgrade, so the pull requests they left open finally land. Their blocking reason was exempt from both the failed-task reaper and the automatic retry, so they would otherwise have sat blocked forever.
- Task metadata that has no value is no longer written to the task file at all. Any unset field previously became the literal word "null", which every reader then saw as a real value — the same class of bug as the blocked merge follow-up above. Task files an older version already wrote are repaired on read.
- Blocking a task that exists to merge a pull request now raises a notification naming that PR, so it can be landed by hand instead of going unnoticed. This covers every way a task can get blocked, not just the one fixed above.

## Changed

- Notification panel placement now goes through the shared popover-positioning hook that the theme switcher beside it already used, so it clamps into the viewport and flips above/below on its own instead of relying on hand-written positioning.
