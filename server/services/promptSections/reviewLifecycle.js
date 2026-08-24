/**
 * Review-loop, CI-gate, and merge prompt sections.
 */

import { DEFAULT_REVIEWER, DEFAULT_REVIEW_STOP_MODE, LOCAL_LLM_REVIEWERS, MODEL_CAPABLE_CLI_REVIEWERS, describeReviewerCli, isCliReviewer, reviewerCliBinary, normalizeReviewUsernames, normalizeOptionalReviewers, normalizeReviewerMaxRounds, reviewerEffortArgs, reviewerModelArg, resolveKeyedReviewers, buildReviewWithArgs } from '../../lib/validation.js';
import { oversizedBodyPointer } from '../../lib/slashdoInvocation.js';
import { detectForgeCli } from '../../lib/gitForge.js';
import { INLINE_REVIEW_LOOP_STEP } from './constants.js';
import { normalizeForgeCli } from './forge.js';

/**
 * True when a follow-up task is a **merge-only** run: it has a PR to land but no
 * reviewer to run (Review Loop off, or every configured reviewer was stripped —
 * e.g. copilot on a GitLab MR). Tolerates the string `'true'` because task
 * metadata round-trips through JSON/forms like every other CoS flag.
 *
 * Used both to pick the prompt section and to skip preloading the reviewer-only
 * slashdo bodies (`/do:rpr`, the local-agent review loop) that section ignores.
 */
export function isMergeOnlyFollowUp(metadata = {}) {
  return metadata?.reviewLoopMergeOnly === true || metadata?.reviewLoopMergeOnly === 'true';
}

/**
 * Build the **review-loop follow-up** section — the instructions for the
 * agent spawned by `spawnReviewLoopFollowUp` to drive Copilot's review-and-fix
 * loop until the PR merges. Same 7-step procedure, same merge command, same
 * MERGED-state verification, same 10-iteration cap in BOTH the light and full
 * paths — extracted so the two can't drift independently.
 *
 * I/O (the slashdo `/do:rpr` body) is intentionally pulled outside this helper
 * and threaded in via `rprBody` so the function stays pure and synchronous.
 *
 * @param {Object} metadata - task.metadata (reviewLoopPR* fields, sourceTaskId)
 * @param {Object} [opts]
 * @param {boolean} [opts.verbose=false] - When true, emit the verbose prose
 *   variant the full (api) path uses, with PR Details list and an inlined
 *   `/do:rpr` reference. When false, emit the compact list the light path uses.
 * @param {string|null} [opts.rprBody=null] - The loaded `/do:rpr` slashdo body.
 *   Only appended in verbose mode; ignored in compact mode.
 * @param {string|null} [opts.localAgentLoopBody=null] - The loaded slashdo
 *   `lib/local-agent-review-loop.md` body (conditionals resolved to the
 *   subprocess/`else` branch). Inlined when a spawnable CLI reviewer
 *   (codex/antigravity/claude/grok) is in the list so the agent gets the exact
 *   headless invocation and review-only contract instead of improvising it.
 * @param {string|null} [opts.localAgentLoopBodyPath=null] - Path to a staged copy
 *   of that body. When set and the body is over `SLASHDO_INLINE_BUDGET_CHARS`,
 *   the section points at the file instead of pasting it. Only the inline caller
 *   passes this; a follow-up agent, whose whole job is the loop, still inlines.
 * @param {boolean} [opts.inline=false] - Emit the SAME loop for an agent that
 *   opened the PR itself moments ago, rather than for a follow-up agent handed
 *   someone else's PR (`buildInlineReviewLoopSection`). Only the framing differs:
 *   the heading and opening sentence, and the fact that nothing pre-requested a
 *   Copilot review. The loop body, notes, merge command, and MERGED verification
 *   stay byte-identical so the two callers can't drift.
 * @returns {string}
 */
export function buildReviewLoopFollowUpSection(metadata = {}, { verbose = false, rprBody = null, localAgentLoopBody = null, localAgentLoopBodyPath = null, inlineExitStep = null, forgeCli = null } = {}) {
  // One parameter, not two: an `inline` boolean alongside it could disagree with
  // it, and the disagreement renders silently — `inline` with a blank exit step
  // emits a bare "6." and a truncated merge-gate hand-back.
  const inline = inlineExitStep !== null;
  const prUrl = metadata.reviewLoopPRUrl || '';
  const prBranch = metadata.reviewLoopPRBranch || '';
  const prNumber = metadata.reviewLoopPRNumber ?? '';
  const prOwner = metadata.reviewLoopPROwner ?? '';
  const prRepo = metadata.reviewLoopPRRepo ?? '';
  const sourceTaskId = metadata.sourceTaskId || 'unknown';
  const reviewForgeCli = normalizeForgeCli(forgeCli)
    || (detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? 'glab' : 'gh');
  // Merge-only follow-up (Review Loop off): no reviewer to wait on or invoke —
  // the whole job is CI-gate → fix → merge. Branch before any reviewer defaulting
  // below, which would otherwise resolve the empty list back to `[copilot]`.
  if (isMergeOnlyFollowUp(metadata)) {
    return buildMergeFollowUpSection({
      prUrl, prBranch, prNumber, prOwner, prRepo, sourceTaskId, verbose, inlineExitStep,
      prHost: metadata.reviewLoopPRHost ?? '',
      forgeCli: reviewForgeCli,
    });
  }
  // Arbitrary GitHub reviewer usernames (gate-only PR reviewers), appended to
  // the review flow after the keyed reviewers.
  const usernames = normalizeReviewUsernames(metadata.reviewLoopReviewerUsernames);
  // Ordered keyed reviewer list (back-compat: legacy single `reviewLoopReviewer`).
  // `reviewLoopReviewers` from spawnReviewLoopFollowUp is authoritative (copilot
  // already stripped on non-GitHub forges); resolveKeyedReviewers keeps an
  // explicit empty list empty when usernames carry the review (username-only).
  const reviewerSource = Array.isArray(metadata.reviewLoopReviewers)
    ? metadata.reviewLoopReviewers
    : (metadata.reviewLoopReviewer ? [metadata.reviewLoopReviewer] : undefined);
  const reviewers = resolveKeyedReviewers(reviewerSource, usernames.length > 0);
  // Reviewer identities marked non-blocking — emitted with slashdo's `~opt`.
  const optionalReviewers = normalizeOptionalReviewers(metadata.reviewLoopOptionalReviewers) || [];
  // Per-reviewer `~max=<n>` iteration caps, keyed by emitted token. An absent key
  // leaves slashdo's built-in per-loop default; `0` means "loop until clean".
  const reviewerMaxRounds = normalizeReviewerMaxRounds(metadata.reviewLoopReviewerMaxRounds) || {};
  const stopMode = metadata.reviewLoopStopMode || DEFAULT_REVIEW_STOP_MODE;
  const reviewerApplies = metadata.reviewLoopReviewerApplies === true;
  const hasCopilot = reviewers.includes(DEFAULT_REVIEWER);
  const hasLocalLlm = reviewers.some(r => LOCAL_LLM_REVIEWERS.includes(r));
  // Spawnable-CLI reviewers, in configured order.
  const cliReviewers = reviewers.filter(isCliReviewer);
  const hasCli = cliReviewers.length > 0;
  const hasGithubUser = usernames.length > 0;
  // Optional per-reviewer model pins (Code Review Defaults panel, or the task's own
  // ReviewerPicker row), threaded as a reviewer-keyed map. A model-capable CLI
  // reviewer in this loop's list gets a `<reviewer> --model <id>` note; a local-LLM
  // reviewer's pin goes into its `/api/code-review/local` request body instead
  // (below). Absent = let that reviewer use its own default. For an Ollama-backed
  // `claude` reviewer the id is the local Ollama model. Falls back to the legacy
  // codex-scalar metadata key so a follow-up task persisted by an older install
  // still threads its codex model.
  const reviewerModelMap = (metadata.reviewLoopReviewerModels && typeof metadata.reviewLoopReviewerModels === 'object')
    ? metadata.reviewLoopReviewerModels
    : (typeof metadata.reviewLoopCodexModel === 'string' && metadata.reviewLoopCodexModel
        ? { codex: metadata.reviewLoopCodexModel }
        : {});
  // Optional per-reviewer reasoning-effort pins, same two sources as the models.
  // A CLI reviewer's effort becomes a flag on the command line the agent runs
  // (`--effort high` for claude/agy, `-c model_reasoning_effort=high` for codex —
  // `reviewerEffortArgs` owns that shape, and returns nothing for cursor, whose
  // level is folded into `--model` by `reviewerModelArg`); a local-LLM reviewer's becomes the
  // `reasoning_effort` field of its `/api/code-review/local` body (below). There is
  // no slashdo `--review-with` suffix for effort, which is why it rides the
  // invocation rather than `equivArgs`.
  const reviewerEffortMap = (metadata.reviewLoopReviewerEfforts && typeof metadata.reviewLoopReviewerEfforts === 'object')
    ? metadata.reviewLoopReviewerEfforts
    : {};
  // One entry per CLI reviewer carrying a pinned model and/or effort, rendered as
  // the literal command line the agent must run. Reviewers are listed rather than
  // filtered to MODEL_CAPABLE_CLI_REVIEWERS up front because a CLI reviewer may
  // carry only one of the two pins (and `grok` carries neither). The per-flag
  // gates below decide what each entry renders; an entry with no flags drops out.
  const reviewerPinEntries = cliReviewers
    .map((r) => {
      const flags = [];
      // Thread each configured model id VERBATIM. We deliberately don't env-map it
      // here (e.g. bare Claude tier → Bedrock form): this is a text-template layer
      // with only a providerId, not the merged spawn env (process.env + settings.json
      // + provider.envVars) the CLI argv builder normalizes against — and the nested
      // reviewer CLI is spawned by the agent, not PortOS, so the argv chokepoint never
      // runs. The Code Review Defaults model field is free-text for exactly this
      // reason: the user configures the id their environment needs (a Bedrock-form id
      // on a Bedrock box, an installed Ollama model for an Ollama-backed `claude`).
      if (MODEL_CAPABLE_CLI_REVIEWERS.includes(r) && typeof reviewerModelMap[r] === 'string' && reviewerModelMap[r]) {
        // `reviewerModelArg` (not the raw id) because cursor carries its
        // reasoning effort INSIDE the model id — `gpt-5[effort=max]` — so the
        // pinned pair must render as ONE `--model`, never a `--effort` cursor
        // rejects. Every other reviewer gets the id back verbatim.
        flags.push(`--model ${reviewerModelArg(r, reviewerModelMap[r], reviewerEffortMap[r])}`);
      }
      const effortArgs = reviewerEffortArgs(r, reviewerEffortMap[r]);
      if (effortArgs.length) flags.push(effortArgs.join(' '));
      // Binary, not slug: this renders a literal command line, and the
      // `antigravity` slug names no executable.
      return flags.length ? `\`${reviewerCliBinary(r) || r} ${flags.join(' ')} …\`` : null;
    })
    .filter(Boolean);
  const reviewerPinNote = reviewerPinEntries.length
    ? ` When invoking a reviewer with a pinned model or reasoning effort, pass it: ${reviewerPinEntries.join(', ')}.`
    : '';
  // When the slashdo local-agent review loop is inlined below (a spawnable CLI
  // reviewer is in the list), point the invocation step at it so the agent runs
  // the exact headless recipe instead of probing the CLI's flags / hand-rolling
  // an invocation — the failure mode that had a codex CoS agent burn a dozen
  // exploratory `claude --help` / `claude -p 'hello'` / `--tools ''` probes
  // before it stumbled into a working review call.
  const cliProcedurePointer = (hasCli && localAgentLoopBody)
    ? ' Follow the **CLI Reviewer Procedure** section below for the exact headless invocation and review-only contract — do NOT probe the CLI or guess flags.'
    : '';
  // Each configured CLI reviewer paired with the command the agent must actually
  // run. Resolved ONCE — the slug-vs-binary distinction is the whole point of
  // this block, so every string below reads it from here rather than restating
  // the `|| slug` fallback. Unmapped slug ⇒ falls back to itself.
  const cliBinaries = cliReviewers.map(slug => ({ slug, binary: reviewerCliBinary(slug) || slug }));
  // `**codex / agy / claude**` — the CLI reviewers THIS loop configured, named by
  // the binary. Previously a fixed "codex / antigravity / claude / grok" string,
  // which both listed reviewers that weren't configured and named `antigravity`,
  // a command that exists on no PATH.
  const cliReviewerHeading = cliBinaries.map(c => c.binary).join(' / ');
  // Spell out slug → binary for any reviewer whose command differs from its
  // slug, so the agent can reconcile the configured list / `--review-with` token
  // with the executable named in the invocation table.
  const cliBinaryAliases = cliBinaries
    .filter(c => c.binary !== c.slug)
    .map(c => `the \`${c.slug}\` reviewer runs the \`${c.binary}\` binary (there is no \`${c.slug}\` command)`);
  const cliBinaryNote = cliBinaryAliases.length
    ? ` Reviewer slug → command: ${cliBinaryAliases.join('; ')}.`
    : '';
  // A configured reviewer that cannot run is NOT a clean review. Without this,
  // an agent whose reviewer binary was missing self-reviewed and merged anyway
  // — the exact regression this note blocks.
  const missingCliNote = hasCli
    ? `**Missing reviewer CLI:** verify each reviewer's binary is on PATH (${cliBinaries.map(c => `\`command -v ${c.binary}\``).join(' / ')}) before concluding it is unavailable. If a configured reviewer's binary genuinely is not installed, that reviewer is UNSATISFIED — do NOT substitute your own self-review and do NOT merge. Post a PR comment naming the missing command and exit.`
    : '';
  // "multi" reflects the TOTAL number of review sources (keyed reviewers +
  // username reviewers) so the ordered per-reviewer loop wording kicks in as
  // soon as there's more than one thing to satisfy.
  const multi = (reviewers.length + usernames.length) > 1;
  // The system pre-requests the initial Copilot review only when copilot LEADS the
  // order; otherwise the agent must request it at copilot's turn (so Copilot reviews
  // the post-CLI-fix state, not a stale diff). An INLINE loop opened its own PR
  // moments ago and nothing pre-requested anything, so it always requests.
  const copilotIsFirst = !inline && reviewers[0] === DEFAULT_REVIEWER;
  const reviewerLabel = [
    ...reviewers.map(r => `\`${r}\``),
    ...usernames.map(u => `\`@${u}\``),
  ].join(' → ');
  const equivArgs = buildReviewWithArgs(reviewers, { stopMode, reviewerApplies, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels: reviewerModelMap });
  const equiv = equivArgs ? ` (equivalent to \`/do:pr ${equivArgs}\`)` : '';

  // First step: how to obtain a review. For a single copilot/CLI reviewer keep the
  // focused wording; for a list, dispatch each reviewer in order. Only emit the
  // per-reviewer-kind bullet that actually applies to the configured list.
  // `lmstudio`/`ollama` don't have CLIs the agent can spawn — PortOS exposes
  // `POST /api/code-review/local` which runs the configured local model against
  // the diff and returns findings text. The agent always reaches it via
  // `http://localhost:5555` (the canonical loopback API port).
  // A pinned local-LLM model can't ride the endpoint's server-side default: that
  // reads the GLOBAL settings scalar and has never seen this task. So when the
  // user pinned one on the reviewer's row, name it in the request body — `model`
  // in the POST body overrides the configured default (see routes/codeReview.js).
  // Absent pin ⇒ omit the key entirely rather than sending `""`, which would be a
  // model id the backend can't resolve.
  // The pinned reasoning effort rides the same body as `effort` — the endpoint
  // forwards it as the backend's OpenAI-compatible `reasoning_effort`. Same
  // absent-vs-empty contract as the model: no pin ⇒ the key is omitted, not blank.
  // Which body keys this run actually pins, accumulated across the local-LLM
  // reviewers in the list. The jq example below is built from THIS set rather than
  // naming both keys unconditionally: an effort-only run that was shown a
  // `model: "…"` placeholder would have the agent send the literal ellipsis, and
  // the route's `body.model || configured` prefers that truthy junk over the
  // install default — turning a pinned-effort review into a model-not-found error.
  const pinnedString = (map, r) => (typeof map[r] === 'string' && map[r] ? map[r] : null);
  const localLlmPins = LOCAL_LLM_REVIEWERS
    .filter(r => reviewers.includes(r))
    .map(r => ({ reviewer: r, model: pinnedString(reviewerModelMap, r), effort: pinnedString(reviewerEffortMap, r) }))
    .filter(p => p.model || p.effort);
  const localLlmPinNote = localLlmPins.map(({ reviewer, model, effort }) => {
    const keys = [
      ...(model ? [`"model": "${model}"`] : []),
      ...(effort ? [`"effort": "${effort}"`] : [])
    ];
    return `\`${reviewer}\` → \`${keys.join(', ')}\``;
  });
  // Both strings derive from the same `localLlmPins` array rather than the jq line
  // reading a Set the note's `.map` filled as a side effect — that coupling meant
  // hoisting one line above the other silently emptied the key list.
  const localLlmPinJq = [
    'backend: "…"',
    ...(localLlmPins.some(p => p.model) ? ['model: "…"'] : []),
    ...(localLlmPins.some(p => p.effort) ? ['effort: "…"'] : []),
    'diff: .'
  ].join(', ');
  const diffCommand = reviewForgeCli === 'glab'
    ? `glab mr diff ${prNumber || '<MR_NUMBER>'}`
    : `gh pr diff ${prNumber || '<PR_NUMBER>'}`;
  const localLlmInvocation = `POST the diff to PortOS's local reviewer endpoint and extract its review text before evaluating it. Substitute the active reviewer name for \`<lmstudio|ollama>\`:
\`\`\`bash
REVIEW_RESPONSE=$(mktemp)
${diffCommand} | jq -Rs '{ backend: "<lmstudio|ollama>", diff: . }' | curl -sS -X POST http://localhost:5555/api/code-review/local -H 'Content-Type: application/json' -d @- > "$REVIEW_RESPONSE"
if ! jq -er '.findings | select(type == "string" and length > 0)' "$REVIEW_RESPONSE" > "\${REVIEW_RESPONSE}.findings"; then
  echo "Local reviewer failed: $(jq -r '.error // "missing .findings in reviewer response"' "$REVIEW_RESPONSE")" >&2
  STATUS=cli-error # Never treat an absent or malformed response as clean.
  exit 1
else
  cat "\${REVIEW_RESPONSE}.findings"
fi
\`\`\`
Only a successfully extracted \`.findings\` value is the review text; treat it like any other reviewer's findings.${localLlmPinNote.length
  ? ` This run pins settings for ${localLlmPinNote.join(', ')} — add those keys to the JSON body (\`jq -Rs '{ ${localLlmPinJq} }'\`) so the review runs with them instead of the install defaults. Send ONLY the keys named above; a key with no pinned value overrides the install default with junk.`
  : ''}`;
  // Instruct the agent to request each username reviewer as a PR reviewer and
  // gate the merge on their approval. `gh pr edit --add-reviewer` takes the bare
  // login, so strip the `@`.
  const githubUsersInvocation = reviewForgeCli === 'glab'
    ? `request ${usernames.map(u => `\`@${u}\``).join(', ')} as MR reviewer${usernames.length > 1 ? 's' : ''} using the GitLab project UI or API, then inspect \`glab mr view ${prNumber || '<MR_NUMBER>'}\` for their review and address any findings; their approval gates the merge.`
    : `request ${usernames.map(u => `\`@${u}\``).join(', ')} as PR reviewer${usernames.length > 1 ? 's' : ''} (\`gh pr edit ${prNumber || '<PR_NUMBER>'} --add-reviewer <user>\`, drop the \`@\`), then wait for their review (poll every 5–15s) and address any findings; their approval gates the merge.`;
  const multiBullets = [
    hasCopilot ? `**copilot**: ${copilotIsFirst
      ? 'wait for the initial Copilot review the system already pre-requested (Copilot leads the list)'
      : 'request a Copilot review when you reach its turn'} (poll every 5–15s, max 5 min/round), then re-request on later rounds.` : null,
    hasCli ? `**${cliReviewerHeading}**: invoke that CLI to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff <base-branch>...HEAD\`; on GitHub \`gh pr diff ${prNumber || ''}\` also works).${cliBinaryNote}${reviewerPinNote}${cliProcedurePointer}` : null,
    hasLocalLlm ? `**lmstudio / ollama**: ${localLlmInvocation}` : null,
    hasGithubUser ? `**@github reviewers**: ${githubUsersInvocation}` : null,
  ].filter(Boolean).join(' ');
  // Name the BINARY, not the slug: `Invoke the \`antigravity\` CLI` sent a
  // follow-up agent hunting for a command that does not exist.
  const singleCliInvocation = `Invoke ${describeReviewerCli(cliReviewers[0])} to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff <base-branch>...HEAD\`; on GitHub \`gh pr diff ${prNumber || ''}\` also works). Capture its findings as concrete issues to address.${reviewerPinNote}${cliProcedurePointer}`;
  // Resolved sequentially so a future reviewer kind only adds one branch
  // instead of deepening the nested ternary.
  let waitOrInvokeStep;
  if (multi) waitOrInvokeStep = `For EACH reviewer in order — ${reviewerLabel} — run a full review-and-fix sub-loop before advancing to the next. ${multiBullets}`;
  else if (hasCopilot) waitOrInvokeStep = 'Wait for the latest Copilot review to complete (poll every 5–15s, max 5 minutes per round); the system already requested the initial review.';
  else if (hasLocalLlm) waitOrInvokeStep = localLlmInvocation;
  else if (hasCli) waitOrInvokeStep = singleCliInvocation;
  else waitOrInvokeStep = `To obtain a review, ${githubUsersInvocation}`;

  const stopModeNote = stopMode === 'on-findings'
    ? '**Stop mode (on-findings):** stop after the FIRST reviewer whose findings you actually fixed and committed; skip the remaining reviewers.'
    : stopMode === 'on-clean'
      ? '**Stop mode (on-clean):** stop after the FIRST reviewer that reports zero findings; skip the remaining reviewers.'
      : (multi ? '**Stop mode (all):** run every reviewer in the list, in order, before merging.' : '');

  const applyNote = hasCli
    ? (reviewerApplies
        ? '**Reviewer applies:** let each CLI reviewer apply its own fixes to the working tree, then verify, run tests, and push.'
        : "**Reviewer applies (off):** read each CLI reviewer's findings and apply the fixes yourself (default).")
    : '';

  // Inline runs opened the PR seconds ago inside their own completion workflow,
  // so nothing pre-requested anything — claiming otherwise would have the agent
  // poll forever for a Copilot review no one asked for.
  const initialReviewState = inline
    ? 'Nothing has reviewed this PR yet — you must request/invoke each configured reviewer yourself against its diff.'
    : (hasCopilot && copilotIsFirst)
    ? 'The system has already requested the initial Copilot code review (Copilot leads the order).'
    : hasCopilot
      ? 'Copilot is configured after another reviewer, so the system did NOT pre-request it — request the Copilot review yourself when you reach its turn (after the earlier reviewers’ fixes are pushed), and invoke the other reviewers yourself.'
      : 'The system did NOT pre-request a reviewer because no Copilot review leads the order — you must request/invoke each configured reviewer yourself against the PR diff.';
  const repeatedCommentsNote = '**Repeated comments:** If a fresh review round only re-raises feedback you intentionally rejected (with a reply explaining why), treat that round as clean and move on.';
  // Challenge protocol (#2471): auto-invoke the bounded worker↔reviewer dispute
  // from the review loop. When a reviewer's BLOCKING finding is a false positive,
  // the agent disputes it once via POST /challenge instead of silently complying
  // or accepting a false block, then RE-CHECKS (re-run reviewer) to overturn or
  // escalate. One challenge per task, also bounded by the task's retry budget —
  // a second dispute or an out-of-retries task returns 409.
  const challengeProtocolNote = [
    '**Challenge protocol (dispute a wrong rejection — use sparingly):** If a reviewer raises a BLOCKING finding you have strong, specific evidence is a false positive (it misread the diff, flagged intended behavior, or contradicts a documented repo convention), do NOT silently "fix" it or accept a false block — dispute it **exactly once** for this task:',
    '```bash',
    `curl -sS -X POST http://localhost:5555/api/cos/tasks/${sourceTaskId}/challenge -H 'Content-Type: application/json' -d '{"reason":"<why the finding is wrong>","evidence":"<file:line or diff quote>","reviewer":"<disputed reviewer>"}'`,
    '```',
    'A `409` (`CHALLENGE_EXHAUSTED` = the one challenge is spent, or `CHALLENGE_BUDGET_EXHAUSTED` = the task is out of retry budget) means you can\'t dispute — then fix the finding or, if genuinely blocked, post a PR comment and stop. After filing, RE-CHECK: re-run the disputed reviewer (or another configured reviewer) against the current diff, then resolve — overturned → `POST .../challenge/resolve` with `{"outcome":"upheld"}` and continue to merge; confirmed → fix it, or send `{"outcome":"escalated"}` to hand the dispute to the user.' + (hasLocalLlm ? ' For a local reviewer you may instead POST `{"recheck":{"backend":"<lmstudio|ollama>","diff":"<unified diff>"}}` and let the server re-run it and auto-derive the outcome.' : ''),
  ].join('\n');
  // Per-reviewer round caps. This prompt drives the loop in PROSE (it isn't
  // slashdo parsing a `~max=<n>` suffix), so a configured cap only binds if it's
  // spelled out here — the `equiv` flag string alone documents intent without
  // constraining the agent. `0` is slashdo's "loop until clean", so it's rendered
  // as such rather than as a zero-round budget.
  const maxRoundsEntries = Object.entries(reviewerMaxRounds)
    .filter(([token]) => reviewers.includes(token) || usernames.some(u => `@${u}`.toLowerCase() === token.toLowerCase()))
    .map(([token, max]) => `\`${token}\` → ${max === 0 ? 'loop until clean (no cap)' : `${max} round${max === 1 ? '' : 's'}`}`);
  const maxRoundsNote = maxRoundsEntries.length
    ? `**Round caps (~max):** stop these reviewers after their budget even if findings remain, then advance: ${maxRoundsEntries.join(', ')}. Spending a configured budget is a SUCCESS, not a failure — do not block the merge on it. Reviewers not listed keep the default cap below.`
    : '';

  const extraNotes = [stopModeNote, applyNote, maxRoundsNote, missingCliNote].filter(Boolean);

  // Inline slashdo's local-agent review loop verbatim when a spawnable CLI
  // reviewer is configured. This is the maintained, precise recipe — exact
  // per-CLI headless invocation (`claude -p "$LOCAL_PROMPT" --dangerously-skip-permissions`,
  // `codex --sandbox read-only review --base …`, etc.), the review-only /
  // no-sub-agent-fan-out `$LOCAL_PROMPT` contract, and the parse-and-apply
  // handling. Without it the agent only sees "invoke that CLI" and reverse-
  // engineers the invocation, wasting calls. The inlined body AGREES with
  // cliBinaryNote rather than contradicting the "follow it verbatim" order —
  // slashdo's per-CLI invocation table names `agy` and normalizes the
  // `gemini`/`antigravity` slugs onto it, so the note is a pointer into that
  // table, not a correction layered over it. Conditionals were resolved to the
  // subprocess (`else`) branch by loadSlashdoLib, so no in-process-Agent-tool
  // branch leaks in to confuse a non-Claude-Code host.
  //
  // Over budget WITH a staged copy on disk (`localAgentLoopBodyPath`, only ever
  // passed for an inline loop — see buildAgentPrompt) the agent is pointed at the
  // file instead. Same trade `buildSlashdoSection` makes: an initial run is
  // already carrying the real task, and pasting 40KB of reviewer recipe up front
  // to be read at step 4 is the wrong place to spend that context.
  const cliProcedureHeader = `\n### CLI Reviewer Procedure (${cliReviewerHeading})\n\nDrive each spawnable CLI reviewer EXACTLY as the slashdo local-agent review loop specifies — use its per-CLI invocation and review-only prompt contract verbatim; do NOT probe the CLI's \`--help\`, test it with throwaway prompts, or hand-roll flags. Run the reviewer once per round, capture its findings, and (unless reviewer-applies is set) apply the fixes yourself.\n\n`;
  //
  // The path IS the decision — it is non-null only when the caller already
  // measured the body over budget and staged it. Re-testing the length here
  // would give the two sites a way to disagree, and the disagreement is silent:
  // the file gets written AND the 40KB still gets pasted.
  const cliReviewerProcedure = (hasCli && localAgentLoopBody)
    ? (localAgentLoopBodyPath
      ? `${cliProcedureHeader}${oversizedBodyPointer(localAgentLoopBodyPath, localAgentLoopBody)}\n`
      : `${cliProcedureHeader}${localAgentLoopBody}\n`)
    : '';

  // A JIRA-tracked PR is a human's to land (its ticket is already "In Review" and
  // nothing here can transition it), so this follow-up reviews and stops. Emitted
  // as the same steps 4-6 so the loop body above stays identical either way.
  const leaveOpen = metadata.reviewLoopLeaveOpen === true || metadata.reviewLoopLeaveOpen === 'true';
  const objective = leaveOpen
    ? '**Your job is to drive the review-and-fix loop to completion. Do NOT merge — this PR is tracked in JIRA and a human lands it.**'
    : '**Your job is to drive the review-and-fix loop to completion and merge the PR.**';
  // Where the loop hands control back. A follow-up agent's whole task WAS the
  // loop, so it exits; an inline loop is one step of a larger completion
  // workflow that still owes the run its `.agent-done` sentinel — telling it to
  // "exit" here leaves a finished merge without the sentinel that records it.
  const exitStep = inline
    ? `6. ${inlineExitStep}`
    : `6. Exit. Do **not** run \`/do:push\` or open a new PR${leaveOpen ? '' : ' — the merge handles everything'}. The system will clean up your worktree on exit.`;
  const closingSteps = leaveOpen
    ? [
      '4. When the reviewer list is exhausted (or the stop mode triggers), **leave the PR open** — do NOT merge it, and do NOT delete the branch. Its JIRA ticket is sitting in review and a human lands both together; merging here would leave the work merged and the ticket stuck in review.',
      // Forge-aware: `gh pr comment` fails outright on a GitLab MR URL.
      `5. Post a short comment on the ${detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? 'MR' : 'PR'} summarising what the reviewers raised and what you fixed, so the human landing it knows the state: ${detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? `\`glab mr note ${prNumber !== '' ? prNumber : '<MR_NUMBER>'} --message "<summary>"\`` : `\`gh pr comment "${prUrl}" --body "<summary>"\``}.`,
      exitStep,
    ]
    : [
      `4. When the reviewer list is exhausted (or the stop mode triggers), merge the PR **immediately** with this exact command (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged):`,
      '   ```bash',
      reviewForgeCli === 'glab'
        ? `   glab mr merge "${prNumber || '<MR_NUMBER>'}" --yes --remove-source-branch`
        : `   gh pr merge "${prUrl}" --merge --delete-branch`,
      '   ```',
      reviewForgeCli === 'glab'
        ? null
        : (prOwner && prRepo && prNumber ? `   (Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --merge --delete-branch\`.)` : null),
      '   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.',
      reviewForgeCli === 'glab'
        ? `5. Confirm the MR is actually merged before exiting: \`glab mr view "${prNumber || '<MR_NUMBER>'}"\` must show it merged. If it is still open or was closed unmerged, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until it is merged.`
        : `5. Confirm the PR is actually merged before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until state is \`MERGED\`.`,
      exitStep,
    ].filter(Boolean);

  // Framing only — everything below it is identical for both callers.
  const heading = inline ? '## Review Loop' : '## Review-Loop Follow-up (PRIMARY OBJECTIVE)';
  const opening = inline
    ? `This runs as **step ${INLINE_REVIEW_LOOP_STEP} of the Completion Workflow above**, against the PR you just opened on \`${prBranch}\` (\`${prUrl}\` / \`${prNumber}\` are the shell variables you captured there). ${initialReviewState} ${objective}`
    : `A previous agent finished implementing the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on branch \`${prBranch}\`. ${initialReviewState} ${objective}`;

  if (verbose) {
    return `
${heading}
${opening}

**Reviewers (in order)**: ${reviewerLabel}${equiv}.
${extraNotes.length ? '\n' + extraNotes.join('\n') + '\n' : ''}
**Run this loop UNTIL all configured reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**

1. ${waitOrInvokeStep}
2. If there are unresolved review findings, fix them in this worktree, run the project's tests, commit (\`feat:\`/\`fix:\` prefix, no Co-Authored-By), push, and (for Copilot) resolve the addressed threads.
3. Re-review with the same reviewer until it reports clean, then advance to the next reviewer in the list.
${closingSteps.join('\n')}

**Hard stop:** if a reviewer's loop hasn't converged after 10 iterations, post a PR comment summarising the unresolved blockers and exit. Do not loop indefinitely.

${repeatedCommentsNote}

${challengeProtocolNote}

PR Details:
- **URL**: ${prUrl}
- **Branch**: \`${prBranch}\`
${prNumber !== '' ? `- **Number**: ${prNumber}` : ''}
${prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : ''}
- **Source task**: ${sourceTaskId}
- **Reviewers**: ${reviewerLabel}
${cliReviewerProcedure}${(rprBody && (hasCopilot || hasGithubUser)) ? `\n### /do:rpr Reference — Copilot / @github reviewers (full procedure)\n\nThis is the PR-comment review loop for the **copilot** and **@github** reviewers only (request a review on the PR, poll for comments, resolve threads).${cliReviewerProcedure ? ' It does NOT apply to the local CLI reviewers — for those, follow the **CLI Reviewer Procedure** above instead.' : ''}\n\n${rprBody}\n` : ''}`;
  }

  // Compact light-path variant.
  const compactOpening = inline
    ? opening
    : `A previous agent finished task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. ${initialReviewState} ${leaveOpen ? 'Drive the review-and-fix loop to completion — do NOT merge (JIRA-tracked; a human lands it).' : 'Drive the review-and-fix loop to completion and merge.'}`;
  return [
    heading,
    compactOpening,
    `**Reviewers (in order)**: ${reviewerLabel}${equiv}.`,
    ...extraNotes,
    '',
    '**Loop UNTIL all reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**',
    `1. ${waitOrInvokeStep}`,
    '2. If unresolved findings: fix in this worktree, run tests, commit (`feat:`/`fix:` prefix, no Co-Authored-By), push' + (hasCopilot ? ', and (for Copilot) resolve the addressed threads.' : '.'),
    '3. Re-review with the same reviewer until clean, then advance to the next reviewer in the list.',
    ...closingSteps,
    '',
    '**Hard stop:** if a reviewer is not converged after 10 rounds, post a PR comment summarising blockers and exit.',
    repeatedCommentsNote,
    '',
    challengeProtocolNote,
    cliReviewerProcedure
  ].filter(Boolean).join('\n');
}

/**
 * The step that replaces the merge steps when a PR is a human's to land — a
 * JIRA-tracked task whose ticket is already "In Review" (see
 * `lib/prDisposition.js`). Merging would land the work while the board still
 * shows it in review, and no completion path here can transition the ticket.
 */
export const LEAVE_PR_OPEN_STEP = (step, jiraTracked = false) => `${step}. **Leave the PR open — do NOT merge it.** ${jiraTracked
  ? 'This task is tracked in JIRA: its ticket is in review and a human lands the PR and the ticket together.'
  : 'This task is configured to stop after opening the PR so a human can inspect and land it.'} Report the PR URL in your summary and stop.`;

/**
 * The CI-gated merge procedure, in numbered steps starting at `startStep`.
 *
 * This is the single definition of "no reviewer is configured, so CI is the
 * merge gate" — shared by every flow that reaches it: the agent's own completion
 * workflow (slashdo TUI + Claude Code CLI via `buildPostPRMergeSteps`) and the
 * merge follow-up agent PortOS spawns when it opened the PR itself. They differ
 * only in how the PR is addressed and whether GitLab commands are offered, so
 * those are parameters rather than hand-written copies that drift.
 *
 * Ends on the same merge command + MERGED verification as the review-loop
 * contract (`buildReviewLoopFollowUpSection`): a true merge commit keeps the
 * branch tip in the base branch's history, which is what lets automated worktree
 * cleanup prove the branch landed.
 *
 * @param {number} startStep - number of the first emitted step.
 * @param {Object} opts
 * @param {string} opts.prRef - how to address the PR in `gh` commands, already
 *   quoted: the `"<PR_URL>"` placeholder before the PR exists, or the real URL.
 * @param {string} [opts.mrRef] - how to address the MR in `glab` commands.
 *   **`glab mr merge` selects by MR IID or source branch — NOT by URL**, so this
 *   is the number (or a `<MR_NUMBER>` placeholder), never `prRef`.
 * @param {'github'|'gitlab'|'unknown'} [opts.forge] - which CLI to name. PortOS
 *   opens GitLab MRs too (`git.createPR` falls back to `glab`), so a follow-up
 *   whose PR host is a GitLab instance must not be handed `gh` commands it can't
 *   run. Callers derive this with `detectForgeCli` — a GitHub Enterprise host is
 *   `github`, not "not github.com". `unknown` (the agent's own completion
 *   workflow, which runs before the PR exists) emits both, commented.
 * @returns {{lines: string[], nextStep: number}}
 */
export function buildCiMergeGateSteps(startStep, { prRef, mrRef = '<MR_NUMBER>', forge = 'github', alreadyMergedHint = ' (a saved `/do:pr` default can merge it for you)' }) {
  const gh = forge !== 'gitlab';
  const glab = forge !== 'github';
  const both = gh && glab;
  const checksCmd = gh
    ? `\`gh pr checks ${prRef} --watch --fail-fast --interval 30\`${glab ? ' (GitLab: `glab ci status`)' : ''}`
    : '`glab ci status`';
  const mergeableCmd = gh
    ? `\`gh pr view ${prRef} --json mergeable -q .mergeable\` reports \`CONFLICTING\`${glab ? ' (GitLab: `glab mr view ' + mrRef + '` shows a conflict)' : ''}`
    : `\`glab mr view ${mrRef}\` shows a conflict with the target branch`;
  const stateCmd = gh
    ? `\`gh pr view ${prRef} --json state -q .state\` must return \`MERGED\`${glab ? ' (GitLab: `glab mr view ' + mrRef + '` must show it merged)' : ''}`
    : `\`glab mr view ${mrRef}\` must show it merged`;
  const lines = [
    `${startStep}. **Wait for CI to finish**: ${checksCmd}. "No checks reported" is AMBIGUOUS — a just-opened PR reports it while checks are still attaching, and merging on it races the CI this gate exists to wait for. Treat it as green ONLY when the repo genuinely has no CI (${gh ? '`gh workflow list` is empty / nothing in `.github/workflows` triggers on pull_request, and no external status check is configured' : 'no `.gitlab-ci.yml` and no pipeline is configured'}). If CI IS expected, wait 30s and re-check for up to 5 minutes — and if it still hasn't attached, **leave the PR open and say so**; never merge on checks that were expected but never appeared.`,
    `${startStep + 1}. **Clear whatever blocks the merge, then re-check.** If a check failed, read the failing job's log (${gh ? `\`gh run view --log-failed\`${glab ? ' on GitHub, `glab ci trace` on GitLab' : ''}` : '`glab ci trace`'}), fix the cause here, run the project's tests, commit (\`fix:\` prefix, no Co-Authored-By), push, and go back to the previous step — cap this at 5 rounds. If ${mergeableCmd}, \`git fetch origin\`, rebase onto the base branch, resolve the conflicts keeping BOTH sides' intent, re-run the tests, \`git push --force-with-lease\`, and re-check.`,
    `${startStep + 2}. **Merge** with exactly these flags, nothing else — a true merge commit keeps the branch tip in the base branch's history so automated worktree cleanup can prove the branch is merged, and any merge-deferral flag leaves the PR open after you exit. If it is already merged${alreadyMergedHint}, skip to the next step:`,
    '   ```bash',
    gh ? `   ${both ? '# GitHub:  ' : ''}gh pr merge ${prRef} --merge --delete-branch` : null,
    // `glab mr merge` takes an MR IID or source branch — a URL is not accepted.
    glab ? `   ${both ? '# GitLab:  ' : ''}glab mr merge ${mrRef} --yes --remove-source-branch` : null,
    '   ```',
    // Not every repo allows merge commits; a repo restricted to squash/rebase
    // rejects `--merge` outright, which would leave the PR open forever.
    gh ? `   If that is rejected because this repo disallows merge commits, re-check what it allows (\`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed\`) and merge with an allowed method instead — \`--squash\` first, else \`--rebase\` — keeping \`--delete-branch\`.` : null,
    `${startStep + 3}. **Confirm the merge before exiting**: ${stateCmd}. If it is still open or was closed unmerged, investigate (failing check, merge conflict, branch protection), fix, and retry. Leave it open — saying so explicitly in your completion summary — if CI stays red after a genuine fix attempt, a conflict needs a human decision, expected checks never attached, or a branch protection you cannot satisfy blocks the merge (a required approving review, a required check only a human can trigger). Hand those to a human rather than retrying until you time out.`,
  ].filter(Boolean);
  return { lines, nextStep: startStep + 4 };
}

/**
 * Build the **merge follow-up** section — the instructions for the agent
 * `spawnReviewLoopFollowUp` spawns when no reviewer survived resolution (Review
 * Loop off, or copilot-only on a non-GitHub forge). Nothing else will touch the
 * PR, so the merge gate is CI alone (`buildCiMergeGateSteps`).
 *
 * @param {Object} opts - PR coordinates + `verbose` (full/api path) vs compact.
 * @returns {string}
 */
function buildMergeFollowUpSection({ prUrl, prBranch, prNumber = '', prOwner = '', prRepo = '', prHost = '', sourceTaskId = 'unknown', verbose = false, inlineExitStep = null, forgeCli = null }) {
  const inline = inlineExitStep !== null;
  // PortOS opens GitLab MRs via `glab` too, so a GitLab host must not be handed
  // `gh` commands (the host is persisted by spawnReviewLoopFollowUp). Classify
  // with the shared detector — a GitHub Enterprise host is still `gh`, which a
  // bare `host !== 'github.com'` test would get wrong.
  //
  // An INLINE gate has no persisted host to classify — its PR does not exist yet
  // — so the caller supplies the forge already selected for the create step.
  // Falling back to GitHub preserves the historical manual workflow when no
  // remote metadata is available.
  const gate = buildCiMergeGateSteps(1, {
    prRef: `"${prUrl}"`,
    mrRef: prNumber !== '' ? `${prNumber}` : '<MR_NUMBER>',
    forge: inline
      ? (normalizeForgeCli(forgeCli) === 'glab' ? 'gitlab' : 'github')
      : (detectForgeCli(prHost) === 'glab' ? 'gitlab' : 'github'),
    // An inline run reached this gate through plain `git`/`gh` — it never ran
    // `/do:pr`, so a saved slashdo merge default can't have landed the PR for it.
    alreadyMergedHint: inline ? '' : undefined,
  });
  const steps = [
    ...gate.lines,
    inline
      ? `${gate.nextStep}. ${inlineExitStep} Do NOT start a code review — none is configured for this task.`
      : `${gate.nextStep}. Exit. Do NOT run \`/do:push\`, do NOT open a new PR, and do NOT start a code review — landing this PR is the whole job.`,
  ];
  const prDetails = verbose ? [
    '',
    'PR Details:',
    `- **URL**: ${prUrl}`,
    `- **Branch**: \`${prBranch}\``,
    prNumber !== '' ? `- **Number**: ${prNumber}` : null,
    prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : null,
    `- **Source task**: ${sourceTaskId}`,
  ].filter(Boolean) : [];

  return [
    inline ? '## Merge Gate' : '## Merge Follow-up (PRIMARY OBJECTIVE)',
    inline
      ? `This runs as **step ${INLINE_REVIEW_LOOP_STEP} of the Completion Workflow above**, against the PR you just opened on \`${prBranch}\` (\`${prUrl}\` / \`${prNumber}\` are the shell variables you captured there). **No code review was requested for this task, so nothing else will merge this PR — land it yourself once CI is green.**`
      : `A previous agent finished the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. **No code review was requested for this task, so nothing else will merge this PR — your job is to land it once CI is green.**`,
    '',
    ...steps,
    '',
    '**Hard stop:** if CI is still red after 5 fix rounds, or a conflict needs a product decision you can\'t make, post a PR comment summarising exactly what is blocking the merge and exit with the PR left open. Do not force a merge over red CI.',
    ...prDetails,
  ].join('\n');
}
