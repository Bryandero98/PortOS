/**
 * LoRA adapter-effect report — normalization, freshness and verdict rules.
 *
 * The measurement itself lives in `scripts/lora_effect_probe.py` (it needs
 * numpy to multiply the rank matrices); this module owns everything PortOS
 * decides ABOUT a measurement, so the rules are testable without spawning a
 * Python child and are identical whether a report arrives fresh from the probe
 * or is read back out of a LoRA sidecar written by an older install.
 *
 * Why a report at all: the existing gates (`assertSafeLoraFilename`,
 * `verifySafetensorsStructure`, `classifyLoraKeyLayout`, the runtime-capability
 * probe) all answer "is this file shaped like a LoRA this runtime can load".
 * None of them answers "does it actually change anything", which is the
 * question worth answering before a multi-minute video render. A structurally
 * perfect adapter can still carry all-zero `lora_B` weights or NaN deltas.
 *
 * Finite-safety is the contract, in both directions:
 *   - The probe skips non-finite MODULE totals before computing median/max, so
 *     one diverged module cannot NaN out the whole summary.
 *   - This module then refuses to trust a non-finite NUMBER that reaches it
 *     anyway (a hand-edited sidecar, a future probe version, JSON `null`), so
 *     no consumer has to defend against NaN leaking into a UI or a comparison.
 *
 * Verdict policy: `zero` — and only `zero` — blocks a render. A `nonfinite`
 * adapter is reported loudly but not refused, and there is deliberately no
 * "weak" verdict: a small median is a number for a human to read, not a
 * threshold to fail on, and inventing one would refuse working subtle LoRAs.
 */

import { isPlainObject } from './objects.js';

// Bumped in lockstep with PROBE_VERSION in scripts/lora_effect_probe.py. A
// cached report stamped with a different version is stale by definition — the
// measurement or the status vocabulary changed under it — so it is dropped and
// re-probed rather than reinterpreted.
export const LORA_EFFECT_PROBE_VERSION = 1;

export const LORA_EFFECT_STATUSES = Object.freeze({
  // At least one finite, non-zero module measurement.
  OK: 'ok',
  // Measurements exist and every one is exactly zero — provably inert.
  ZERO: 'zero',
  // Modules were found but every measurement was NaN/Infinity.
  NONFINITE: 'nonfinite',
  // No measurable LoRA module pairs (not a LoRA, unsupported dtype, truncated).
  UNREADABLE: 'unreadable',
  // The probe could not run at all (no interpreter with numpy, timeout, crash).
  // Never a statement about the adapter — only about this machine.
  UNMEASURABLE: 'unmeasurable',
});

export const LORA_EFFECT_STATUS_VALUES = Object.freeze(Object.values(LORA_EFFECT_STATUSES));

export const isKnownLoraEffectStatus = (status) => LORA_EFFECT_STATUS_VALUES.includes(status);

// Non-finite in, `null` out. `Number.isFinite` alone would let a numeric string
// through as `false` and a boolean `true` through as... also false — so the
// typeof check is what actually pins the type.
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const nonNegativeInt = (value) => {
  const n = finiteOrNull(value);
  return n == null || n < 0 ? 0 : Math.floor(n);
};

/**
 * Normalize a raw probe payload (or a sidecar-cached one) into the report shape
 * every consumer reads. Returns `null` for a payload that isn't an object at
 * all; anything else yields a report — an unrecognized `status` degrades to
 * `unmeasurable` rather than propagating a word nothing downstream understands.
 *
 * `sizeBytes` / `measuredAt` are stamped by the caller (the probe measures the
 * file, it doesn't own the cache key) and are what makes a cached report
 * verifiable later.
 */
export const normalizeLoraEffectReport = (raw, { sizeBytes = null, measuredAt = null } = {}) => {
  if (!isPlainObject(raw)) return null;
  const status = isKnownLoraEffectStatus(raw.status) ? raw.status : LORA_EFFECT_STATUSES.UNMEASURABLE;
  const measured = nonNegativeInt(raw.measured);
  // Statistics only exist alongside a measurement. Dropping them when
  // `measured` is 0 keeps "no data" from ever reading as "measured 0.0", which
  // is the exact confusion that would turn an unmeasurable adapter into a
  // refusal.
  const stat = (value) => (measured > 0 ? finiteOrNull(value) : null);
  return {
    probeVersion: nonNegativeInt(raw.probeVersion),
    status,
    modules: nonNegativeInt(raw.modules),
    measured,
    skippedNonFinite: nonNegativeInt(raw.skippedNonFinite),
    skippedUnsupported: nonNegativeInt(raw.skippedUnsupported),
    zeroModules: nonNegativeInt(raw.zeroModules),
    medianRms: stat(raw.medianRms),
    maxRms: stat(raw.maxRms),
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
    sizeBytes: finiteOrNull(sizeBytes),
    measuredAt: typeof measuredAt === 'string' && measuredAt ? measuredAt : null,
  };
};

/**
 * Is a cached report still about the file on disk right now? Module-private —
 * `readCachedLoraEffectReport` below is the only way to ask, so no caller can
 * accidentally trust a report without normalizing it first.
 *
 * The cache key is the probe version plus the file size: a LoRA replaced in
 * place under the same name is a different adapter, and re-probing a 500 MB
 * file on every list would defeat the "never measure on a passive read" rule
 * that this cache exists to serve. Size is not a hash — it will not catch an
 * edit that preserves byte count — but the alternative (sha256 of every LoRA
 * on every list) costs orders of magnitude more for a diagnostic the user can
 * always re-run explicitly.
 */
const isLoraEffectReportFresh = (report, { sizeBytes } = {}) => {
  if (!isPlainObject(report)) return false;
  if (report.probeVersion !== LORA_EFFECT_PROBE_VERSION) return false;
  const cached = finiteOrNull(report.sizeBytes);
  const actual = finiteOrNull(sizeBytes);
  return cached != null && actual != null && cached === actual;
};

/**
 * The report a passive read may surface: a normalized, still-fresh cached one,
 * or `null`. Never probes — `listLoras()` calls this per entry, and a library
 * page must not fan out into one Python child per installed adapter.
 */
export const readCachedLoraEffectReport = (raw, sizeBytes) => {
  const report = normalizeLoraEffectReport(raw, { sizeBytes: raw?.sizeBytes, measuredAt: raw?.measuredAt });
  return isLoraEffectReportFresh(report, { sizeBytes }) ? report : null;
};

/**
 * Why this adapter must not be used, as a user-facing phrase — or `null` when
 * there is no such reason. ONLY a measured, entirely-zero adapter qualifies.
 *
 * Everything else is permissive by design: `unmeasurable` says nothing about
 * the file, `unreadable` is already the key-layout gate's territory, and
 * `nonfinite` — while a real problem — is a diverged training run the user may
 * still want to see rendered. Refusing on anything we did not positively
 * measure would turn a machine without numpy into a machine that cannot render.
 */
export const loraEffectIssue = (report) => {
  if (!report || report.status !== LORA_EFFECT_STATUSES.ZERO) return null;
  return report.reason
    || 'every measurable module in it has exactly zero effect, so fusing it would change nothing';
};

/** One-line human summary for a log line or a card subtitle. */
export const formatLoraEffect = (report) => {
  if (!report) return 'not measured';
  // Both statistics, not just `measured`: normalizeLoraEffectReport nulls a
  // non-finite value, so a measured report can still arrive with no renderable
  // number — and `null.toExponential()` inside a render path is a crash.
  if (report.measured <= 0 || !Number.isFinite(report.medianRms) || !Number.isFinite(report.maxRms)) {
    return `${report.status}${report.reason ? `: ${report.reason}` : ''}`;
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
