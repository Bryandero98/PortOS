import { useState, useEffect, useCallback } from 'react';
import { filterSelectableModels } from '../utils/providers';

/**
 * Provider / model / effort pins for one CoS scheduled task, shared by the
 * schedule card's quick controls and the config drawer's global controls so a
 * change made in either place goes through the same optimistic-write path.
 *
 * Each change is written immediately (`'' → null` clears the pin) and rolled
 * back to the persisted value when the write fails. Picking a provider also
 * clears model + effort in the same PUT — a model from the previous provider
 * would not resolve.
 *
 * `saving` is the in-flight flag callers must use to gate any action that reads
 * these pins server-side (the "Run Now" button), per the repo's
 * "in-flight saves must gate dependent actions" convention — otherwise the user
 * picks a model and triggers a run before the server has it.
 *
 * @param {object} params
 * @param {string} params.taskType - Task id (e.g. `code-review`).
 * @param {object} params.config - The live task config from the schedule payload.
 * @param {object[]} [params.providers] - Provider records, for resolving the model list.
 * @param {string} [params.activeProviderId] - The install's active provider. With
 *   no provider pinned the task runs on it, so the model list and effort ladder
 *   resolve against it — otherwise "no provider pinned" would mean "no way to
 *   pin a model or effort either" (same fallback as the pipeline's LLM pickers).
 * @param {function} params.onUpdate - `(taskType, settings) => Promise<boolean|void>`;
 *   resolving `false` (or rejecting) rolls the local selection back.
 * @param {function} [params.onBusyChange] - Mirrors `saving` into a caller-owned
 *   updating flag (the drawer disables its whole form off one).
 * @returns {{providerId: string, model: string, effort: string, provider: object|undefined,
 *   usingActiveProvider: boolean, availableModels: string[], saving: boolean,
 *   changeProvider: function, changeModel: function, changeEffort: function}}
 */
export function useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate, onBusyChange }) {
  const [providerId, setProviderId] = useState(config?.providerId || '');
  const [model, setModel] = useState(config?.model || '');
  const [effort, setEffort] = useState(config?.effort || '');
  const [saving, setSaving] = useState(false);

  // Re-sync from the refetched config (and when the hosting surface switches task).
  useEffect(() => {
    setProviderId(config?.providerId || '');
    setModel(config?.model || '');
    setEffort(config?.effort || '');
  }, [taskType, config?.providerId, config?.model, config?.effort]);

  const setBusy = useCallback((busy) => {
    setSaving(busy);
    onBusyChange?.(busy);
  }, [onBusyChange]);

  const commit = useCallback(async (patch, rollback) => {
    setBusy(true);
    // Callers that own their own error toast resolve `false` on failure; the
    // ones that resolve nothing (older call sites, tests) count as success.
    const ok = await onUpdate(taskType, patch).catch(() => false);
    if (ok === false) rollback();
    setBusy(false);
  }, [onUpdate, taskType, setBusy]);

  const restore = useCallback(() => {
    setProviderId(config?.providerId || '');
    setModel(config?.model || '');
    setEffort(config?.effort || '');
  }, [config?.providerId, config?.model, config?.effort]);

  const changeProvider = useCallback((next) => {
    setProviderId(next);
    setModel('');
    setEffort('');
    return commit({ providerId: next === '' ? null : next, model: null, effort: null }, restore);
  }, [commit, restore]);

  const changeModel = useCallback((next) => {
    setModel(next);
    return commit({ model: next === '' ? null : next }, restore);
  }, [commit, restore]);

  const changeEffort = useCallback((next) => {
    setEffort(next);
    return commit({ effort: next === '' ? null : next }, restore);
  }, [commit, restore]);

  // With nothing pinned the run resolves to the active provider, so that's whose
  // catalog the model/effort pickers must offer.
  const resolvedProviderId = providerId || activeProviderId || '';
  const provider = providers?.find(p => p.id === resolvedProviderId);

  return {
    providerId,
    model,
    effort,
    provider,
    usingActiveProvider: !providerId && !!provider,
    availableModels: filterSelectableModels(provider?.models),
    saving,
    changeProvider,
    changeModel,
    changeEffort,
  };
}

export default useTaskModelPins;
