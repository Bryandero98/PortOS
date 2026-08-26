import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

describe('local image execution marker', () => {
  const buildMarker = (requestedDevice, effectiveDevice, placement) => {
    const program = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      'from _runner_common import build_image_execution_marker',
      `print(json.dumps(build_image_execution_marker('diffusers-image', ${JSON.stringify(requestedDevice)}, ${JSON.stringify(effectiveDevice)}, ${JSON.stringify(placement)}, [])))`,
    ].join('; ');
    return JSON.parse(execFileSync('python3', ['-c', program], { encoding: 'utf8' }));
  };

  it('records the Windows split CUDA placement as confirmed', () => {
    expect(buildMarker('cuda', 'cuda', 'cuda+offload')).toMatchObject({
      state: 'confirmed',
      requestedDevice: 'cuda',
      effectiveDevice: 'cuda',
      placement: 'cuda+offload',
      cpuFallback: false,
      runtime: { runtime: 'diffusers-image', versions: {} },
    });
  });
  it('records a CPU fallback as degraded without host or prompt data', () => {
    const program = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(scriptsDir)})`,
      'from _runner_common import build_image_execution_marker',
      "print(json.dumps(build_image_execution_marker('flux2', 'cuda', 'cpu', 'cpu', [])))",
    ].join('; ');
    const marker = JSON.parse(execFileSync('python3', ['-c', program], { encoding: 'utf8' }));

    expect(marker).toMatchObject({
      version: 1,
      state: 'degraded',
      requestedDevice: 'cuda',
      effectiveDevice: 'cpu',
      placement: 'cpu',
      cpuFallback: true,
      runtime: { runtime: 'flux2', versions: {} },
    });
    expect(marker).not.toHaveProperty('prompt');
    expect(marker).not.toHaveProperty('path');
  });
});
