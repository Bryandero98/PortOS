/**
 * Cross-package parity for the LoRA adapter-effect report vocabulary (#4872).
 *
 * `server/lib/loraEffect.js` is the source of truth — it decides which verdict
 * refuses a render and what a measurement is called. `client/src/lib/loraEffect.js`
 * mirrors the status list and the summary wording so a manager card and a render
 * log describe one measurement the same way. When they disagree the user reads
 * one thing on the card and gets another at render time; this suite fails CI
 * instead of letting that ship.
 *
 * It lives server-side because the server module is the authority; both copies
 * are pure and load fine under the node runner.
 */

import { describe, it, expect } from 'vitest';
import {
  LORA_EFFECT_STATUSES as SERVER_STATUSES,
  formatLoraEffect as serverFormat,
  loraEffectIssue,
  normalizeLoraEffectReport,
} from './loraEffect.js';
import {
  LORA_EFFECT_STATUSES as CLIENT_STATUSES,
  LORA_EFFECT_BADGES,
  formatLoraEffect as clientFormat,
  loraEffectBadge,
} from '../../client/src/lib/loraEffect.js';

// Every report shape the two formatters must agree on: a plain measurement, one
// with each skip counter, a partially-zero adapter, and the three "no numbers"
// cases (never measured, statistics nulled as non-finite, no reason at all).
const REPORTS = [
  { status: 'ok', measured: 10, medianRms: 0.0031, maxRms: 0.0184, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null },
  { status: 'ok', measured: 8, medianRms: 1e-9, maxRms: 2.5e-8, skippedNonFinite: 2, skippedUnsupported: 0, zeroModules: 0, reason: null },
  { status: 'ok', measured: 8, medianRms: 0.004, maxRms: 0.02, skippedNonFinite: 0, skippedUnsupported: 5, zeroModules: 0, reason: null },
  { status: 'ok', measured: 4, medianRms: 0.004, maxRms: 0.02, skippedNonFinite: 1, skippedUnsupported: 2, zeroModules: 3, reason: null },
  { status: 'zero', measured: 6, medianRms: 0, maxRms: 0, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 6, reason: 'all 6 measurable LoRA module(s) have exactly zero effect' },
  { status: 'unreadable', measured: 0, medianRms: null, maxRms: null, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: 'contains no lora_A/lora_B pairs' },
  { status: 'nonfinite', measured: 0, medianRms: null, maxRms: null, skippedNonFinite: 12, skippedUnsupported: 0, zeroModules: 0, reason: 'every module measured NaN' },
  { status: 'unmeasurable', measured: 0, medianRms: null, maxRms: null, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null },
  { status: 'ok', measured: 3, medianRms: null, maxRms: 0.2, skippedNonFinite: 0, skippedUnsupported: 0, zeroModules: 0, reason: null },
];

describe('loraEffect parity — server vs client', () => {
  it('mirrors the status vocabulary exactly', () => {
    expect(CLIENT_STATUSES).toEqual(SERVER_STATUSES);
  });

  it('gives every status a badge, so a new verdict can never render as a bare slug', () => {
    expect(Object.keys(LORA_EFFECT_BADGES).sort()).toEqual(Object.values(SERVER_STATUSES).sort());
    for (const status of Object.values(SERVER_STATUSES)) {
      expect(loraEffectBadge(status).label).toBeTruthy();
      expect(loraEffectBadge(status).tone).toBeTruthy();
    }
  });

  it('styles exactly the refusing verdict as an error', () => {
    // The client must not invent a second blocking-looking status: whichever
    // statuses `loraEffectIssue` refuses on are the ones allowed error styling.
    const refused = Object.values(SERVER_STATUSES)
      .filter((status) => loraEffectIssue({ status, reason: 'x' }) !== null);
    const errorStyled = Object.entries(LORA_EFFECT_BADGES)
      .filter(([, badge]) => badge.tone.includes('port-error'))
      .map(([status]) => status);
    expect(errorStyled).toEqual(refused);
    expect(refused).toEqual([SERVER_STATUSES.ZERO]);
  });

  it('formats a measured report identically to the server', () => {
    // Whenever the server prints statistics, the two must be byte-identical —
    // that is the drift this suite exists to catch.
    for (const raw of REPORTS) {
      const report = normalizeLoraEffectReport(raw);
      if (report.measured <= 0 || report.medianRms === null || report.maxRms === null) continue;
      expect(clientFormat(report)).toBe(serverFormat(report));
      expect(clientFormat(report)).toContain('median RMS');
    }
  });

  it('drops to the reason (never the badge word) where the server prints its status', () => {
    // The server's no-statistics fallback is `status[: reason]`, but the client
    // already renders the status as a badge beside this text — echoing it would
    // read "Unreadable — Unreadable". So the client contributes the reason, or
    // nothing at all, and the card omits the separator.
    for (const raw of REPORTS) {
      const report = normalizeLoraEffectReport(raw);
      if (report.measured > 0 && report.medianRms !== null && report.maxRms !== null) continue;
      expect(serverFormat(report).startsWith(report.status)).toBe(true);
      expect(clientFormat(report)).toBe(report.reason);
      expect(clientFormat(report)).not.toBe(loraEffectBadge(report.status).label);
    }
  });

  it('agrees that a null report has nothing to format', () => {
    expect(clientFormat(null)).toBeNull();
    expect(serverFormat(null)).toBe('not measured');
  });
});
