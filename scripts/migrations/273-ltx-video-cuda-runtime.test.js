import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import migration from './273-ltx-video-cuda-runtime.js';

const writeRegistry = (rootDir, video) => {
  const dataDir = join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'media-models.json'), JSON.stringify({ video }));
};

describe('273-ltx-video-cuda-runtime', () => {
  it('upgrades the uncustomized CUDA LTX entry', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'portos-migration-'));
    try {
      writeRegistry(rootDir, {
        cuda: [{ id: 'ltx_video', runtime: 'mlx_video' }],
      });
      await migration.up({ rootDir });
      const saved = JSON.parse(readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf8'));
      expect(saved.video.cuda[0].runtime).toBe('cuda_video');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('preserves a repointed entry', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'portos-migration-'));
    try {
      writeRegistry(rootDir, {
        cuda: [{ id: 'ltx_video', runtime: 'mlx_video', repo: 'example-org/ltx-fork' }],
      });
      await migration.up({ rootDir });
      const saved = JSON.parse(readFileSync(join(rootDir, 'data', 'media-models.json'), 'utf8'));
      expect(saved.video.cuda[0].runtime).toBe('mlx_video');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
