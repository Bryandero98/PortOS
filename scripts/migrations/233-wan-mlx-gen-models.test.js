import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './233-wan-mlx-gen-models.js';

const oldRows = () => ({
  video: { macos: [
    { id: 'wan22_t2v_a14b', name: 'Wan 2.2 T2V A14B (~28 GB, MoE-14B-active)', repo: 'Wan-AI/Wan2.2-T2V-A14B', runtime: 'wan22', mode: 't2v', steps: 25, guidance: 5 },
    { id: 'wan22_i2v_a14b', name: 'Wan 2.2 I2V A14B (~28 GB, image-to-video)', repo: 'Wan-AI/Wan2.2-I2V-A14B', runtime: 'wan22', mode: 'i2v', steps: 25, guidance: 5 },
  ] },
  _shippedDefaults: { video: { macos: ['wan22_t2v_a14b', 'wan22_i2v_a14b'] } },
});

describe('migration 233 — Wan MLX-Gen models', () => {
  let rootDir;
  let path;
  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-233-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    path = join(rootDir, 'data', 'media-models.json');
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));
  const write = (value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(path, 'utf-8'));

  it('upgrades shipped A14B rows and adds TI2V plus both Lightning profiles', async () => {
    write(oldRows());
    await migration.up({ rootDir });
    const config = read();
    const byId = new Map(config.video.macos.map((entry) => [entry.id, entry]));
    expect(byId.get('wan22_t2v_a14b')).toMatchObject({
      repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
      supportedModes: ['text'], frameStride: 4, steps: 20, guidance: 4,
    });
    expect(byId.get('wan22_t2v_a14b').mode).toBeUndefined();
    expect(byId.get('wan22_ti2v_5b').supportedModes).toEqual(['text', 'image']);
    expect(byId.get('wan22_t2v_a14b_lightning').requiredWeights[0].files).toHaveLength(2);
    expect(byId.get('wan22_i2v_a14b_lightning').samplerLocked).toBe(true);
    expect(config._shippedDefaults.video.macos).toContain('wan22_ti2v_5b');
  });

  it('preserves a forked existing row while still adding genuinely new ids', async () => {
    const config = oldRows();
    config.video.macos[0].repo = 'example/Wan-fork';
    config.video.macos[0].steps = 17;
    write(config);
    await migration.up({ rootDir });
    const next = read();
    expect(next.video.macos.find((entry) => entry.id === 'wan22_t2v_a14b')).toMatchObject({ repo: 'example/Wan-fork', steps: 17 });
    expect(next.video.macos.some((entry) => entry.id === 'wan22_ti2v_5b')).toBe(true);
  });

  it('preserves user-tuned fields while upgrading a shipped repository', async () => {
    const config = oldRows();
    Object.assign(config.video.macos[0], {
      name: 'My Wan profile',
      steps: 17,
      guidance: 6,
    });
    write(config);
    await migration.up({ rootDir });
    const upgraded = read().video.macos.find((entry) => entry.id === 'wan22_t2v_a14b');
    expect(upgraded).toMatchObject({
      name: 'My Wan profile',
      repo: 'AbstractFramework/wan2.2-t2v-a14b-diffusers-8bit',
      steps: 17,
      guidance: 6,
    });
  });

  it('is idempotent', async () => {
    write(oldRows());
    await migration.up({ rootDir });
    const once = readFileSync(path, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(path, 'utf-8')).toBe(once);
  });
});
