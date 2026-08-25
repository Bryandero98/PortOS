// The registry of optional per-install features — the single list that Settings
// > Features renders, `server/lib/validation.js` validates against, and
// `server/lib/navManifest.js` gates navigation on.
//
// It lives in lib/ (pure data, no I/O) so both a lib and a service can read it
// without a service→lib inversion. Runtime resolution — stored overrides,
// auto-detection, the enabled/disabled answer — is
// `server/services/instanceFeatures.js`.
//
// Adding a feature:
//   1. add a descriptor here;
//   2. tag its pages in navManifest.js (`feature: '<id>'`, or a SECTION_FEATURE
//      entry when a whole sidebar section belongs to it) and the matching rows
//      in client/src/components/Layout.jsx;
//   3. add a `detect` hook in services/instanceFeatures.js when a fresh install
//      should infer the default from whether the integration is configured.
// The validation schemas and the Features tab pick it up with no further edit.
export const INSTANCE_FEATURES = Object.freeze([
  Object.freeze({
    id: 'post',
    label: 'POST',
    description: 'Daily cognitive practice, progress metrics, and reminder prompts.',
    defaultEnabled: true,
  }),
  Object.freeze({
    id: 'datadog',
    label: 'DataDog',
    description: 'Error monitoring dashboards for apps wired to a DataDog instance.',
    defaultEnabled: false,
  }),
  Object.freeze({
    id: 'jira',
    label: 'JIRA',
    description: 'Sprint boards, ticket triage, and JIRA reports for apps wired to a JIRA instance.',
    defaultEnabled: false,
  }),
]);

export const INSTANCE_FEATURE_IDS = Object.freeze(INSTANCE_FEATURES.map((feature) => feature.id));
