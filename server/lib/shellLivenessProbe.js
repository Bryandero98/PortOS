/**
 * Build and run the process-liveness probe for a launched TUI command in a PTY
 * session.
 *
 * The TUI runs as a CHILD of a persistent PTY shell (e.g. `claude` spawned inside
 * `zsh` or `cmd.exe`). When that command exits early during startup (bad config,
 * command not found, auth error), the PTY itself stays open — the shell returns to
 * its prompt, and onExit never fires.
 *
 * "The shell PID has no live child process" means the launched command has
 * already died. In that case, the spawner skips pasting the prompt into the bare
 * shell prompt and finalizes failure early.
 *
 * The probe is executed host-side via `execFile` from Node.js (not inside the PTY):
 *   • POSIX host (macOS / Linux): `ps -Ao ppid=` (lists parent PIDs)
 *   • Windows host: `powershell -NoProfile -NonInteractive -Command ...`
 *     using `Get-CimInstance Win32_Process` filtered by ParentProcessId.
 *
 * Resolves true (assume alive) if the probe fails or cannot run, so an environment
 * glitch never blocks an otherwise-healthy run.
 */

import { execFile } from './childProcess.js';

/**
 * Build the file + argv for probing children of `shellPid`.
 *
 * @param {number} shellPid - PID of the hosting shell process
 * @param {string} [platform=process.platform] - OS platform
 * @returns {{ file: string, args: string[] }}
 */
export function buildLivenessProbeCommand(shellPid, platform = process.platform) {
  if (platform === 'win32') {
    return {
      file: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${shellPid}" | Select-Object -ExpandProperty ProcessId`,
      ],
    };
  }
  return {
    file: 'ps',
    args: ['-Ao', 'ppid='],
  };
}

/**
 * Parse the output of the liveness probe.
 *
 * @param {string} stdout - raw stdout from the probe command
 * @param {number} shellPid - PID of the hosting shell process
 * @param {string} [platform=process.platform] - OS platform
 * @returns {boolean} true if child process(es) were found
 */
export function parseLivenessProbeOutput(stdout, shellPid, platform = process.platform) {
  if (!stdout) return false;
  if (platform === 'win32') {
    return String(stdout)
      .split('\n')
      .some((line) => {
        const num = parseInt(line.trim(), 10);
        return Number.isFinite(num) && num > 0;
      });
  }
  return String(stdout)
    .split('\n')
    .some((line) => {
      const num = parseInt(line.trim(), 10);
      return Number.isFinite(num) && num === shellPid;
    });
}

/**
 * Best-effort check if `shellPid` currently has any live child process.
 * Resolves `true` (assume alive) on error or missing PID.
 *
 * @param {number} shellPid
 * @param {{ platform?: string, execFileFn?: typeof execFile }} [options]
 * @returns {Promise<boolean>}
 */
export function shellHasLiveChild(shellPid, { platform = process.platform, execFileFn = execFile } = {}) {
  if (!shellPid) return Promise.resolve(true);
  const { file, args } = buildLivenessProbeCommand(shellPid, platform);
  return new Promise((resolve) => {
    execFileFn(file, args, { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve(true);
        return;
      }
      resolve(parseLivenessProbeOutput(stdout, shellPid, platform));
    });
  });
}
