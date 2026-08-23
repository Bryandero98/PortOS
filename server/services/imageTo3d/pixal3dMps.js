/**
 * Pixal3D (local Apple Silicon / MPS) target — install detection, pure command
 * builders, progress parsing, and a guarded generate runner.
 *
 * The official TencentARC/Pixal3D entrypoint is CUDA-only. This lane uses the
 * complete community Apple Silicon port, which replaces Pixal3D's CUDA extension
 * stack with vendored Metal packages and ships `generate_mps.py` as its own CLI.
 * It is deliberately isolated from both the TRELLIS.2 MPS environment and the
 * Pixal3D CUDA environment: the fork pins Python/dependency versions and compiles
 * native extensions into its own `.venv`.
 *
 * The subprocess machinery is shared through `laneRunner.js`. No install or render
 * starts at module load; both are reached only from explicit user actions.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from '../../lib/childProcess.js';
import { appendMissingModules, describeDegradedInstall } from './degradedInstall.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import {
  hfGatedRepoHelp,
  isHfAuthError,
  isTransientInstallError,
  parseGenerateProgress,
} from './trellis2.js';
import {
  TRELLIS2_METAL_TOOLCHAIN_STEP,
  probeMetalToolchain,
} from './trellis2.js';
import {
  probePythonModules, runGenerateSubprocess, runInstallSteps, textMatcher,
} from './laneRunner.js';
import { renderOptionArgs, validateRenderOptions } from './renderOptions.js';

const HOME = homedir();
const CODE_PREFIX = 'PIXAL3D_MPS';
const LABEL = 'Pixal3D (Apple Silicon)';

/** The complete Apple Silicon / Metal port used by this target. */
export const PIXAL3D_MPS_REPO = 'https://github.com/pawel-mazurkiewicz/Pixal3D-mac.git';

/** Python version required by the port's pinned Mac dependency set. */
export const PIXAL3D_MPS_PYTHON_VERSION = '3.10';

/** Torch versions the fork pins; bootstrapped before pip resolves natten. */
export const PIXAL3D_MPS_TORCH_VERSION = '2.12.0';
export const PIXAL3D_MPS_TORCHVISION_VERSION = '0.27.0';
export const PIXAL3D_MPS_NATTEN_VERSION = '0.21.0';

/** Clone/install root. `base` is overridable so the entire lane is unit-testable. */
export function pixal3dMpsRoot(base = join(HOME, '.portos')) {
  return join(base, 'pixal3d-mps');
}

/** The port's private virtual-environment interpreter. */
export function pixal3dMpsVenvPython(base) {
  return join(pixal3dMpsRoot(base), '.venv', 'bin', 'python');
}

/** The port's Apple-native inference entrypoint. */
export function pixal3dMpsGenerateScript(base) {
  return join(pixal3dMpsRoot(base), 'generate_mps.py');
}

/** Installed ⇔ the private venv and the port's entrypoint both exist. */
export function isPixal3dMpsInstalled({ base, exists = existsSync } = {}) {
  return exists(pixal3dMpsVenvPython(base)) && exists(pixal3dMpsGenerateScript(base));
}

/**
 * The MPS port's two supported pipeline types. PortOS starts at 1024: the fork's
 * 1536 cascade can take up to roughly an hour on a high-memory Mac, so exposing it
 * as an automatic default would turn a normal Generate click into an unexpectedly
 * long job. A future target-specific detail control can opt into 1536 explicitly.
 */
export const PIXAL3D_MPS_PIPELINE_TYPES = Object.freeze(['1024_cascade', '1536_cascade']);
export const PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE = PIXAL3D_MPS_PIPELINE_TYPES[0];

/** Native packages the port's setup smoke check imports for the full Metal path. */
export const PIXAL3D_MPS_REQUIRED_MODULES = Object.freeze([
  'torch', 'moge', 'cumesh', 'flex_gemm', 'mtlbvh', 'mtldiffrast', 'o_voxel',
  'natten', 'natten_mps',
]);

/** Remedy text for a venv that exists but did not finish its native installs. */
export const PIXAL3D_MPS_INCOMPLETE_INSTALL_HELP = 'Pixal3D is installed but its '
  + 'Apple-native Python or Metal packages are incomplete. Repair install reruns the '
  + 'pinned setup and rebuilds the native packages; downloaded models are kept.';

/**
 * The fork's requirements list contains `natten`, whose build metadata imports torch.
 * Pip resolves all requirements before installing them, so a one-shot requirements
 * install fails on a fresh venv: the isolated natten build cannot see torch yet. Create
 * the venv and install the torch pair first, then install natten without build
 * isolation; the fork's setup script can subsequently resolve the remaining pins.
 */
export function buildPixal3dMpsBootstrapScript() {
  return [
    'set -euo pipefail',
    'PY="${PYTHON_BIN:-}"',
    'if [[ -z "$PY" ]]; then',
    '  for cand in /opt/homebrew/opt/python@3.10/bin/python3.10 "$(command -v python3.10 2>/dev/null || true)"; do',
    '    if [[ -n "$cand" && -x "$cand" ]]; then PY="$cand"; break; fi',
    '  done',
    'fi',
    '[[ -n "$PY" && -x "$PY" ]] || { echo "Python 3.10 not found; install python@3.10 or set PYTHON_BIN." >&2; exit 1; }',
    'if [[ ! -x .venv/bin/python ]]; then "$PY" -m venv .venv; fi',
    'VPY=.venv/bin/python',
    `"$VPY" -m pip install "torch==${PIXAL3D_MPS_TORCH_VERSION}" "torchvision==${PIXAL3D_MPS_TORCHVISION_VERSION}"`,
    `"$VPY" -m pip install --no-build-isolation "natten==${PIXAL3D_MPS_NATTEN_VERSION}"`,
  ].join('\n');
}

/**
 * Build the idempotent install plan for the Apple port.
 *
 * The upstream fork owns its setup script because it pins the Python dependency graph
 * and compiles six vendored Metal packages. Keeping that script intact is safer than
 * re-spelling its package order here. The optional toolchain step is placed before it,
 * because `setup_mac.sh` checks for `xcrun metal` before starting any build.
 *
 * @param {string} [base]
 * @param {{exists?: (path: string) => boolean, installMetalToolchain?: boolean}} [opts]
 * @returns {Array<{stage: string, command: string, args: string[], cwd?: string, optional?: boolean}>}
 */
export function buildPixal3dMpsInstallSteps(
  base,
  { exists = existsSync, installMetalToolchain = false } = {},
) {
  const root = pixal3dMpsRoot(base);
  const steps = [];
  if (installMetalToolchain) {
    steps.push({
      ...TRELLIS2_METAL_TOOLCHAIN_STEP,
      args: [...TRELLIS2_METAL_TOOLCHAIN_STEP.args],
    });
  }
  if (!exists(join(root, '.git'))) {
    steps.push({
      stage: 'clone',
      command: 'git',
      args: ['clone', '--depth', '1', PIXAL3D_MPS_REPO, root],
    });
  }
  steps.push({
    stage: 'bootstrap',
    command: 'bash',
    args: ['-c', buildPixal3dMpsBootstrapScript()],
    cwd: root,
  });
  steps.push({
    stage: 'setup',
    command: 'bash',
    args: ['scripts/setup_mac.sh'],
    cwd: root,
  });
  return steps;
}

/**
 * Probe the installed venv without importing torch or allocating Metal buffers.
 * `unknown: true` is distinct from an observed missing module so a failed probe does
 * not falsely label a possibly healthy install as broken.
 */
export async function probePixal3dMpsModules({
  base,
  exists = existsSync,
  execFileImpl = execFile,
} = {}) {
  const python = pixal3dMpsVenvPython(base);
  if (!exists(python)) return { unknown: true, missing: [] };
  const modules = await probePythonModules({
    python,
    modules: [...PIXAL3D_MPS_REQUIRED_MODULES],
    execFileImpl,
  });
  if (!modules) return { unknown: true, missing: [] };
  return {
    unknown: false,
    missing: PIXAL3D_MPS_REQUIRED_MODULES.filter((module) => !modules[module]),
  };
}

/**
 * Install the fork as a killable, event-emitting job. The setup script does not pull
 * model weights, so installation is expensive but does not cold-start inference; the
 * first explicit render downloads the Hugging Face models.
 */
export function installPixal3dMps({
  base,
  onEvent = () => {},
  spawnImpl = spawn,
  maxRetries = 3,
  sleep,
  exists = existsSync,
  env,
  installMetalToolchain = false,
  probeModules = probePixal3dMpsModules,
} = {}) {
  // The setup script's requirements command must inherit no-build-isolation as well:
  // if a future pin makes natten look unsatisfied, it should reuse the bootstrapped
  // torch rather than re-enter the same fresh-venv failure.
  const installEnv = {
    ...(env ?? process.env),
    PIP_NO_BUILD_ISOLATION: '1',
  };
  return runInstallSteps({
    steps: buildPixal3dMpsInstallSteps(base, { exists, installMetalToolchain }),
    label: LABEL,
    codePrefix: CODE_PREFIX,
    isTransient: isTransientInstallError,
    onEvent,
    spawnImpl,
    maxRetries,
    sleep,
    env: installEnv,
    verify: async (emit) => {
      if (!isPixal3dMpsInstalled({ base, exists })) {
        const error = new Error(
          `${LABEL} setup finished but its Python environment or generate_mps.py is missing.`,
        );
        error.code = `${CODE_PREFIX}_INSTALL_INCOMPLETE`;
        error.stage = 'verify';
        throw error;
      }
      const probe = await probeModules({ base, exists });
      if (probe.missing?.length) {
        emit({
          type: 'log',
          stage: 'verify',
          message: `⚠️ ${appendMissingModules(PIXAL3D_MPS_INCOMPLETE_INSTALL_HELP, probe.missing)}`,
        });
      } else if (!probe.unknown) {
        emit({ type: 'log', stage: 'verify', message: '✅ Pixal3D Apple Silicon environment is present.' });
      }
    },
  });
}

/**
 * Build the Apple-port CLI invocation. The fork accepts a full output path and
 * exposes the shared seed/steps controls directly, unlike the CUDA-only entrypoint.
 */
export function buildPixal3dMpsGenerateArgs({
  imagePath,
  outputPath,
  base,
  python,
  pipelineType = PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE,
  steps = null,
  seed = null,
} = {}) {
  if (!imagePath) throw new Error('buildPixal3dMpsGenerateArgs: imagePath is required');
  if (!PIXAL3D_MPS_PIPELINE_TYPES.includes(pipelineType)) {
    throw new Error(
      `buildPixal3dMpsGenerateArgs: pipelineType must be one of ${PIXAL3D_MPS_PIPELINE_TYPES.join(', ')}`,
    );
  }
  validateRenderOptions('buildPixal3dMpsGenerateArgs', { steps, seed });
  const args = [
    pixal3dMpsGenerateScript(base),
    imagePath,
    '--device', 'mps',
    '--pipeline-type', pipelineType,
  ];
  if (outputPath) args.push('--output', outputPath);
  args.push(...renderOptionArgs('buildPixal3dMpsGenerateArgs', { steps, seed }));
  return { command: python || pixal3dMpsVenvPython(base) || 'python3', args };
}

/** Apple-port stage banners, mapped into PortOS's shared progress vocabulary. */
const PIXAL3D_MPS_STAGE_SIGNATURES = [
  { re: /^\[Pipeline\] Loading/i, stage: 'loading', percent: 2 },
  { re: /^\[ImageCond\]/i, stage: 'loading', percent: 3 },
  { re: /^\[NAF\]/i, stage: 'loading', percent: 4 },
  { re: /^\[MoGe\]/i, stage: 'loading', percent: 7 },
  { re: /^\[Generate\]/i, stage: 'generating', percent: 10 },
  { re: /^\[Mesh\]/i, stage: 'meshing', percent: 55 },
  { re: /^\[Export\]/i, stage: 'texturing', percent: 65 },
  { re: /^\[Timing\]/i, stage: 'texturing', percent: 72 },
];

/** Parse one line of `generate_mps.py` output, or return null when it carries no signal. */
export function parsePixal3dMpsProgress(line) {
  const shared = parseGenerateProgress(line);
  if (shared) return shared;
  const text = String(line ?? '').trim();
  if (!text) return null;
  for (const signature of PIXAL3D_MPS_STAGE_SIGNATURES) {
    if (signature.re.test(text)) {
      return {
        stage: signature.stage,
        percent: signature.percent,
        message: text,
      };
    }
  }
  return null;
}

/** Apple Metal watchdog / empty-mesh failure signatures from the port's own help. */
export const isPixal3dMpsWatchdogError = textMatcher([
  'decoder produced an empty mesh',
  'macOS GPU watchdog',
  'kIOGPUCommandBufferCallbackErrorImpactingInteractivity',
  'BVH needs at least 8 triangles',
]);

export const PIXAL3D_MPS_WATCHDOG_HELP = 'The macOS GPU watchdog stopped this Pixal3D '
  + 'render during a long Metal dispatch. Nothing is wrong with the install. Put the '
  + 'display to sleep, close display-heavy apps, or retry at a lower pipeline tier.';

export const isPixal3dMpsOutOfMemoryError = textMatcher([
  'MPS backend out of memory',
  'MPSAllocator',
  'out of memory',
  'not enough memory',
]);

export const PIXAL3D_MPS_OUT_OF_MEMORY_HELP = 'Pixal3D ran out of Apple unified memory '
  + 'during this render. Close other GPU-heavy apps and retry; use the 1024 cascade '
  + 'rather than the 1536 cascade if you are running it directly.';

/**
 * Run one Apple-native image→GLB generation. This is guarded on the private venv and
 * entrypoint so a fresh boot cannot silently install or invoke the model.
 */
export function runPixal3dMpsGenerate({
  imagePath,
  outputPath,
  base,
  pipelineType,
  steps = null,
  seed = null,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
  env,
  postprocessGlb = rewriteGlbMaterialsOpaque,
} = {}) {
  const python = pixal3dMpsVenvPython(base);
  if (!exists(python) || !exists(pixal3dMpsGenerateScript(base))) {
    const error = new Error(`${LABEL} is not installed — install it before generating.`);
    error.code = `${CODE_PREFIX}_NOT_INSTALLED`;
    return { promise: Promise.reject(error), kill: () => {} };
  }
  const { command, args } = buildPixal3dMpsGenerateArgs({
    imagePath,
    outputPath,
    base,
    python,
    pipelineType,
    steps,
    seed,
  });
  // `generate_mps.py` uses tqdm and plain prints; without this flag a pipe buffers
  // the first several minutes of progress, leaving the shared render card looking
  // idle while MPS is actively sampling.
  const renderEnv = {
    ...(env ?? process.env),
    PYTHONUNBUFFERED: '1',
  };
  return runGenerateSubprocess({
    command,
    args,
    cwd: pixal3dMpsRoot(base),
    env: renderEnv,
    label: LABEL,
    codePrefix: CODE_PREFIX,
    parseProgress: parsePixal3dMpsProgress,
    assetPath: outputPath || null,
    onProgress,
    spawnImpl,
    postprocessGlb,
    classifiers: [
      { test: isPixal3dMpsWatchdogError, code: `${CODE_PREFIX}_MPS_WATCHDOG`, help: PIXAL3D_MPS_WATCHDOG_HELP },
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('pixal3dMps') },
      { test: isPixal3dMpsOutOfMemoryError, code: `${CODE_PREFIX}_OUT_OF_MEMORY`, help: PIXAL3D_MPS_OUT_OF_MEMORY_HELP },
    ],
  });
}

/**
 * Resolve the card's extra install diagnostics for the generic target card.
 * Kept as a helper for the adapter and direct tests; it never imports the native
 * packages itself.
 */
export async function describePixal3dMpsInstallState({
  base,
  exists = existsSync,
  execFileImpl = execFile,
} = {}) {
  const probe = await probePixal3dMpsModules({ base, exists, execFileImpl });
  const projection = probe.missing?.length
    ? describeDegradedInstall({
      label: 'incomplete install',
      help: PIXAL3D_MPS_INCOMPLETE_INSTALL_HELP,
      missing: probe.missing,
    })
    : null;
  return {
    fields: {
      ...(projection ? { degraded: projection.degraded } : {}),
    },
    warnings: projection?.warnings ?? [],
  };
}

/** Exported for the adapter's async preflight. */
export { probeMetalToolchain };
