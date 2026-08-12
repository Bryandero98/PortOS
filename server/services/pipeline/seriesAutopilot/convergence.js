/**
 * Series Autopilot — convergence tracking & pause-reason copy (#2842 split of
 * seriesAutopilot.js). The bounded-loop bookkeeping (`trackConvergence`,
 * `DIVERGENCE_PATIENCE`) and the human-readable reason strings each gate pauses
 * with, plus the dry-run cost arithmetic they share.
 */

// Per-gate copy for the non-convergence pause — shared by the arc-verify and
// editorial loops so the two messages can't drift.
const PAUSE_GATES = {
  arc: { label: 'Arc verification', fix: 'Edit the arc/volumes to address them', limit: 'verify-rounds' },
  beatContinuity: { label: 'Beat continuity', fix: 'Edit the affected issue beats', limit: 'beat-continuity-rounds' },
  editorial: { label: 'Editorial review', fix: 'Address them in the manuscript editor', limit: 'editorial-rounds' },
  foundation: { label: 'Foundation quality', fix: 'Strengthen the world / characters / arc, or lower the threshold', limit: 'foundation-rounds' },
};
export function convergencePauseReason(gate, maxRounds, blockingCount) {
  const { label, fix, limit } = PAUSE_GATES[gate];
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't auto-resolve ${blockingCount} blocking finding(s) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}

// Divergence/oscillation guard for the bounded convergence loops (#1571). A
// verify→resolve round is "profitable" only when the next verify shows STRICTLY
// FEWER blocking findings. When the count fails to drop (stays equal, or rises —
// a resolve pass that introduced a new break while fixing another) for
// DIVERGENCE_PATIENCE consecutive rounds, the loop is no longer converging:
// stop early and pause with a `divergence` kind instead of burning the rest of
// the daily cos budget down to maxRounds. The terminal maxRounds pause keeps its
// own `maxRounds` kind — the two are distinguished in the pause SSE frame so the
// UI can tell "needs a human" (diverging) from "just ran out of rounds".
//
// With the default caps (arc 3 / beat 2 / editorial 2) the loop hits maxRounds
// before the streak can reach patience, so default runs are unaffected; the
// guard only bites when a user RAISES a cap and the loop then stalls.
export const DIVERGENCE_PATIENCE = 2;

// Convergence tracker for one verify→resolve round. `state` is
// { best, sinceBest }: `best` is the FEWEST blocking findings seen so far this
// loop (null before the first measured round), `sinceBest` the count of
// consecutive rounds since that minimum last STRICTLY improved. A round that
// reaches a new low is progress (sinceBest → 0); a stall, a regression (a fix
// that introduced a new break), OR an oscillation that merely revisits an old
// count all accrue sinceBest. The loop diverges once sinceBest reaches
// DIVERGENCE_PATIENCE. Tracking the running minimum (not just the previous
// round) is what lets this catch a 2-cycle oscillation — e.g. 5→4→5→4 never
// sets a new low after round 2, so it's caught — which a naive
// "compare to the previous round" check would miss. Pure + unit-tested.
export function trackConvergence(state, curr) {
  if (state.best === null || curr < state.best) {
    return { best: curr, sinceBest: 0 };
  }
  return { best: state.best, sinceBest: state.sinceBest + 1 };
}

// Pause reason for a gate that stopped converging early (#1571) — distinct
// wording from convergencePauseReason's "ran out of rounds".
export function divergencePauseReason(gate, blockingCount, rounds) {
  const { label, fix } = PAUSE_GATES[gate];
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped converging — ${blockingCount} blocking finding(s) and no net progress over `
    + `${rounds} consecutive ${plural} of auto-resolve. Paused for review. ${fix}, then resume.`;
}

// ---------------------------------------------------------------------------
// Auto-resolve REGRESSION guard — one altitude tighter than the divergence
// guard above. Divergence asks "is the loop still making progress?" over several
// rounds and pauses on the state it finds; this asks "did THIS round's edits
// make the draft worse?" so the caller can put the pre-resolve state back before
// pausing. Without it, a resolve pass that rewrites the arc into MORE blocking
// findings than it was handed is committed permanently, and the run pauses on
// damage it caused itself.
// ---------------------------------------------------------------------------

// Normalizer behind the finding matcher, hoisted so the regexes aren't rebuilt
// per finding per round.
const normFindingText = (v) => String(v ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Singularize one token so "volumes"/"volume" and "stages"/"stage" don't read
// as two different words — the single most common way the verifier re-words
// itself between calls.
const stemToken = (tok) => (tok.endsWith('s') ? tok.slice(0, -1) : tok);

// Words that carry no identity for a verify finding: ordinary connective tissue
// plus the structural nouns ("volume", "episode", "arc", …) that appear in
// nearly every finding this gate sees. Dropped before scoring so the overlap
// below reflects what a finding is ABOUT, not the vocabulary the whole corpus
// shares — two unrelated findings that both say "volume" must not read as one.
// Stemmed through `stemToken` on the way in (so entries stay naturally spelled
// here and still match the stemmed tokens they have to filter), which also
// covers each one's plural.
const FINDING_STOPWORDS = new Set((
  'a an and are as at be been both but by can could did do does each ever every for from had has have in'
  + ' into is it more most never no not of on one only or other same should some still than that the'
  + ' their then there these this those to two was were when which while with would'
  + ' arc book chapter episode issue season series story volume'
).split(' ').map(stemToken));

// Content tokens of one finding field. Tokens shorter than 3 chars are noise
// (numbers, "v1", articles the normalizer already split off).
function contentTokens(value) {
  const out = new Set();
  for (const raw of normFindingText(value).split(' ')) {
    const tok = stemToken(raw);
    if (tok.length < 3 || FINDING_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

// Shared content tokens of two findings' prose, plus the containment score:
// shared over the SMALLER token set, so a terse restatement of a long finding
// still scores high (Jaccard would punish it for the length difference).
function overlapStats(a, b) {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return { shared: 0, score: 0 };
  let shared = 0;
  for (const tok of left) if (right.has(tok)) shared += 1;
  return { shared, score: shared / Math.min(left.size, right.size) };
}

/** Containment overlap of two findings' prose, 0..1. Pure. */
export const findingTextOverlap = (a, b) => overlapStats(a, b).score;

// How much of the smaller finding's prose must be shared before two findings
// from different verify calls are treated as the same one, and how many content
// tokens that has to amount to. The token floor is what keeps a one-word
// coincidence from scoring 1.0: "fix volume 3" and "fix arc one" both reduce to
// {fix} once the structural nouns are dropped.
export const FINDING_MATCH_MIN_OVERLAP = 0.4;
const FINDING_MATCH_MIN_SHARED = 2;
// Both relax when the two findings name the same place — a location that already
// agrees is corroboration, so less of the prose has to.
export const FINDING_MATCH_MIN_OVERLAP_SAME_LOCATION = 0.25;
const FINDING_MATCH_MIN_SHARED_SAME_LOCATION = 1;

/**
 * True when two locations name the same place. Whole-word containment covers
 * "volume 3" vs "volume 3 act two" (the same place at two altitudes) while
 * refusing prefixes, so "v1" can't swallow "v10" nor "volume 3" "volume 30".
 * Pure.
 */
export function sameFindingLocation(a, b) {
  const locA = normFindingText(a);
  const locB = normFindingText(b);
  if (!locA || !locB) return false;
  if (locA === locB) return true;
  const [short, long] = locA.length <= locB.length ? [locA, locB] : [locB, locA];
  return ` ${long} `.includes(` ${short} `);
}

/**
 * True when two findings — filed by two SEPARATE verifier calls — are the same
 * underlying problem. Pure.
 *
 * Identity is deliberately loose about WORDING, because the verifier re-words
 * itself freely between calls: it re-punctuates, re-cases, paraphrases the
 * problem, and re-labels the location when a resolve round renumbers volumes.
 * An exact fingerprint of that prose reads every round's findings as brand new,
 * which is how the regression guard below silently missed the 1 → 3 → 5
 * divergence it was written for.
 *
 * It is NOT loose about SUBJECT. A shared location is corroboration, never proof
 * — two genuinely different defects routinely sit in the same volume, and
 * treating them as one would revert a round that closed what it targeted and
 * merely exposed something else next door. So the problem text always has to
 * agree; naming the same place only lowers how much of it must.
 *
 * Severity is NOT part of the identity — every finding here is already in the
 * gate's blocking set, and the verifier moves a finding between `high` and
 * `medium` freely, which would otherwise hide it from the guard.
 */
export function sameFinding(a, b) {
  const corroborated = sameFindingLocation(a?.location, b?.location);
  const { shared, score } = overlapStats(a?.problem, b?.problem);
  return shared >= (corroborated ? FINDING_MATCH_MIN_SHARED_SAME_LOCATION : FINDING_MATCH_MIN_SHARED)
    && score >= (corroborated ? FINDING_MATCH_MIN_OVERLAP_SAME_LOCATION : FINDING_MATCH_MIN_OVERLAP);
}

// "Is this problem somewhere in that list?" — the membership question every
// caller of `sameFinding` above is actually asking, spelled once. Argument order
// is fixed here (list, then finding) because the sites that open-coded it each
// picked their own, which is harmless only while the matcher stays symmetric.
export const containsFinding = (list, finding) => (
  Array.isArray(list) && list.some((candidate) => sameFinding(candidate, finding))
);

/**
 * True when the round that produced `after` REGRESSED: it left more blocking
 * findings than the `before` set it was asked to close, AND at least one of
 * those targeted findings is still standing. Pure.
 *
 * That second half is what keeps this from rejecting good work: a round that
 * closed everything it targeted and merely exposed findings that were latent
 * underneath is progress, even when the raw count went up, so it is allowed to
 * stand (the divergence guard still catches it if the loop stalls from there).
 * A round that closed nothing and added more is damage.
 *
 * A round that held the count is NOT this guard's business either — it bought
 * nothing, but it also broke nothing, and the divergence guard's patience is
 * what absorbs a verifier that re-files the same set with slightly different
 * prose. Only a GROWING blocking set gets reverted here.
 */
export function isResolveRegression(before, after) {
  const targeted = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  if (current.length <= targeted.length) return false;
  return targeted.some((t) => containsFinding(current, t));
}

const FINDING_SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

/**
 * Regression test for a bounded, finding-keyed exact-text patch. Unlike a
 * legacy whole-field rewrite, a sparse patch that closes its target may safely
 * expose unrelated latent findings elsewhere in the already-authored plan.
 * Revert only when a targeted finding survives while the set grows, or when
 * that same finding returns at a higher severity.
 */
export function isTargetedPatchRegression(before, after) {
  const targeted = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  if (isResolveRegression(targeted, current)) return true;
  return targeted.some((prior) => current.some((candidate) => (
    sameFinding(prior, candidate)
    && (FINDING_SEVERITY_RANK[candidate?.severity] || 0) > (FINDING_SEVERITY_RANK[prior?.severity] || 0)
  )));
}

// The arc rollback guard's operational ordering. Total blockers remain the
// primary signal: accepting a larger set is what caused the original runaway
// repair loop. When the totals tie, severity is the tiebreaker so a resolver
// cannot trade a medium finding for a high one and call the unchanged count
// safe. Unknown severities do not need a bucket here — with equal totals, any
// movement into high/medium/low is already reflected by the known buckets.
export function isBlockingSetRegression(before, after) {
  const prior = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  if (current.length !== prior.length) return current.length > prior.length;
  const count = (findings, severity) => findings.filter((finding) => finding?.severity === severity).length;
  for (const severity of ['high', 'medium', 'low']) {
    const delta = count(current, severity) - count(prior, severity);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-finding ISOLATION acceptance (#3780) — one altitude tighter again. The
// guards above judge a WHOLE resolve round; this judges one single-finding patch
// (see `isolateArcFindings` in childRuns.js for what the pass is FOR).
// ---------------------------------------------------------------------------

/**
 * May an isolated single-finding patch be KEPT? True only when it did the job it
 * was billed for and cost nothing elsewhere: `target` is gone from the re-verify,
 * and what it left behind is not a regression on the set it started from. Pure.
 *
 * "Not a regression" is `isBlockingSetRegression` — deliberately the SAME
 * operational definition of worse the whole-round rollback guard uses, so which
 * trades survive doesn't depend on which tier happened to judge them. Ties are
 * therefore allowed at an unchanged severity mix: a patch that closed its target
 * and exposed one equally-severe finding next door is the same "different,
 * narrower findings" trade the round loop's checkpoint already accepts, and the
 * divergence guard still catches a gate that only ever trades.
 *
 * Closure is decided by `sameFinding`, not by prose equality, for the same
 * reason the regression guard is: the verifier restates a standing defect in
 * fresh words at a re-labelled location every call, and reading that as "closed"
 * would accept a patch that changed nothing but the wording.
 */
export function isIsolatedFixSafe(target, before, after) {
  const current = Array.isArray(after) ? after : [];
  if (containsFinding(current, target)) return false;
  return !isBlockingSetRegression(before, current);
}

// Pause reason for a gate whose auto-resolve round was reverted — distinct from
// both "ran out of rounds" and "stopped converging": the state the user is being
// handed is the one from BEFORE the round, and saying so is the difference
// between a trustworthy pause and an unexplained rewind.
export function regressionPauseReason(gate, beforeCount, afterCount, bestCount = beforeCount, severityEscalated = false) {
  const { label, fix } = PAUSE_GATES[gate];
  const outcome = severityEscalated
    ? `came back with the same count but a worse severity mix (${afterCount} total)`
    : `came back with ${afterCount}`;
  return `${label} auto-resolve made the draft worse — the round it ran on ${beforeCount} blocking finding(s) `
    + `${outcome}, so its edits were reverted regardless of how the verifier reworded the findings. `
    + `Paused for review with the best verified ${bestCount}-finding state from this gate. ${fix}, then resume.`;
}

// Foundation gate pause reasons (#2176) — the gate converges on a WEIGHTED
// SCORE, not a finding count, so it needs its own wording (score vs. threshold)
// rather than the finding-count phrasing of convergencePauseReason. Shares
// PAUSE_GATES.foundation so the copy stays aligned with the other gates.
export function foundationPauseReason(maxRounds, score, threshold) {
  const { label, fix, limit } = PAUSE_GATES.foundation;
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't reach the threshold (weighted ${score} < ${threshold}) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}
// A foundation repair whose independent re-judge showed no gain for the target
// it was asked to fix. `missed` is the shared head of every sentence about that
// attempt — the rewind notice, the unverified-restore pause, and the note the
// NEXT attempt at that dimension is handed — so the three can't disagree about
// what the numbers were.
export function foundationRepairMissed({ dimension, targetBefore, targetAfter, weightedBefore, weightedAfter }) {
  const missed = `Foundation ${dimension} repair did not improve its target `
    + `(${targetBefore} → ${targetAfter}; weighted ${weightedBefore} → ${weightedAfter})`;
  return {
    missed,
    rewind: `${missed}, so its edits were reverted to the pre-repair checkpoint.`,
    unverified: (reason) => `${missed}, and checkpoint verification failed after rollback: ${reason || 'unknown restore mismatch'}.`,
    // Handed to the retry so it changes strategy instead of re-proposing edits
    // the gate has already thrown away. Names the rejected re-judge's own gap:
    // that is the evidence the last attempt failed to move anything.
    retryNote: (gap) => `A previous ${dimension} repair this run was REVERTED: it left the target score at ${targetAfter} `
      + `(weighted ${weightedBefore} → ${weightedAfter}), so none of its edits were kept. The re-judge of that attempt still `
      + `reported: ${gap || 'the same gap'}. Take a different approach — repeating those edits will be reverted again.`,
  };
}
export function foundationDivergenceReason(score, threshold, rounds) {
  const { label, fix } = PAUSE_GATES.foundation;
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped improving — weighted ${score} still below ${threshold} with no net gain over `
    + `${rounds} consecutive ${plural} of auto-fix. Paused for review. ${fix}, then resume.`;
}

// Dry-run plan note for a bounded gate: "skipped (0 rounds)" or "up to N rounds".
export const roundsNote = (rounds) => (rounds === 0 ? 'skipped (0 rounds)' : `up to ${rounds} rounds`);

// Dry-run cost model (#1576) — each planned step carries an estimated
// `estActions`: the number of cos actions it bills via recordDomainUsage('cos',
// { actions }), i.e. the unit the daily budget cap gates on. Surfacing it lets a
// user see, before starting, whether a large series will exhaust the cap on
// text/verify and never reach editorial. Estimates are approximate and lean
// toward the high end — convergence loops counted at their max rounds (they
// usually converge sooner), per-item steps at one action per item (retries
// excluded). A few steps cost nothing against the cap (editorialHealthGate,
// canonVerify) and carry estActions: 0. One known UNDER-count: the editorial
// review's per-comment auto-fixes each bill an extra action and scale with the
// number of blocking findings, which isn't knowable at plan time — so a heavy
// editorial pass can exceed its estimate.
//
// A bounded verify→resolve convergence loop (arc, beat-continuity, editorial)
// bills one action per verify plus (roughly) one per resolve; the final round
// never resolves (it converges or pauses). Estimate: rounds verifies +
// (rounds-1) resolves.
export const convergenceLoopActions = (rounds) => (rounds <= 0 ? 0 : 2 * rounds - 1);

// Sum a dry-run plan's per-step estimates into run totals. `estActions` is the
// budget-relevant total (cos daily-cap units); `estLlmCalls` aggregates the
// check-pass fan-out (editorialChecks bills a single cos action but issues many
// LLM calls — see the rough proxy at its plan.push). Pure — safe to call at
// broadcast time and in tests.
export function summarizePlanCost(plan) {
  return (Array.isArray(plan) ? plan : []).reduce(
    (acc, step) => ({
      estActions: acc.estActions + (Number.isFinite(step?.estActions) ? step.estActions : 0),
      estLlmCalls: acc.estLlmCalls + (Number.isFinite(step?.estLlmCalls) ? step.estLlmCalls : 0),
    }),
    { estActions: 0, estLlmCalls: 0 },
  );
}

// When true, a comic-target run with `includeVisual` proceeds past the text +
// editorial terminal into draft cover/page rendering (see runVisualDraft).
export const VISUAL_DRAFT_ENABLED = true;

// Which severities block each verify/review gate (low is informational) is now
// PER-SERIES configurable (#1616): the defaults (arc/beatContinuity → high+medium,
// editorial → high) live in `lib/editorial/severityConfig.js` and a series may
// override any gate. `startSeriesAutopilot` resolves each gate's blocking Set
// once via `resolveBlockingSet(series.blockingSeverities, gate)` and stamps it on
// `record.options.blockingSets` so every read site uses the same resolved set.

// Poll cadence while awaiting a delegated child runner (volume beats / auto-run).
export const CHILD_POLL_MS = 750;
