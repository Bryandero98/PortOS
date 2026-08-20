/**
 * Pick the shell binary a PTY session (the Shell page, agent TUI shells) runs.
 *
 * THE PROBLEM (Windows). The default used to be `COMSPEC`, i.e. `cmd.exe`, and
 * `cmd.exe` cannot get you onto another drive by any command a user would
 * reasonably type:
 *
 *   cd I:                     → PRINTS `I:\` and stays put. `cd` without `/d`
 *                               reports the working dir *of* that drive rather
 *                               than switching to it — silent, no error.
 *   I:\  /  I:/               → "is not recognized as an internal or external
 *                               command" (a bare drive letter is a command, not
 *                               a `cd`; only `I:` alone works, and even that
 *                               only changes the drive, not the directory).
 *   cd 'I:\path\to\repo'      → "The filename, directory name, or volume label
 *                               syntax is incorrect" — cmd has no single-quote
 *                               quoting, so the quotes become part of the path.
 *
 * Only `cd /d "I:\path"` works, which is why `buildCdCommand` (lib/shellCd.js)
 * emits that form for the "cd to app" picker. But that fixes only the commands
 * PortOS sends — anything the user types by hand still fails, and a Windows
 * install whose repos live on a second drive is then stuck on `C:`.
 *
 * PowerShell has none of these problems: `cd I:`, `cd I:\path`, `cd 'I:\path'`
 * and `Set-Location` all cross drives, and it accepts both quote styles. So on
 * Windows we prefer PowerShell and keep `cmd.exe` only as a last resort.
 *
 * Resolution order (Windows):
 *   1. PORTOS_SHELL override — explicit escape hatch, always wins.
 *   2. PowerShell 7+ (`pwsh.exe`) at its versioned install dirs, newest major.
 *   3. Any other `pwsh.exe` on PATH — scoop, chocolatey, a custom prefix, or
 *      the winget/Store launcher shim under `WindowsApps`.
 *   4. Windows PowerShell 5.1 (`powershell.exe`) — ships with Windows, so this
 *      is the realistic floor; it crosses drives too, it just loads the user's
 *      profile (slower start) and is stuck on the older engine.
 *   5. `COMSPEC` / `cmd.exe` — only if no PowerShell exists at all.
 *
 * On POSIX the choice was never broken: PORTOS_SHELL, else `SHELL`, else zsh.
 */

import { existsSync, readdirSync } from 'fs';
import { win32 } from 'path';
import { findCommandOnPath } from './processEnv.js';

// The Windows branch below assembles WINDOWS paths, so it joins with win32
// semantics rather than the host's. On Windows the two are identical; off it,
// the platform `join` would splice Windows path fragments with `/` and produce
// `C:\Program Files/PowerShell/7/pwsh.exe` — which never matches a real path and
// makes the win32 branch untestable from a POSIX host, the exact thing the
// injectable `platform` exists to allow. Same reasoning as `win32.basename` in
// shellCd.js.
const { join } = win32;

/**
 * `%ProgramFiles%\PowerShell\<major>\pwsh.exe` for every installed major
 * version, newest first. Enumerated rather than hard-coding `7` so a future
 * PowerShell 8 is picked up without a code change, and so a box with both 7 and
 * 8 gets the newer one.
 */
function pwshCandidatePaths(env, readdir) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const base = join(root, 'PowerShell');
    let entries;
    // readdirSync throws when PowerShell 7+ was never installed — the common
    // case on a stock Windows box, not an error worth surfacing.
    try {
      entries = readdir(base);
    } catch {
      continue;
    }
    // Numeric sort, not lexical: '10' must outrank '7'.
    const majors = entries
      .filter(name => /^\d+$/.test(name))
      .sort((a, b) => Number(b) - Number(a));
    for (const major of majors) found.push(join(base, major, 'pwsh.exe'));
  }
  return found;
}

// Probed in order and short-circuited, so the PATH scan only runs on a box with
// no versioned PowerShell 7 install.
function resolveWindowsShell(env, exists, readdir, findOnPath) {
  const versioned = pwshCandidatePaths(env, readdir).find(exists);
  if (versioned) return versioned;

  // Covers every non-standard pwsh install — scoop, chocolatey, a custom
  // prefix, and the winget/Store launcher shim under WindowsApps — rather than
  // hard-coding one more directory per packaging tool.
  const onPath = findOnPath('pwsh.exe', { env });
  if (onPath) return onPath;

  // Windows PowerShell 5.1 — present on every supported Windows.
  const ps5 = join(
    env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  if (exists(ps5)) return ps5;

  return env.COMSPEC || 'cmd.exe';
}

/**
 * Resolve the shell without consulting (or populating) the memo. Exported for
 * tests, which need to drive the Windows branch from a POSIX host.
 *
 * @param {object} [deps]
 * @param {string} [deps.platform] - `process.platform` value
 * @param {NodeJS.ProcessEnv} [deps.env] - environment to read
 * @param {(path: string) => boolean} [deps.exists] - filesystem probe
 * @param {(dir: string) => string[]} [deps.readdir] - directory listing; may throw
 * @param {(name: string, opts: object) => string|null} [deps.findOnPath] - PATH lookup
 * @returns {string} shell binary path (or bare name, on POSIX)
 */
export function resolveInteractiveShellWith({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readdir = readdirSync,
  findOnPath = findCommandOnPath,
} = {}) {
  // The override wins on every platform, but only if it actually resolves — a
  // stale path in `.env` must not strand every session on a shell that cannot
  // spawn. Bare names (`fish`, `pwsh`) are passed through unchecked and left to
  // PATH, since `exists` can't see them.
  const override = (env.PORTOS_SHELL || '').trim();
  if (override) {
    if (!/[\\/]/.test(override) || exists(override)) return override;
    // Silently auto-detecting past a typo'd override leaves the user with no
    // signal at all about why their setting had no effect.
    console.warn(`🐚 PORTOS_SHELL='${override}' does not exist — auto-detecting instead`);
  }

  if (platform !== 'win32') return env.SHELL || '/bin/zsh';
  return resolveWindowsShell(env, exists, readdir, findOnPath);
}

let cached;

/**
 * Resolve the interactive shell. Memoized after the first call — the answer is
 * a property of the machine, and every new PTY session would otherwise re-probe
 * the filesystem. Which binary a session actually got is logged by
 * `createShellSession`, per session.
 *
 * @returns {string} shell binary path (or bare name, on POSIX)
 */
export function resolveInteractiveShell() {
  if (cached === undefined) cached = resolveInteractiveShellWith();
  return cached;
}
