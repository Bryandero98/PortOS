/**
 * Run one command to completion, streaming its stdout/stderr LINES to a hook.
 *
 * The install/setup flows (`services/localLlm.js`'s package-manager installs,
 * `services/localRuntimeSetup.js`'s one-click daemon setup) all need the same
 * thing: spawn a package manager, forward every line it prints to an SSE frame,
 * and end up with an actionable `{ success, error }` — where a non-zero exit
 * carries the TAIL of what the tool actually said, because `brew upgrade ollama`
 * exiting 1 with stderr "Error: ollama not installed" must surface that string
 * rather than "exited with code 1".
 *
 * Deliberately never rejects: every failure (spawn error, non-zero exit,
 * timeout) resolves as `{ success: false, error }`. These run outside the
 * Express request lifecycle — from a child-process callback there is no
 * `next(err)` to bubble to — so the caller gets a value to report, and the
 * `onLine` hook is itself guarded for the same reason.
 *
 * `bufferedSpawn.js` is the sibling for the other shape: run a command and get
 * its whole output at the end. Use this one when live output IS the progress.
 */

import { spawn } from './childProcess.js';
import { safeChildProcessEnv, safeChildProcessOptions } from './processEnv.js';

/** Char budget for the recent-output tail attached to a failure message. */
const TAIL_BUDGET = 1024;

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {(line: string) => void} [onLine] - called once per non-empty line
 * @param {{timeoutMs?: number, cwd?: string, env?: object, spawnImpl?: Function}} [options]
 *   `timeoutMs: 0` (default) means no timeout.
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export function runStreamingCommand(cmd, args, onLine, { timeoutMs = 0, cwd, env, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    const child = spawnImpl(cmd, args, safeChildProcessOptions({
      env: env ? safeChildProcessEnv(env) : process.env,
      ...(cwd ? { cwd } : {}),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

    let buffer = '';
    let settled = false;
    const tail = []; // recent non-empty lines, capped by char budget for the error message
    let tailChars = 0;

    const rememberLine = (line) => {
      tail.push(line);
      tailChars += line.length + 1;
      while (tailChars > TAIL_BUDGET && tail.length > 1) {
        tailChars -= tail.shift().length + 1;
      }
    };

    const safeLine = (line) => {
      if (!line) return;
      rememberLine(line);
      if (typeof onLine !== 'function') return;
      try { onLine(line); } catch (err) { console.error(`⚠️ streaming output hook failed: ${err.message}`); }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        child.kill('SIGKILL');
        finish({ success: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs)
      : null;

    const onData = (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        safeLine(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => finish({ success: false, error: err.message }));
    // 'close' rather than 'exit': 'exit' can fire with stdio still buffered,
    // which would drop the very lines the failure message needs.
    child.on('close', (code) => {
      safeLine(buffer.trim());
      if (code === 0) return finish({ success: true });
      const detail = tail.join(' — ').trim();
      finish({ success: false, error: detail ? `exit ${code}: ${detail}` : `exited with code ${code}` });
    });
  });
}
