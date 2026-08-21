import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  VLLM_PROJECT_DIR_ENV,
  VLLM_WEIGHTS_DIR_ENV,
  inspectVllmQwenProject,
  resolveVllmProjectDir,
  vllmDefaultProjectDir,
  vllmStartBlockedReason,
} from './vllmQwenProject.js';

let root;
const projectDir = () => join(root, 'qwen-serving');

/**
 * An env with HOME/USERPROFILE/HF_HOME pointed inside the sandbox. Without it,
 * the developer's own `~/.cache/huggingface/hub` is a readable candidate root
 * and the "nothing readable" case can never be exercised.
 */
const env = (extra = {}) => ({
  [VLLM_PROJECT_DIR_ENV]: projectDir(),
  HOME: join(root, 'home'),
  USERPROFILE: join(root, 'home'),
  HF_HOME: join(root, 'no-hf'),
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vllm-project-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveVllmProjectDir', () => {
  it('prefers the operator override over upstream default', () => {
    expect(resolveVllmProjectDir({ [VLLM_PROJECT_DIR_ENV]: '/srv/qwen' })).toBe('/srv/qwen');
  });

  it('ignores a blank override rather than resolving to an empty path', () => {
    const home = { HOME: '/home/example', USERPROFILE: '/home/example' };
    expect(resolveVllmProjectDir({ ...home, [VLLM_PROJECT_DIR_ENV]: '   ' }))
      .toBe(vllmDefaultProjectDir(home));
  });
});

describe('inspectVllmQwenProject', () => {
  it('reports no project when the directory is absent', async () => {
    const project = await inspectVllmQwenProject(env());
    expect(project).toMatchObject({ hasProject: false, composeFile: null });
    expect(vllmStartBlockedReason(project)).toContain('syv-ai/qwen38-27b-rtx3090');
  });

  it('reports a directory with no compose file as not a project', async () => {
    mkdirSync(projectDir(), { recursive: true });
    const project = await inspectVllmQwenProject(env());
    expect(project).toMatchObject({ hasProject: true, composeFile: null });
    expect(vllmStartBlockedReason(project)).toContain('no docker-compose file');
  });

  it('finds the compose file but blocks while no weights cache is readable', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');

    const project = await inspectVllmQwenProject(env());
    expect(project.composeFile).toBe('docker-compose.yml');
    // `null`, not `false` — nothing was READ, which is a different fix than an
    // empty cache. The distinction is the point of the sentinel.
    expect(project.hasWeights).toBeNull();
    expect(vllmStartBlockedReason(project)).toContain('cannot see a HuggingFace cache');
  });

  it('distinguishes a readable-but-empty cache from an unreadable one', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'compose.yaml'), 'services: {}\n');
    mkdirSync(join(projectDir(), 'models'), { recursive: true });

    const project = await inspectVllmQwenProject(env());
    expect(project).toMatchObject({ composeFile: 'compose.yaml', hasWeights: false });
    expect(vllmStartBlockedReason(project)).toContain('no Qwen weights are cached');
  });

  it('clears the block once a Qwen hub-cache entry is present', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    mkdirSync(join(projectDir(), 'models', 'models--syv-ai--Qwen3.8-27B-w4a16'), { recursive: true });

    const project = await inspectVllmQwenProject(env());
    expect(project.hasWeights).toBe(true);
    expect(project.weightsRoot).toBe(join(projectDir(), 'models'));
    expect(vllmStartBlockedReason(project)).toBeNull();
  });

  it('ignores a cache holding only unrelated models', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    mkdirSync(join(projectDir(), 'models', 'models--meta-llama--Llama-3.1-8B'), { recursive: true });

    expect((await inspectVllmQwenProject(env())).hasWeights).toBe(false);
  });

  it('honors the weights-directory override, for a cache PortOS cannot otherwise see', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const cache = join(root, 'elsewhere', 'hub');
    mkdirSync(join(cache, 'models--syv-ai--qwen3.8-27b'), { recursive: true });

    const project = await inspectVllmQwenProject(env({ [VLLM_WEIGHTS_DIR_ENV]: cache }));
    expect(project).toMatchObject({ hasWeights: true, weightsRoot: cache });
  });

  it('finds an HF_HOME hub cache', async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'docker-compose.yml'), 'services: {}\n');
    const hfHome = join(root, 'hf');
    mkdirSync(join(hfHome, 'hub', 'models--Qwen--Qwen3.8-27B'), { recursive: true });

    const project = await inspectVllmQwenProject(env({ HF_HOME: hfHome }));
    expect(project.hasWeights).toBe(true);
  });
});
