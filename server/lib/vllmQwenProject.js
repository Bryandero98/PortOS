/**
 * Where the vLLM Qwen3.8-27B compose project lives, and whether its weights are
 * already on disk.
 *
 * PortOS does not vendor this stack. It is an upstream compose project
 * (`syv-ai/qwen38-27b-rtx3090`) an operator clones and prepares once, on a box
 * with an RTX 3090 and a working NVIDIA container runtime — a ~9.5 GB image plus
 * ~20 GB of weights. The readiness checklist's start button is a convenience for
 * a project that is ALREADY prepared: `docker compose --profile single up -d` in
 * a directory that has never been prepared would kick off exactly the multi-tens-
 * of-gigabytes download PortOS promises never to start on its own.
 *
 * So the button asks first, and this module is the question. It only reads
 * directory entries — it never runs docker, contacts a registry, or reads a
 * weight file.
 *
 * **Sentinels matter here.** `hasWeights` is a tri-state: `true` (an HF hub cache
 * entry for a Qwen repo was found), `false` (every candidate root was readable
 * and none held one), `null` (no candidate root could be read at all). The start
 * path treats anything other than `true` as "not verified" and refuses — but the
 * three cases get different copy, because "your cache is empty" and "I cannot see
 * your cache" send the operator to different fixes. The common `null` case is a
 * real deployment shape, not a bug: the compose stack can keep its HuggingFace
 * cache in a docker named volume, which on Windows/WSL lives inside the VM and is
 * invisible to a native-Win32 PortOS. `VLLM_QWEN_WEIGHTS_DIR` is the escape hatch
 * for that setup; otherwise the operator simply runs compose themselves, which is
 * the documented path anyway.
 */

import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/** Operator override for where the compose project was cloned. */
export const VLLM_PROJECT_DIR_ENV = 'VLLM_QWEN_PROJECT_DIR';

/**
 * Operator override for the HuggingFace cache holding the weights — the answer
 * for a stack whose cache is a docker named volume PortOS cannot see.
 */
export const VLLM_WEIGHTS_DIR_ENV = 'VLLM_QWEN_WEIGHTS_DIR';

/**
 * The user's home, read from the passed env before falling back to the OS —
 * so every path this module derives is injectable, and a test can never be
 * answered by the developer's real HuggingFace cache.
 */
const resolveHome = (env) =>
  String(env?.HOME || env?.USERPROFILE || '').trim() || homedir();

/** Where the upstream README tells the operator to clone it. */
export const vllmDefaultProjectDir = (env = process.env) => join(resolveHome(env), 'qwen-serving');

/** Compose file names the upstream project may ship under. */
const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * HuggingFace's hub cache names every repo directory `models--<org>--<repo>`.
 * Matching on `qwen` rather than an exact repo id is deliberate: the stack ships
 * a requant whose repo id upstream is free to rename, and a stale exact id would
 * report a perfectly prepared machine as empty.
 */
const QWEN_CACHE_ENTRY = /^models--.*qwen/i;

const isDirectory = (path) => stat(path).then((s) => s.isDirectory(), () => false);
const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);

/** The configured project directory, or upstream's documented default. */
export function resolveVllmProjectDir(env = process.env) {
  const configured = String(env?.[VLLM_PROJECT_DIR_ENV] || '').trim();
  return configured || vllmDefaultProjectDir(env);
}

/**
 * Candidate HuggingFace hub caches, most specific first: the operator's explicit
 * override, then the caches the compose project may bind-mount from its own
 * directory, then the user-level default `HF_HOME`/`~/.cache/huggingface`.
 */
function weightsCandidateRoots(projectDir, env = process.env) {
  const override = String(env?.[VLLM_WEIGHTS_DIR_ENV] || '').trim();
  const hfHome = String(env?.HF_HOME || '').trim();
  return [
    ...(override ? [override] : []),
    join(projectDir, 'models'),
    join(projectDir, 'hf-cache'),
    join(projectDir, 'huggingface', 'hub'),
    join(projectDir, '.cache', 'huggingface', 'hub'),
    ...(hfHome ? [join(hfHome, 'hub')] : []),
    join(resolveHome(env), '.cache', 'huggingface', 'hub'),
  ];
}

/**
 * Inspect the operator's vLLM project without touching docker.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{dir:string, hasProject:boolean, composeFile:string|null,
 *   hasWeights:boolean|null, weightsRoot:string|null}>}
 */
export async function inspectVllmQwenProject(env = process.env) {
  const dir = resolveVllmProjectDir(env);
  const hasProject = await isDirectory(dir);

  let composeFile = null;
  if (hasProject) {
    for (const name of COMPOSE_FILENAMES) {
      // eslint-disable-next-line no-await-in-loop -- four stats on one directory
      if (await isFile(join(dir, name))) { composeFile = name; break; }
    }
  }

  let readAnyRoot = false;
  let weightsRoot = null;
  for (const root of weightsCandidateRoots(dir, env)) {
    // eslint-disable-next-line no-await-in-loop -- short, ordered, first-match-wins
    const entries = await readdir(root).catch(() => null);
    if (entries === null) continue; // absent or unreadable — says nothing either way
    readAnyRoot = true;
    if (entries.some((name) => QWEN_CACHE_ENTRY.test(name))) { weightsRoot = root; break; }
  }

  return {
    dir,
    hasProject,
    composeFile,
    // `null` = no candidate cache could be read, which is NOT "no weights".
    hasWeights: weightsRoot ? true : (readAnyRoot ? false : null),
    weightsRoot,
  };
}

/**
 * Why the start button must not run compose, or `null` when it may. Prose, not a
 * code — the checklist renders it verbatim, and each case names the one command
 * that fixes it.
 *
 * @param {{dir:string, hasProject:boolean, composeFile:string|null, hasWeights:boolean|null}} project
 * @returns {string|null}
 */
export function vllmStartBlockedReason(project) {
  if (!project?.hasProject) {
    return `the compose project was not found at ${project?.dir}. Clone https://github.com/syv-ai/qwen38-27b-rtx3090 there (or set ${VLLM_PROJECT_DIR_ENV}) and run its prepare step once — PortOS never downloads the image or the weights.`;
  }
  if (!project.composeFile) {
    return `${project.dir} exists but holds no docker-compose file. Point ${VLLM_PROJECT_DIR_ENV} at the cloned syv-ai/qwen38-27b-rtx3090 checkout.`;
  }
  if (project.hasWeights === false) {
    return `the project is cloned but no Qwen weights are cached yet. Run its prepare step in a terminal — starting compose now would pull roughly 20 GB, which PortOS will not do for you.`;
  }
  if (project.hasWeights === null) {
    return `PortOS cannot see a HuggingFace cache for this project, so it cannot confirm the weights are already downloaded (a cache kept in a docker volume is invisible from here). Start it yourself with \`docker compose --profile single up -d\` in ${project.dir}, or set ${VLLM_WEIGHTS_DIR_ENV} to the cache directory once the weights are on disk.`;
  }
  return null;
}
