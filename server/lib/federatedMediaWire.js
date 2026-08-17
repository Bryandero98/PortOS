import { z } from 'zod';

export const FEDERATED_MEDIA_WIRE_VERSION = 1;
export const FEDERATED_MEDIA_STALE_AFTER_MS = 60_000;
export const FEDERATED_MEDIA_MAX_CLOCK_SKEW_MS = 30_000;

// Wire v1 intentionally exposes audio only. Later media kinds get their own
// versioned capability shape instead of being accepted against audio-specific
// readiness fields by an older consumer.
const mediaKindSchema = z.literal('audio');

const federatedMediaCapabilitySchema = z.object({
  kind: mediaKindSchema,
  engine: z.string().trim().min(1).max(80),
  engineName: z.string().trim().min(1).max(256),
  modelId: z.string().trim().min(1).max(256),
  modelName: z.string().trim().min(1).max(256),
  ready: z.boolean(),
  unavailableReason: z.string().max(120).nullable(),
  runtimeReady: z.boolean(),
  platformSupported: z.boolean(),
  cudaRequired: z.boolean(),
  cudaState: z.enum(['available', 'absent', 'unknown']),
  minDurationSec: z.number().finite().positive().nullable(),
  maxDurationSec: z.number().finite().positive().nullable(),
  defaultDurationSec: z.number().finite().positive().nullable(),
  lyrics: z.boolean(),
  autoDuration: z.boolean(),
});

const federatedMediaQueueStatusSchema = z.object({
  totalActive: z.number().int().nonnegative(),
  providerActive: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  maxQueuedJobs: z.number().int().positive(),
  accepting: z.boolean(),
});

// Strip unknown fields from peer responses before persisting or exposing them
// locally. Mixed-version compatibility lives in the versioned route and the
// known-field schema; an older consumer must not relay an unreviewed future
// status field (especially creative metadata) into its own client payload.
export const federatedMediaProviderStatusSchema = z.object({
  wireVersion: z.literal(FEDERATED_MEDIA_WIRE_VERSION),
  generatedAt: z.string().datetime(),
  staleAfterMs: z.number().int().positive().max(300_000),
  status: z.enum(['ready', 'busy', 'unavailable']),
  kinds: z.array(mediaKindSchema).max(1),
  queue: federatedMediaQueueStatusSchema,
  capabilities: z.array(federatedMediaCapabilitySchema).max(300),
});

/**
 * Check a validated provider snapshot against the consumer's clock.
 * A timestamp too far in the future is unknown rather than fresh: accepting it
 * would extend capacity indefinitely on a peer with a broken clock.
 */
export function inspectFederatedMediaStatusFreshness(status, now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const generatedAtMs = Date.parse(status?.generatedAt);
  const staleAfterMs = status?.staleAfterMs;
  if (!Number.isFinite(nowMs) || !Number.isFinite(generatedAtMs)
    || !Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
    return { fresh: false, reason: 'invalid-timestamp', freshUntil: null };
  }
  if (generatedAtMs - nowMs > FEDERATED_MEDIA_MAX_CLOCK_SKEW_MS) {
    return { fresh: false, reason: 'clock-skew', freshUntil: null };
  }
  const freshUntilMs = generatedAtMs + staleAfterMs;
  return {
    fresh: nowMs <= freshUntilMs,
    reason: nowMs <= freshUntilMs ? null : 'stale',
    freshUntil: new Date(freshUntilMs).toISOString(),
  };
}
