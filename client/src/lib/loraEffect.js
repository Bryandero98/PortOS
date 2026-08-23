/**
 * Client mirror of the LoRA adapter-effect report vocabulary in
 * `server/lib/loraEffect.js` (issue #4872).
 *
 * The server is the decision point — it measures the adapter, decides which
 * verdict blocks a render (`loraEffectIssue`: only `zero` does), and caches the
 * report in the LoRA sidecar. These helpers exist so the manager card can say
 * the same thing the render will, in the same words. `loraEffect.parity.test.js`
 * pins the status list against the server module; keep `formatLoraEffect` in
 * step with its server twin by hand, or a card and a render log will describe
 * one measurement two different ways.
 *
 * Same shape as `client/src/lib/loraTriggers.js` mirroring its server twin.
 */

// Mirrors LORA_EFFECT_STATUSES in server/lib/loraEffect.js.
export const LORA_EFFECT_STATUSES = Object.freeze({
  OK: 'ok',
  ZERO: 'zero',
  NONFINITE: 'nonfinite',
  UNREADABLE: 'unreadable',
  UNMEASURABLE: 'unmeasurable',
});

// Badge text + Tailwind tone per status. Presentation is legitimately
// client-only, but it lives beside the mirrored status list so a new verdict
// can't render as a bare slug — one table rather than two parallel maps, which
// is the pair that would otherwise drift.
export const LORA_EFFECT_BADGES = Object.freeze({
  // Only `zero` refuses a render server-side, so only `zero` is styled as an
  // error. `nonfinite` is a genuinely broken adapter the user should see, but
  // it still renders — warning, not error.
  ok: { label: 'Active', tone: 'text-port-success' },
  zero: { label: 'No effect', tone: 'text-port-error' },
  nonfinite: { label: 'Diverged', tone: 'text-port-warning' },
  unreadable: { label: 'Unreadable', tone: 'text-port-warning' },
  unmeasurable: { label: 'Not measurable', tone: 'text-gray-500' },
});

export const loraEffectBadge = (status) => LORA_EFFECT_BADGES[status]
  || { label: status || 'Unknown', tone: 'text-gray-400' };

/**
 * One-line summary of a measurement — the mirror of `formatLoraEffect` in
 * server/lib/loraEffect.js, and deliberately the same wording.
 *
 * Returns `null` when there is nothing to add beyond the badge, so a caller can
 * omit the separator rather than printing "Unreadable — Unreadable".
 */
export const formatLoraEffect = (report) => {
  if (!report) return null;
  // Both statistics, not just `measured`: the server nulls a non-finite value
  // while leaving `measured` intact, so a measured report can still arrive with
  // no renderable number.
  if (!Number.isFinite(report.medianRms) || !Number.isFinite(report.maxRms)) {
    return report.reason || null;
  }
  const parts = [
    `median RMS ${report.medianRms.toExponential(2)}`,
    `max ${report.maxRms.toExponential(2)}`,
    `across ${report.measured} module(s)`,
  ];
  if (report.skippedNonFinite > 0) parts.push(`${report.skippedNonFinite} non-finite skipped`);
  if (report.skippedUnsupported > 0) parts.push(`${report.skippedUnsupported} unsupported skipped`);
  if (report.zeroModules > 0) parts.push(`${report.zeroModules} zero`);
  return parts.join(', ');
};
