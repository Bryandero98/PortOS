import { effortAwareModelOptions, PROVIDER_TYPES } from '../../utils/providers.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';

export const RUNNABLE_PROVIDER_TYPES = Object.values(PROVIDER_TYPES);

/**
 * Keep the provider source shared by every agent-job form. ProviderModelSelector
 * applies the enabled/hardware visibility rules while retaining a saved disabled
 * provider long enough for the user to clear or replace it.
 */
export const filterRunnableProviders = (providers) =>
  (Array.isArray(providers) ? providers : []).filter(provider =>
    RUNNABLE_PROVIDER_TYPES.includes(provider?.type)
  );

/**
 * The providers endpoint has historically returned either an id or a provider
 * object in `activeProvider`; normalize both wire shapes for job forms.
 */
export const activeProviderIdFromResponse = (activeProvider) =>
  typeof activeProvider === 'string' ? activeProvider : (activeProvider?.id || '');

/**
 * Shared provider/model/effort controls for persisted CoS agent jobs.
 *
 * Empty selections are intentional inherit/default sentinels. Changing the
 * provider clears the model and effort together, while a saved legacy model pin
 * remains visible through effortAwareModelOptions until the user changes it.
 */
export default function AgentJobProviderFields({
  data,
  providers,
  activeProviderId = '',
  onChange
}) {
  if (!providers?.length) return null;

  const selectedProvider = providers.find(provider => provider.id === data.providerId)
    || providers.find(provider => provider.id === activeProviderId);
  const availableModels = effortAwareModelOptions(selectedProvider, data.model);
  const effectiveProviderId = data.providerId ? undefined : (activeProviderId || undefined);

  return (
    <div>
      <span className="text-xs text-gray-400 block mb-1">AI Provider &amp; Model (optional)</span>
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={data.providerId || ''}
        effectiveProviderId={effectiveProviderId}
        selectedModel={data.model || ''}
        availableModels={availableModels}
        onProviderChange={providerId => onChange({ providerId, model: '', effort: '' })}
        onModelChange={model => onChange({ model })}
        effort={data.effort || ''}
        onEffortChange={effort => onChange({ effort })}
        compact
        emptyProviderOption="Default (active provider)"
        emptyModelOption="Default model"
        alwaysShowModel
      />
    </div>
  );
}
