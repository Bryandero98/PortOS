/**
 * What MTPLX has in its own model cache, and which entry PortOS may serve.
 *
 * `mtplx serve` takes NO model from its config — the CLI hard-codes its default
 * checkpoint (`Youssofal/Qwen3.8-27B-…`) as the `--model` default. On a machine
 * where that exact repo was never pulled the server prints
 *
 *   error: model is not available locally
 *   detail: … is not cached. Run: mtplx pull …
 *
 * and exits 1 before it binds a port — including when the user HAS pulled a
 * different MTP checkpoint that would have served fine. That is what turned the
 * readiness checklist's "Start MTPLX" button into "MTPLX did not start: mtplx
 * exited early (code 1)".
 *
 * So PortOS asks first. `mtplx models --json` is a local directory listing (no
 * network, no model load), and naming a cached repo on the command line is the
 * difference between a server that comes up and one that cannot. PortOS still
 * never downloads weights — a multi-gigabyte pull stays the user's decision,
 * exactly as `docs/features/mtplx.md` promises.
 */

import { bufferedSpawn } from './bufferedSpawn.js';
import { safeJSONParse } from './fileUtils.js';
import { findCommandOnPath } from './processEnv.js';

/** A cache listing walks the model directories to size them; be generous. */
const CACHE_QUERY_TIMEOUT_MS = 30_000;

/**
 * The models in MTPLX's local cache.
 *
 * `models: null` means PortOS could not read the cache at all (no binary, the
 * command failed, unparseable output) — deliberately NOT the same value as
 * `models: []`, which means the cache was read and is empty. The caller starts
 * MTPLX with its own default in the first case and refuses in the second; a
 * shared falsy value would make an unreadable cache look like an empty one and
 * block a start that would have worked.
 *
 * @param {{command?: string}} [options]
 * @returns {Promise<{models: object[]|null, error: string|null}>}
 */
export async function listMtplxCachedModels({ command = 'mtplx' } = {}) {
  const binary = findCommandOnPath(command);
  if (!binary) return { models: null, error: `\`${command}\` is not on PortOS's PATH` };

  const result = await bufferedSpawn(binary, ['models', '--json'], { timeoutMs: CACHE_QUERY_TIMEOUT_MS, shell: false });
  if (result.timedOut) return { models: null, error: `\`${command} models\` timed out` };
  if (!result.success) {
    // A spawn failure (EACCES, ENOENT on a dangling symlink) reports nothing on
    // either stream — its reason lives on `error`, and dropping it would leave
    // the user with a bare exit code for a fixable permissions problem.
    const detail = result.error?.message || String(result.stderr || result.stdout || '').trim().split(/\r?\n/).pop();
    return { models: null, error: detail || `\`${command} models\` exited with code ${result.code}` };
  }

  // Parse from the first brace: MTPLX writes the JSON alone today, but a banner
  // line ahead of it must not read as "nothing is cached".
  const text = String(result.stdout || '');
  const start = text.indexOf('{');
  const parsed = start === -1 ? null : safeJSONParse(text.slice(start), null, { allowArray: false });
  if (!Array.isArray(parsed?.models)) {
    return { models: null, error: `\`${command} models --json\` did not return a model list` };
  }
  return { models: parsed.models, error: null };
}

/**
 * The cached repo id PortOS should hand `mtplx serve --model`, or null when the
 * cache holds nothing servable.
 *
 * Only entries MTPLX itself calls complete are eligible: `validation.ok` is
 * false for a directory missing required files or an MTP sidecar, which is what
 * an interrupted `mtplx pull` leaves behind — starting the server on one of
 * those trades an honest "nothing is cached" for a load failure minutes later.
 * Among complete entries, one carrying `mtplx_runtime.json` wins: that is the
 * recorded exactness contract, and the runtime warns on stats from artifacts
 * without it.
 *
 * @param {object[]|null|undefined} models - rows from `listMtplxCachedModels`
 * @returns {string|null}
 */
export function pickMtplxCachedModel(models) {
  if (!Array.isArray(models)) return null;
  const usable = models.filter((row) => typeof row?.repo_id === 'string' && row.repo_id !== '' && row?.validation?.ok !== false);
  const verified = usable.find((row) => row.has_runtime_contract === true);
  return (verified || usable[0])?.repo_id ?? null;
}
