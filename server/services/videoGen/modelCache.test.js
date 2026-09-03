import { describe, it, expect, vi } from 'vitest';

// Target-shaping contract for the HF cache engine (issue #5711). These three
// behaviors used to be reachable only by driving /models/status, /models/verify
// and /models/:id/repair, so a regression in how a download target is scoped or
// keyed showed up as a wrong HTTP payload rather than a failing unit.

vi.mock('../../lib/mediaModels.js', () => ({
  repoForModel: vi.fn((m) => m.repo || null),
  getTextEncoderRepo: vi.fn(() => 'org/text-encoder'),
  isHfRepoId: vi.fn(() => true),
}));

vi.mock('../../lib/videoTextEncoders.js', () => ({
  downloadableVideoTextEncoders: vi.fn(() => []),
  downloadableVideoTextEncoder: vi.fn(() => null),
}));

vi.mock('../../lib/videoDraftDecoders.js', () => ({
  downloadableVideoDraftDecoders: vi.fn(() => []),
}));

vi.mock('../../lib/icLoraWeights.js', () => ({
  IC_LORA_MODE_VALUES: ['ic-control'],
  icLoraSpecForMode: vi.fn(() => null),
  icLoraRepos: vi.fn(() => []),
}));

vi.mock('./local.js', () => ({
  listVideoModels: vi.fn(() => [
    { id: 'wan_lightning', repo: 'org/wan-base', revision: 'a'.repeat(40) },
  ]),
}));

import {
  modelDownloadTargets, targetKey, reposToVerify,
} from './modelCache.js';

describe('videoGen model cache targets', () => {
  it('scopes an unlisted model repo to a whole-repo snapshot', () => {
    // No `repoFiles` means "snapshot the repo" — an empty `only` is what routes
    // the target to verifyModelCache instead of verifyCachedRepoFiles.
    expect(modelDownloadTargets({ id: 'ltx2', repo: 'org/ltx2' }))
      .toEqual([{ repo: 'org/ltx2', revision: null, only: [] }]);
  });

  it('keys two targets that differ only by revision distinctly', () => {
    // A collision here would let reposToVerify() dedupe away a pinned revision
    // and report a stale repo as fresh.
    const base = { repo: 'org/wan', only: ['model.safetensors'] };
    expect(targetKey({ ...base, revision: 'a'.repeat(40) }))
      .not.toBe(targetKey({ ...base, revision: 'b'.repeat(40) }));
    expect(targetKey({ ...base, revision: null })).toBe(targetKey(base));
  });

  it('covers the shared text encoder alongside the model repos on an unscoped scan', () => {
    expect(reposToVerify().map((t) => t.repo))
      .toEqual(['org/wan-base', 'org/text-encoder']);
    // Scoped to one model, only that model's repos are walked.
    expect(reposToVerify('wan_lightning').map((t) => t.repo)).toEqual(['org/wan-base']);
    expect(reposToVerify('nope')).toEqual([]);
  });
});
