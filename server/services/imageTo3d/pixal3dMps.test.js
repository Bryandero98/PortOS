import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE,
  PIXAL3D_MPS_NATTEN_VERSION,
  PIXAL3D_MPS_PIPELINE_TYPES,
  PIXAL3D_MPS_REPO,
  PIXAL3D_MPS_REQUIRED_MODULES,
  PIXAL3D_MPS_TORCH_VERSION,
  PIXAL3D_MPS_TORCHVISION_VERSION,
  buildPixal3dMpsGenerateArgs,
  buildPixal3dMpsBootstrapScript,
  buildPixal3dMpsInstallSteps,
  isPixal3dMpsInstalled,
  isPixal3dMpsOutOfMemoryError,
  isPixal3dMpsWatchdogError,
  parsePixal3dMpsProgress,
  pixal3dMpsGenerateScript,
  pixal3dMpsRoot,
  pixal3dMpsVenvPython,
  probePixal3dMpsModules,
  runPixal3dMpsGenerate,
} from './pixal3dMps.js';

const BASE = join('/tmp', 'portos-test-home');
const ROOT = join(BASE, 'pixal3d-mps');
const VENV = join(ROOT, '.venv', 'bin', 'python');
const SCRIPT = join(ROOT, 'generate_mps.py');
const existsFor = (...paths) => (path) => paths.includes(path);

const makeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};

describe('pixal3dMps path and install plan', () => {
  it('keeps the Apple port isolated from the other image-to-3D lanes', () => {
    expect(pixal3dMpsRoot(BASE)).toBe(ROOT);
    expect(pixal3dMpsVenvPython(BASE)).toBe(VENV);
    expect(pixal3dMpsGenerateScript(BASE)).toBe(SCRIPT);
  });

  it('requires both the private venv and generate_mps.py', () => {
    expect(isPixal3dMpsInstalled({ base: BASE, exists: existsFor(VENV, SCRIPT) })).toBe(true);
    expect(isPixal3dMpsInstalled({ base: BASE, exists: existsFor(VENV) })).toBe(false);
    expect(isPixal3dMpsInstalled({ base: BASE, exists: existsFor(SCRIPT) })).toBe(false);
  });

  it('clones the MPS fork and delegates dependency/native builds to setup_mac.sh', () => {
    const steps = buildPixal3dMpsInstallSteps(BASE, { exists: () => false });
    expect(steps[0]).toEqual({
      stage: 'clone',
      command: 'git',
      args: ['clone', '--depth', '1', PIXAL3D_MPS_REPO, ROOT],
    });
    expect(steps[1]).toMatchObject({ stage: 'bootstrap', command: 'bash', cwd: ROOT });
    expect(steps[1].args[0]).toBe('-c');
    expect(steps[1].args[1]).toContain(`torch==${PIXAL3D_MPS_TORCH_VERSION}`);
    expect(steps[1].args[1]).toContain(`torchvision==${PIXAL3D_MPS_TORCHVISION_VERSION}`);
    expect(steps[1].args[1]).toContain(`natten==${PIXAL3D_MPS_NATTEN_VERSION}`);
    expect(steps[2]).toEqual({
      stage: 'setup',
      command: 'bash',
      args: ['scripts/setup_mac.sh'],
      cwd: ROOT,
    });
    expect(buildPixal3dMpsBootstrapScript()).toContain('set -euo pipefail');
  });

  it('puts the optional Metal toolchain fetch before setup', () => {
    const steps = buildPixal3dMpsInstallSteps(BASE, {
      exists: () => false,
      installMetalToolchain: true,
    });
    expect(steps[0]).toMatchObject({
      stage: 'metal-toolchain',
      command: 'xcodebuild',
      args: ['-downloadComponent', 'MetalToolchain'],
      optional: true,
    });
    expect(steps[1].stage).toBe('clone');
    expect(steps[2].stage).toBe('bootstrap');
    expect(steps[3].stage).toBe('setup');
  });

  it('resumes a cloned checkout without issuing a second clone', () => {
    const steps = buildPixal3dMpsInstallSteps(BASE, {
      exists: existsFor(join(ROOT, '.git')),
    });
    expect(steps.map((step) => step.stage)).toEqual(['bootstrap', 'setup']);
  });
});

describe('pixal3dMps command builder', () => {
  it('emits the fork CLI contract and shared seed/steps flags', () => {
    const built = buildPixal3dMpsGenerateArgs({
      imagePath: '/tmp/source.png',
      outputPath: '/tmp/model.glb',
      base: BASE,
      python: VENV,
      pipelineType: '1536_cascade',
      steps: 24,
      seed: 7,
    });
    expect(built).toEqual({
      command: VENV,
      args: [
        SCRIPT,
        '/tmp/source.png',
        '--device', 'mps',
        '--pipeline-type', '1536_cascade',
        '--output', '/tmp/model.glb',
        '--seed', '7',
        '--steps', '24',
      ],
    });
  });

  it('defaults to the safe 1024 cascade and validates the pipeline enum', () => {
    expect(PIXAL3D_MPS_PIPELINE_TYPES).toEqual(['1024_cascade', '1536_cascade']);
    expect(PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE).toBe('1024_cascade');
    expect(buildPixal3dMpsGenerateArgs({ imagePath: '/tmp/source.png', base: BASE }).args)
      .toContain('1024_cascade');
    expect(() => buildPixal3dMpsGenerateArgs({
      imagePath: '/tmp/source.png', base: BASE, pipelineType: '512',
    })).toThrow(/pipelineType must be one of/);
    expect(() => buildPixal3dMpsGenerateArgs({
      imagePath: '/tmp/source.png', base: BASE, steps: 65,
    })).toThrow(/steps must be an integer/);
  });
});

describe('pixal3dMps module probe', () => {
  it('reports missing native packages without importing them', async () => {
    const execFileImpl = vi.fn((_python, _args, _options, callback) => {
      callback(null, JSON.stringify({
        ...Object.fromEntries(PIXAL3D_MPS_REQUIRED_MODULES.map((module) => [module, true])),
        o_voxel: false,
      }));
    });
    const result = await probePixal3dMpsModules({
      base: BASE,
      exists: existsFor(VENV),
      execFileImpl,
    });
    expect(result).toEqual({ unknown: false, missing: ['o_voxel'] });
    expect(execFileImpl).toHaveBeenCalledOnce();
  });

  it('keeps a failed probe distinct from a missing package', async () => {
    const execFileImpl = vi.fn((_python, _args, _options, callback) => callback(new Error('probe failed')));
    await expect(probePixal3dMpsModules({
      base: BASE,
      exists: existsFor(VENV),
      execFileImpl,
    })).resolves.toEqual({ unknown: true, missing: [] });
  });
});

describe('pixal3dMps progress and error classification', () => {
  it('maps the fork banners and preserves the shared GLB terminal signal', () => {
    expect(parsePixal3dMpsProgress('[Pipeline] Loading from TencentARC/Pixal3D...'))
      .toMatchObject({ stage: 'loading', percent: 2 });
    expect(parsePixal3dMpsProgress('[Generate] pipeline=1024_cascade, seed=7'))
      .toMatchObject({ stage: 'generating', percent: 10 });
    expect(parsePixal3dMpsProgress('[Done] GLB saved to /tmp/model.glb'))
      .toMatchObject({ stage: 'export', percent: 92, assetPath: '/tmp/model.glb' });
  });

  it('recognizes the fork-specific watchdog and memory failures', () => {
    expect(isPixal3dMpsWatchdogError('ERROR: The decoder produced an empty mesh')).toBe(true);
    expect(isPixal3dMpsOutOfMemoryError('MPS backend out of memory')).toBe(true);
    expect(isPixal3dMpsWatchdogError('ordinary Python failure')).toBe(false);
  });
});

describe('runPixal3dMpsGenerate', () => {
  it('refuses to spawn when the isolated runtime is absent', async () => {
    const spawnImpl = vi.fn();
    const result = runPixal3dMpsGenerate({
      base: BASE,
      imagePath: '/tmp/source.png',
      outputPath: '/tmp/model.glb',
      exists: () => false,
      spawnImpl,
    });
    await expect(result.promise).rejects.toMatchObject({ code: 'PIXAL3D_MPS_NOT_INSTALLED' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('spawns from the fork checkout and resolves the produced GLB', async () => {
    const child = makeChild();
    const spawnImpl = vi.fn(() => child);
    const postprocessGlb = vi.fn();
    const result = runPixal3dMpsGenerate({
      base: BASE,
      imagePath: '/tmp/source.png',
      outputPath: '/tmp/model.glb',
      steps: 12,
      seed: 42,
      exists: existsFor(VENV, SCRIPT),
      spawnImpl,
      postprocessGlb,
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      VENV,
      expect.arrayContaining(['--device', 'mps', '--pipeline-type', '1024_cascade']),
      expect.objectContaining({
        cwd: ROOT,
        env: expect.objectContaining({ PYTHONUNBUFFERED: '1' }),
      }),
    );
    child.stdout.emit('data', '[Done] GLB saved to /tmp/model.glb\n');
    child.emit('close', 0);
    await expect(result.promise).resolves.toEqual({ assetPath: '/tmp/model.glb' });
    expect(postprocessGlb).toHaveBeenCalledWith('/tmp/model.glb');
  });
});
