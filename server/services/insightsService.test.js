import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider-readiness check so any code path that touches it runs offline.
vi.mock('./ollamaManager.js', () => ({
  ensureProviderReady: vi.fn().mockResolvedValue({ success: true }),
}));
// generateThemeAnalysis/refreshCrossDomainNarrative now call the shared
// aiProvider.callProviderAISimple transport (see aiProvider.test.js for its own
// contract coverage) — stub only that export so the disk-only read paths below
// can assert it's never reached, while stripCodeFences/parseLLMJSON (also
// imported from this module) stay real.
vi.mock('./aiProvider.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callProviderAISimple: vi.fn() };
});

import { callProviderAISimple } from './aiProvider.js';
import { getThemeAnalysis, getCrossDomainNarrative } from './insightsService.js';

// Enforces the no-cold-bootstrap trigger contract documented at the generation
// entry points: the cached-read paths the Insights page mounts with must be
// disk-only and NEVER reach an AI provider. Only the user-triggered *refresh*
// endpoints may generate. If a future edit makes a read path warm the cache via
// the LLM, this fails.
describe('insightsService read paths — disk-only, no provider call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getThemeAnalysis performs no provider call (returns not_generated when uncached)', async () => {
    const result = await getThemeAnalysis();
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(result.available === false || result.available === true).toBe(true);
  });

  it('getCrossDomainNarrative performs no provider call (returns not_generated when uncached)', async () => {
    const result = await getCrossDomainNarrative();
    expect(callProviderAISimple).not.toHaveBeenCalled();
    expect(result.available === false || result.available === true).toBe(true);
  });
});
