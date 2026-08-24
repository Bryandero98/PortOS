import { useCallback, useEffect, useState } from 'react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import ToggleSwitch from '../ToggleSwitch';
import { getInstanceFeatures, updateInstanceFeature } from '../../services/api';

export function InstanceFeaturesTab() {
  const [features, setFeatures] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const loadFeatures = useCallback(() => {
    setLoadError(null);
    getInstanceFeatures({ silent: true })
      .then((data) => setFeatures(Array.isArray(data?.features) ? data.features : []))
      .catch((error) => {
        setFeatures(null);
        setLoadError(error.message || 'Failed to load instance features');
      });
  }, []);

  useEffect(() => {
    loadFeatures();
  }, [loadFeatures]);

  const handleToggle = async (feature) => {
    if (!feature?.id || savingId) return;
    const enabled = !feature.enabled;
    const previous = features;
    setSavingId(feature.id);
    setFeatures((current) => current?.map((item) => (
      item.id === feature.id ? { ...item, enabled } : item
    )) || current);

    const result = await updateInstanceFeature(feature.id, enabled, { silent: true }).catch((error) => {
      toast.error(error.message || `Could not update ${feature.label}`);
      return null;
    });

    if (!result) {
      setFeatures(previous);
    } else if (Array.isArray(result.features)) {
      setFeatures(result.features);
    }
    setSavingId(null);
  };

  if (loadError) {
    return (
      <div className="space-y-3 max-w-3xl">
        <p className="text-sm text-port-error">{loadError}</p>
        <button
          type="button"
          onClick={loadFeatures}
          className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (features === null) return <BrailleSpinner text="Loading instance features" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Instance features</h2>
        <p className="text-sm text-gray-400 mt-1">
          Choose which optional PortOS features this install actively uses. Disabled features remain available when opened directly, but do not contribute passive metrics, reminders, or proactive prompts.
        </p>
      </div>

      <div className="space-y-3">
        {features.map((feature) => (
          <div
            key={feature.id}
            className="flex items-start justify-between gap-4 bg-port-card border border-port-border rounded-lg p-4"
          >
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white">{feature.label}</h3>
              <p className="text-sm text-gray-400 mt-1">{feature.description}</p>
              <p className={`text-xs mt-2 ${feature.enabled ? 'text-port-success' : 'text-gray-500'}`}>
                {feature.enabled ? 'Active on this instance' : 'Not used on this instance'}
              </p>
            </div>
            <ToggleSwitch
              enabled={feature.enabled}
              onChange={() => handleToggle(feature)}
              disabled={savingId !== null}
              ariaLabel={`${feature.enabled ? 'Disable' : 'Enable'} ${feature.label} on this instance`}
              className="mt-1"
            />
          </div>
        ))}
        {features.length === 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-400">
            No optional features are registered for this version of PortOS.
          </div>
        )}
      </div>
    </div>
  );
}

export default InstanceFeaturesTab;
