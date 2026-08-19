import { execFile } from './childProcess.js';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Does running `cmd args` succeed without error? A capability probe (not a
 * PATH lookup like `whichFirst` in processEnv.js) — it actually invokes the
 * command, so it also catches a binary that's on PATH but broken. Bounded by
 * `timeoutMs` so a hung/interactive command can't stall the caller. Default
 * 5s suits the lightweight system tools this was extracted from (`brew`,
 * `systemctl`, `ollama`); a heavier agentic CLI (`codex`, `grok`, `agy`) needs
 * the caller to pass a longer bound — `imageGen/{grok,agy,codex}.js`'s own
 * `checkConnection()` probes use 15s for exactly these binaries. Consolidates
 * two previously-private copies (localLlm.js, ollamaManager.js — see #3606).
 *
 * @param {string} cmd
 * @param {string[]} [args] - defaults to `['--version']`, the common probe
 * @param {{timeoutMs?: number, env?: object, cwd?: string}} [opts]
 * @returns {Promise<boolean>}
 */
export async function commandExists(cmd, args = ['--version'], { timeoutMs = 5_000, env, cwd } = {}) {
  const options = {
    timeout: timeoutMs,
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
  };
  // Some spawn failures (notably ENOEXEC for a broken text shim on macOS)
  // are thrown synchronously by the child-process wrapper before it can
  // return a promise. Start the call in a microtask so those failures follow
  // the same false result as an ordinary rejected execFile promise.
  return Promise.resolve()
    .then(() => execFileAsync(cmd, args, options))
    .then(() => true)
    .catch(() => false);
}
