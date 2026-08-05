import { FormField } from '../../../ui/FormField';
import EffortSelect from '../../EffortSelect';
import useTaskModelPins from '../../../../hooks/useTaskModelPins';

const LABEL_CLASS = 'block text-[10px] uppercase tracking-wide text-gray-500 mb-0.5';
const SELECT_CLASS = 'w-full bg-port-card border border-port-border rounded px-1.5 py-1 text-xs text-white disabled:opacity-60';

// Compact provider/model/effort pins rendered directly on a schedule card, so
// the common "point this task at a different model and run it" loop doesn't
// require opening the config drawer. Writes go through the same task-update
// path as the drawer's Global defaults tab (useTaskModelPins).
//
// `onSavingChange` lifts the in-flight flag to the card, which disables Run
// while a pin is still being persisted — the run reads the server-side config,
// not these inputs.
export default function TaskModelQuickControls({ taskType, config, providers, activeProviderId, onUpdate, disabled = false, onSavingChange }) {
  const { providerId, model, effort, provider, usingActiveProvider, availableModels, saving, changeProvider, changeModel, changeEffort } =
    useTaskModelPins({ taskType, config, providers, activeProviderId, onUpdate, onBusyChange: onSavingChange });

  const locked = disabled || saving;
  // Name what "Default" resolves to right now, so the model/effort options
  // below it aren't from a provider the user has to guess at.
  const defaultLabel = usingActiveProvider ? `Active: ${provider.name}` : 'Default';

  return (
    <div className="flex flex-wrap items-end gap-2 px-4 py-2.5 border-t border-port-border">
      <FormField label="Provider" className="min-w-[7rem] flex-1" labelClassName={LABEL_CLASS}>
        <select
          value={providerId}
          onChange={(e) => changeProvider(e.target.value)}
          disabled={locked}
          className={SELECT_CLASS}
          title="Provider for this task's runs — Default follows the active provider"
        >
          <option value="">{defaultLabel}</option>
          {providers?.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </FormField>

      <FormField label="Model" className="min-w-[7rem] flex-1" labelClassName={LABEL_CLASS}>
        <select
          value={model}
          onChange={(e) => changeModel(e.target.value)}
          disabled={locked}
          className={SELECT_CLASS}
          title="Model override — Default uses the provider's default model"
        >
          <option value="">Default</option>
          {/* A pin the current provider no longer lists still renders, or the
              select would show blank and read as "Default". */}
          {model && !availableModels.includes(model) && <option value={model}>{model}</option>}
          {availableModels.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </FormField>

      <EffortSelect
        provider={provider}
        model={model}
        value={effort}
        onChange={changeEffort}
        disabled={locked}
        label="Effort"
        fieldClassName="min-w-[7rem] flex-1"
        labelClassName={LABEL_CLASS}
        className={SELECT_CLASS}
      />
    </div>
  );
}
