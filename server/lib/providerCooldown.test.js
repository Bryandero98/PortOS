import { describe, it, expect } from 'vitest';

import {
  COOLDOWN_MS_BY_CATEGORY,
  DEFAULT_COOLDOWN_MS,
  isRequestSpecificCategory,
  isSchemaTypeCategory,
  resolveProviderBench,
} from './providerCooldown.js';

describe('isSchemaTypeCategory', () => {
  it('covers the tiered cascade\'s schema/type categories', () => {
    for (const c of ['parse-error', 'bad-request', 'context-length', 'output-length', 'build-error', 'lint-error']) {
      expect(isSchemaTypeCategory(c)).toBe(true);
    }
    expect(isSchemaTypeCategory('auth-error')).toBe(false);
    expect(isSchemaTypeCategory(undefined)).toBe(false);
  });
});

describe('isRequestSpecificCategory', () => {
  // These describe THIS request, not the provider — benching would take a
  // healthy service offline for every other caller.
  it('is true for refusals, bad model ids, and schema/type failures', () => {
    expect(isRequestSpecificCategory('content-refusal')).toBe(true);
    expect(isRequestSpecificCategory('model-not-found')).toBe(true);
    expect(isRequestSpecificCategory('parse-error')).toBe(true);
  });

  it('is false for the categories that mean the provider itself is down', () => {
    expect(isRequestSpecificCategory('auth-error')).toBe(false);
    expect(isRequestSpecificCategory('rate-limit')).toBe(false);
    expect(isRequestSpecificCategory('network-error')).toBe(false);
  });
});

describe('resolveProviderBench', () => {
  it('declines to bench a request-specific failure', () => {
    expect(resolveProviderBench({ category: 'content-refusal' })).toBeNull();
    expect(resolveProviderBench({ category: 'model-not-found' })).toBeNull();
    expect(resolveProviderBench({ category: 'output-length' })).toBeNull();
  });

  // markUsageLimit parses its own window out of the provider's message
  // ("resets 5pm"), so it gets a distinct marker rather than a flat cooldown.
  it('routes a usage limit to its own marker, carrying the parsed wait', () => {
    expect(resolveProviderBench({ category: 'usage-limit', message: 'hit your limit', waitTime: 'resets 5pm' })).toEqual({
      marker: 'usage-limit',
      category: 'usage-limit',
      message: 'hit your limit',
      waitTime: 'resets 5pm',
    });
  });

  it('resolves the per-category cooldown for a provider outage', () => {
    expect(resolveProviderBench({ category: 'auth-error', message: 'nope' })).toEqual({
      marker: 'unavailable',
      category: 'auth-error',
      message: 'nope',
      waitTimeMs: COOLDOWN_MS_BY_CATEGORY['auth-error'],
    });
  });

  // Categories outside the table (agentErrorAnalysis carries its own, richer
  // set — 'forbidden', 'claude-error') still bench, just briefly.
  it('falls back to the default cooldown for an untabled category', () => {
    expect(resolveProviderBench({ category: 'forbidden' })).toMatchObject({
      marker: 'unavailable',
      waitTimeMs: DEFAULT_COOLDOWN_MS,
    });
  });

  it('treats a missing category as unknown rather than skipping the bench', () => {
    expect(resolveProviderBench(null)).toMatchObject({
      marker: 'unavailable',
      category: 'unknown',
      waitTimeMs: COOLDOWN_MS_BY_CATEGORY.unknown,
    });
  });
});
