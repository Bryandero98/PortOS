import { getAllProviders } from '../providers.js';
import { getProviderQuotas } from '../providerUsage.js';
import { getEffectiveQuotaBurnDispatches, recordQuotaBurnDispatch, selectBurnCandidates, quotaBurnConfig, QUOTA_BURN_TASK_TYPE, QUOTA_BURN_DISPATCH_KEY_FIELD } from '../quotaBurn.js';

function providerForFamily(providers, family) {
  const available = (providers || []).filter((provider) =>
    provider?.enabled && (provider.type === 'cli' || provider.type === 'tui'));
  if (family.providerId) return available.find((provider) => provider.id === family.providerId) || null;
  const familyName = family.id.toLowerCase();
  return available.find((provider) => String(provider.id || '').toLowerCase().includes(familyName)) || null;
}

function renderPrompt(candidate) {
  const { family, limit, hoursUntilReset } = candidate;
  return [
    `# ${family.id} quota-burn task`,
    '',
    `This configured ${family.id} quota window resets in about ${Math.max(0, Math.ceil(hoursUntilReset))} hours.`,
    `Window: ${limit.label || limit.scope || 'provider window'}; remaining: ${limit.percentRemaining}%; reserve: ${family.reservePercent}%.`,
    `Dispatch cap: ${family.maxDispatchesPerWindow} for this reset window.`,
    '',
    'Carry out the configured work below. Do not use another provider family as a substitute.',
    '',
    family.prompt.trim(),
  ].join('\n');
}

/**
 * Programmatic pre-agent hook. It refreshes quota readings immediately before
 * dispatch, pins an agent-capable provider in the selected family, and returns
 * a skip instead of spawning when any prerequisite is missing.
 *
 * Deliberately does NOT write the dispatch ledger (#3179). Several gates in
 * `cosTaskGenerator.js#buildImprovementTask` run AFTER this hook returns —
 * claim-work routing, the perpetual-work gate, branch-/issue-reconcile,
 * reference-watch, the PLAN.md gate — and any of them can still `return null`
 * and skip creating the task, with no agent ever spawned. A ledger write here
 * therefore burned a slot of `family.maxDispatchesPerWindow` on a dispatch that
 * never happened. Instead the resolved `dispatchKey` is handed back as
 * `hookMetadata`, which the generator stamps onto the task only once every gate
 * has passed, and `processTaskOutput` below records it post-agent.
 */
export async function buildTaskInput({ app, ignoreTaskId = null } = {}) {
  if (!app) return { skip: { reason: 'no-app' } };
  const config = quotaBurnConfig(app);
  // Ledger + in-flight, NOT the bare ledger: a quota-burn task already queued or
  // running holds its window slot even though its ledger write lands post-agent
  // (#3179). `ignoreTaskId` drops the run whose completion triggered this
  // generation — it recorded itself moments ago but still reads `in_progress`.
  const dispatches = await getEffectiveQuotaBurnDispatches({ ignoreTaskId });
  const quotas = await getProviderQuotas({ refresh: true });
  const candidates = selectBurnCandidates(quotas, config, { dispatches });
  const candidate = candidates[0];
  if (!candidate) return { skip: { reason: 'no-burnable-provider-quota' } };

  const providerResult = await getAllProviders();
  const provider = providerForFamily(
    Array.isArray(providerResult) ? providerResult : providerResult?.providers,
    candidate.family,
  );
  if (!provider) return { skip: { reason: 'no-enabled-agent-provider-in-family' } };

  return {
    prompt: renderPrompt(candidate),
    providerId: provider.id,
    model: candidate.family.model || null,
    hookMetadata: { [QUOTA_BURN_DISPATCH_KEY_FIELD]: candidate.dispatchKey },
  };
}

/**
 * Programmatic post-agent hook. Records the dispatch against the family's
 * reset-window ledger — the ONLY place that write happens (#3179). By the time
 * the finalize chokepoint runs this, an agent was actually spawned, which is the
 * real event `family.maxDispatchesPerWindow` is meant to bound.
 *
 * Runs regardless of `success`: the provider quota was consumed the moment the
 * agent ran, whether or not its run exited clean. A window's budget must count
 * failed burns too, otherwise a family that keeps erroring out would dispatch
 * without limit.
 *
 * Returns NO structured outcome, on purpose. `resolveProgrammaticIoVerdict`
 * (agentFinalization.js) reads an output hook's outcome as the task type's
 * success criterion, and quota-burn has none to offer: its agent does arbitrary
 * user-configured work with no `.agent-done` payload contract, so nothing here
 * evaluates the agent's output. Handing back no outcome keeps that verdict at
 * the "undeclared" null sentinel, leaving quota-burn exit-code-judged exactly as
 * it was before this hook existed. Do NOT return an object to make this "more
 * informative" — that would declare a criterion this hook never checked.
 *
 * For the same reason the ledger write must not throw. finalizeAgent turns a
 * thrown output hook into `{ ran: true, threw: true }`, which rejects the run's
 * success criterion AND records a `hook-error` against the per-type
 * consecutive-failure ledger that auto-parks a task type — so a transient
 * ENOSPC/EACCES writing one JSON file could park quota-burn entirely. A failed
 * write is environmental, not a bad run; log and move on, exactly as the
 * verdict's own docstring prescribes for a hook whose side effect couldn't land.
 */
export async function processTaskOutput({ agentId, task } = {}) {
  const dispatchKey = task?.metadata?.[QUOTA_BURN_DISPATCH_KEY_FIELD];
  // Absent key = this task predates the metadata thread, or generation never
  // resolved a candidate. Nothing to record; never invent a ledger entry.
  if (typeof dispatchKey !== 'string' || !dispatchKey) return;
  await recordQuotaBurnDispatch(dispatchKey, { agentId })
    .then(() => console.log(`🔥 Recorded quota-burn dispatch for ${dispatchKey}`))
    .catch((err) => console.error(`❌ Failed to record quota-burn dispatch for ${dispatchKey}: ${err.message}`));
}

export const __test = { providerForFamily, renderPrompt, QUOTA_BURN_TASK_TYPE };
