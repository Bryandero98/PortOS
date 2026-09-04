import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { spawnDetached, isDetachedRunning } from '../lib/detachedSpawn.js';
import { recordUpdateResult, getCurrentVersion } from './updateChecker.js';

const UPDATE_SH = join(PATHS.root, 'update.sh');
const UPDATE_PS1 = join(PATHS.root, 'update.ps1');

/**
 * Execute the PortOS update script (git pull to latest).
 *
 * The script is launched via spawnDetached so it SURVIVES pm2's TreeKill. A
 * plain `spawn(..., { detached: true })` does NOT survive: on POSIX, pm2
 * walks PPID (`ps -e -o pid=,ppid=`), not the process group, so when
 * update.sh reaches its `pm2-stop` step (`pm2 delete ecosystem.config.cjs`)
 * the script itself — still a PPID-child of portos-server — was tree-killed
 * with the server, leaving every app stopped with nothing alive to run the
 * final `pm2 start` (the reconcile/update "shuts down but never comes back"
 * failure). See the rationale in `server/lib/detachedSpawn.js`.
 *
 * On Windows, `spawn(..., { detached: true })` is worse than merely
 * non-surviving: `detached: true` there maps to DETACHED_PROCESS, which
 * gives `powershell.exe` no console — a console-less powershell.exe exits in
 * ~100ms without running a single line of update.ps1, so the update never
 * actually ran at all despite reporting success (issue #6169). `spawnDetached`'s
 * `windowsDetached: true` opt-in launches a two-hop PowerShell supervisor
 * instead (`server/lib/windowsDetachedLauncher.ps1`) that gives pm2's later
 * `taskkill /T /F` nothing to find, matching the POSIX double-fork's survival
 * guarantee.
 *
 * The scripts pull the latest code via `git pull --rebase --autostash` and
 * write the actual resulting version to `data/update-complete.json`.
 * The `tag` parameter is used only for logging and the initial API response;
 * the true post-update version is determined by the script from package.json,
 * falling back to a fresh on-disk package.json read (never the triggering
 * tag) if the completion marker was never written — e.g. a launch that never
 * ran at all still exits 0 on some interpreters, and the tag is only ever a
 * request, not proof of what actually landed.
 *
 * @param {string} tag - The release tag that triggered the update (for logging)
 * @param {function} emit - Callback (step, status, message) for progress
 * @param {object} [options]
 * @param {string[]} [options.forceCleanWorkspaces] - workspaces to reinstall from scratch
 * @param {function} [options.onLaunched] - called once the script is spawned, before
 *   the returned promise starts tracking its lifetime
 * @returns {Promise<{success: boolean, version?: string, failedStep?: string, errorMessage?: string}>}
 */
// Workspaces update.sh / update.ps1 know how to clean-reinstall — the env
// passthrough is allowlisted to these so nothing arbitrary reaches the scripts.
const CLEANABLE_WORKSPACES = new Set(['.', 'client', 'server', 'autofixer']);

export async function executeUpdate(tag, emit, { forceCleanWorkspaces, onLaunched } = {}) {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'powershell' : 'bash';
  const args = isWindows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1]
    : [UPDATE_SH];

  emit('starting', 'running', `Starting update (target: ${tag})...`);

  // For a reconcile (issue #1779), a bare `git pull` left stale node_modules
  // even though HEAD already advanced — so the scripts' commit-diff dependency
  // detection finds nothing to reinstall. Pass the workspaces whose deps are
  // actually stale (per installState's receipt check) so update.sh/update.ps1
  // force a from-scratch reinstall of exactly those, regardless of the diff.
  const cleanList = Array.isArray(forceCleanWorkspaces)
    ? forceCleanWorkspaces.filter(w => CLEANABLE_WORKSPACES.has(w))
    : [];
  const childEnv = { ...process.env };
  if (cleanList.length) {
    childEnv.PORTOS_FORCE_CLEAN_WORKSPACES = cleanList.join(',');
  } else {
    delete childEnv.PORTOS_FORCE_CLEAN_WORKSPACES;
  }

  // spawnDetached survives the pm2 TreeKill its own `pm2 delete`/`pm2 start`
  // steps trigger — the POSIX double-fork on Linux/macOS, the two-hop
  // PowerShell launcher (windowsDetached: true, below) on Windows. The
  // returned handle is ChildProcess-like (stdout/stderr 'data', 'close',
  // 'error'), streamed by tailing the control dir's log files — so the STEP:
  // progress parsing below works unchanged on both platforms. The control
  // dir is reused across updates (spawnDetached truncates stale files) and
  // kept afterward as the post-mortem record of the launch.
  const controlDir = join(PATHS.data, 'update-detached');

  // Refuse to reuse the control dir while a prior update script is still
  // running (survival path: the old script outlives the server restart it
  // triggers, and its supervisor's late `exit` write into a truncated control
  // dir would prematurely close the new handle with the OLD script's status).
  // A still-running script also means a second update is wrong regardless.
  // Windows now has the same survival guarantee via windowsDetached (below),
  // so this guard applies on both platforms.
  if (await isDetachedRunning(controlDir, { executable: cmd, args })) {
    const errorMessage = 'A previous update script is still running — wait for it to finish before starting another update';
    await recordUpdateResult({
      version: tag.replace(/^v/, ''),
      success: false,
      completedAt: new Date().toISOString(),
      log: errorMessage
    }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
    emit('starting', 'error', errorMessage);
    return { success: false, failedStep: 'starting', errorMessage };
  }

  const child = await spawnDetached(cmd, args, {
    cwd: PATHS.root,
    env: childEnv,
    controlDir,
    windowsDetached: isWindows,
  });

  // The script is running from here on. Everything ABOVE can still refuse (a
  // prior update script is still alive) or throw (spawn error); nothing below
  // can — the returned promise then tracks the script's whole lifetime. A
  // caller that must tell "the launch failed" from "the update failed" waits on
  // this signal rather than on the promise. See `portosSelfUpdate`'s launch gate.
  onLaunched?.();

  return new Promise((resolve) => {
    let lastStep = 'starting';
    // Both scripts emit their first real STEP: line (git-pull:running) before
    // touching anything, so a clean exit that never emitted ANY step line
    // means the script never actually ran — a launch failure masquerading as
    // success (issue #6169: a console-less Windows spawn used to do exactly
    // this). Tracked separately from `lastStep`, which starts at 'starting'
    // and would otherwise make that indistinguishable from real progress.
    let sawAnyStep = false;
    // The synthetic 'starting' step (emitted once below, before the script
    // has even been spawned) has no natural close-out once real STEP: lines
    // begin arriving under a DIFFERENT step name — left alone, the client's
    // per-step list shows it spinning for the whole update. Close it out the
    // moment the first real step lands.
    let startingClosed = false;

    // Parse STEP:name:status:message lines from stdout/stderr streams
    const makeLineHandler = () => {
      let buffer = '';
      return (data) => {
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);
          const match = line.match(/STEP:([^:]+):([^:]+):(.+)/);
          if (match) {
            const [, name, status, message] = match;
            sawAnyStep = true;
            if (!startingClosed && name !== 'starting') {
              startingClosed = true;
              emit('starting', 'done', 'Starting update...');
            }
            lastStep = name;
            emit(name, status, message);
          }
        }
      };
    };

    // Pipe stdout/stderr for progress tracking, with EPIPE guards
    // in case the parent process exits before the detached child finishes writing
    if (child.stdout) {
      child.stdout.on('error', (err) => { if (err.code !== 'EPIPE') console.error(`⚠️ stdout stream error: ${err.message}`); });
      child.stdout.on('data', makeLineHandler());
    }
    if (child.stderr) {
      child.stderr.on('error', (err) => { if (err.code !== 'EPIPE') console.error(`⚠️ stderr stream error: ${err.message}`); });
      child.stderr.on('data', makeLineHandler());
    }

    child.on('close', async (code, signal) => {
      // A clean exit with no STEP: line ever seen means the script never
      // actually ran (see the `sawAnyStep` comment above) — treat it as a
      // failure even though the process itself exited 0.
      const ranAtAll = sawAnyStep;
      const success = code === 0 && ranAtAll;
      const exitDetail = signal ? `killed by ${signal}` : `exit code ${code}`;
      const failureLog = (code === 0 && !ranAtAll)
        ? 'Update script exited cleanly without reporting any progress — it likely never ran'
        : `Process ${exitDetail}`;
      // Record result for both success and failure so updateInProgress gets
      // cleared even if PM2 restart doesn't kill this process.
      if (!success) {
        await recordUpdateResult({
          version: tag.replace(/^v/, ''),
          success: false,
          completedAt: new Date().toISOString(),
          log: failureLog
        }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      }
      if (success) {
        // Read the actual version from the completion marker written by the
        // script. Always record a success result so updateInProgress gets
        // cleared even if PM2 restart doesn't kill this process. Falls back
        // to a fresh on-disk package.json read when the marker isn't
        // readable yet — never the triggering tag, which is only ever a
        // request, not proof of what the script actually landed on.
        let actualVersion = null;
        let completedAt = new Date().toISOString();
        const markerPath = join(PATHS.data, 'update-complete.json');
        try {
          const marker = JSON.parse(await readFile(markerPath, 'utf-8'));
          actualVersion = marker.version || null;
          completedAt = marker.completedAt || completedAt;
        } catch { /* marker may not be readable yet — fall back below */ }
        if (!actualVersion) actualVersion = await getCurrentVersion();
        let recorded = false;
        try {
          await recordUpdateResult({
            version: actualVersion,
            success: true,
            completedAt,
            log: ''
          });
          recorded = true;
        } catch (e) {
          console.error(`❌ Failed to record update result: ${e.message}`);
        }
        // Remove marker only after result is persisted so boot-time processing
        // can still recover if this process is killed before recordUpdateResult
        if (recorded) {
          await unlink(markerPath).catch(() => {});
        }
        emit('complete', 'done', 'Update complete — restarting');
        resolve({ success: true, version: actualVersion });
      } else {
        const errorMessage = ranAtAll
          ? `Update failed at step "${lastStep}" (${exitDetail})`
          : failureLog;
        emit(lastStep, 'error', errorMessage);
        resolve({ success: false, failedStep: lastStep, errorMessage });
      }
    });

    child.on('error', async (err) => {
      await recordUpdateResult({
        version: tag.replace(/^v/, ''),
        success: false,
        completedAt: new Date().toISOString(),
        log: err.message
      }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      const errorMessage = `Failed to start update: ${err.message}`;
      emit('starting', 'error', errorMessage);
      resolve({ success: false, failedStep: 'starting', errorMessage });
    });
  });
}
