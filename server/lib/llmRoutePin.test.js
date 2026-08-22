import { describe, it, expect } from 'vitest';
import {
  LLM_ROUTE_PIN_LIMITS,
  llmRoutePinSchema,
  resolveLlmRoutePin,
  sanitizeLlmRoutePin,
} from './llmRoutePin.js';

describe('sanitizeLlmRoutePin', () => {
  it('trims each dimension and nulls the empty ones', () => {
    expect(sanitizeLlmRoutePin({ providerId: '  claude  ', model: '', effort: null })).toEqual({
      providerId: 'claude',
      model: null,
      effort: null,
    });
  });

  it('returns null for a non-object, a missing pin, or an all-empty pin', () => {
    expect(sanitizeLlmRoutePin(null)).toBeNull();
    expect(sanitizeLlmRoutePin(undefined)).toBeNull();
    expect(sanitizeLlmRoutePin('claude')).toBeNull();
    expect(sanitizeLlmRoutePin({ providerId: '   ' })).toBeNull();
  });

  it('caps each field at its limit', () => {
    const pin = sanitizeLlmRoutePin({
      providerId: 'p'.repeat(500),
      model: 'm'.repeat(500),
      effort: 'e'.repeat(500),
    });
    expect(pin.providerId).toHaveLength(LLM_ROUTE_PIN_LIMITS.PROVIDER_ID_MAX);
    expect(pin.model).toHaveLength(LLM_ROUTE_PIN_LIMITS.MODEL_ID_MAX);
    expect(pin.effort).toHaveLength(LLM_ROUTE_PIN_LIMITS.EFFORT_MAX);
  });
});

describe('llmRoutePinSchema', () => {
  it('accepts a full pin, a partial pin, and per-field nulls', () => {
    expect(llmRoutePinSchema.safeParse({ providerId: 'claude', model: 'opus', effort: 'high' }).success).toBe(true);
    expect(llmRoutePinSchema.safeParse({ providerId: 'claude' }).success).toBe(true);
    expect(llmRoutePinSchema.safeParse({ providerId: null, model: null, effort: null }).success).toBe(true);
    expect(llmRoutePinSchema.safeParse({}).success).toBe(true);
  });

  it('rejects an effort outside the shared ladder rather than letting the runner clamp it', () => {
    expect(llmRoutePinSchema.safeParse({ effort: 'turbo' }).success).toBe(false);
  });

  it('rejects an over-length provider or model id', () => {
    expect(llmRoutePinSchema.safeParse({ providerId: 'p'.repeat(500) }).success).toBe(false);
    expect(llmRoutePinSchema.safeParse({ model: 'm'.repeat(500) }).success).toBe(false);
  });
});

describe('resolveLlmRoutePin', () => {
  const pin = { providerId: 'claude', model: 'opus', effort: 'high' };

  it('falls back to the whole pin when the call names nothing', () => {
    expect(resolveLlmRoutePin(pin)).toEqual({ ...pin, providerMatchesPin: true });
    expect(resolveLlmRoutePin(pin, {})).toEqual({ ...pin, providerMatchesPin: true });
  });

  it('inherits the pinned model and effort when the call names the pinned provider', () => {
    expect(resolveLlmRoutePin(pin, { providerId: 'claude' })).toEqual({ ...pin, providerMatchesPin: true });
  });

  it('drops the pinned model and effort when the call switches provider', () => {
    expect(resolveLlmRoutePin(pin, { providerId: 'codex' })).toEqual({
      providerId: 'codex',
      model: null,
      effort: null,
      providerMatchesPin: false,
    });
  });

  it('honors an explicit per-call model and effort across a provider switch', () => {
    expect(resolveLlmRoutePin(pin, { providerId: 'codex', model: 'gpt-x', effort: 'low' })).toEqual({
      providerId: 'codex',
      model: 'gpt-x',
      effort: 'low',
      providerMatchesPin: false,
    });
  });

  it('lets a per-call pick beat the pin on one dimension while inheriting the rest', () => {
    expect(resolveLlmRoutePin(pin, { model: 'sonnet' })).toEqual({
      providerId: 'claude',
      model: 'sonnet',
      effort: 'high',
      providerMatchesPin: true,
    });
  });

  it('tolerates a missing pin', () => {
    expect(resolveLlmRoutePin(null, { providerId: 'codex' })).toEqual({
      providerId: 'codex',
      model: null,
      effort: null,
      providerMatchesPin: false,
    });
    expect(resolveLlmRoutePin(undefined)).toEqual({
      providerId: null,
      model: null,
      effort: null,
      providerMatchesPin: true,
    });
  });
});
