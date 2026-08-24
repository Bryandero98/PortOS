import { ServerError } from '../lib/errorHandler.js';
import { isPlainObject } from '../lib/objects.js';
import { getSettings, updateSettingsWith } from './settings.js';

// Instance features are local to one PortOS install. They are deliberately
// separate from per-feature configuration so a feature can remain available
// when opened directly while its passive metrics, reminders, and proactive
// prompts stay quiet on installs that do not use it.
export const INSTANCE_FEATURES = Object.freeze([
  Object.freeze({
    id: 'post',
    label: 'POST',
    description: 'Daily cognitive practice, progress metrics, and reminder prompts.',
    defaultEnabled: true,
  }),
]);

const FEATURE_BY_ID = new Map(INSTANCE_FEATURES.map((feature) => [feature.id, feature]));

const featureEnabled = (feature, settings) => {
  const instanceFeatures = settings?.instanceFeatures;
  if (instanceFeatures === undefined) return feature.defaultEnabled;
  if (!isPlainObject(instanceFeatures)) return false;
  if (!Object.prototype.hasOwnProperty.call(instanceFeatures, feature.id)) return feature.defaultEnabled;

  const featureSettings = instanceFeatures[feature.id];
  if (!isPlainObject(featureSettings)) return false;
  const stored = featureSettings.enabled;
  if (stored === undefined) return feature.defaultEnabled;
  return typeof stored === 'boolean' ? stored : false;
};

export const resolveInstanceFeatures = (settings = {}) => INSTANCE_FEATURES.map((feature) => ({
  ...feature,
  enabled: featureEnabled(feature, settings),
}));

export async function getInstanceFeatures() {
  return { features: resolveInstanceFeatures(await getSettings()) };
}

export async function isInstanceFeatureEnabled(featureId) {
  const feature = FEATURE_BY_ID.get(featureId);
  if (!feature) return false;
  return featureEnabled(feature, await getSettings());
}

export async function updateInstanceFeature(featureId, enabled) {
  if (!FEATURE_BY_ID.has(featureId)) {
    throw new ServerError(`Unknown instance feature: ${featureId}`, { status: 404, code: 'NOT_FOUND' });
  }

  const settings = await updateSettingsWith((current) => {
    const instanceFeatures = isPlainObject(current.instanceFeatures) ? current.instanceFeatures : {};
    const currentFeature = isPlainObject(instanceFeatures[featureId]) ? instanceFeatures[featureId] : {};
    return {
      ...current,
      instanceFeatures: {
        ...instanceFeatures,
        [featureId]: { ...currentFeature, enabled },
      },
    };
  });

  return { features: resolveInstanceFeatures(settings) };
}
