import { existsSync } from 'fs';
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';
import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';
import { parseCommandArgs, validateCommand } from '../lib/commandSecurity.js';
import { PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { executeUpdate } from './updateExecutor.js';
import { syncManagedAppFork } from './managedAppRepositories.js';

const CMD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a command in `cwd`, throwing on timeout, spawn error, or non-zero exit.
 * Thin wrapper over the shared `bufferedSpawnOrThrow` adapter.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runCommand(cmd, args, cwd) {
  return bufferedSpawnOrThrow(cmd, args, { cwd, timeoutMs: CMD_TIMEOUT_MS });
}

// Per-app lock to prevent concurrent updates
const updatingApps = new Set();

/**
 * Run a full update cycle for an app:
 * 1. switch to origin's default branch and fast-forward it
 * 2. run an explicitly declared app update routine, when one exists
 * 3. restart the app's PM2 processes
 *
 * A generic managed app must opt in to dependency installs, migrations, or a
 * build: guessing those steps from a package.json can freeze or break apps
 * whose lifecycle does not resemble PortOS.
 *
 * PortOS itself is a managed app, and its comprehensive update.sh/update.ps1
 * lifecycle is delegated to `updateExecutor` — which also owns the restart and
 * the dashboard handoff for that case. See the app-update step in `_doUpdate`.
 *
 * @param {object} app - The app object (must have repoPath, pm2ProcessNames, pm2Home)
 * @param {function} emit - Callback (step, status, message) for progress updates
 * @param {{syncFork?: boolean}} options
 * @returns {Promise<{success: boolean, steps: object[]}>}
 */
export async function updateApp(app, emit, { syncFork = false } = {}) {
  const dir = app.repoPath;
  if (updatingApps.has(dir)) {
    return { success: false, steps: [{ step: 'lock', success: false, message: 'Update already in progress' }] };
  }
  updatingApps.add(dir);

  try {
    return await _doUpdate(app, emit, { syncFork });
  } finally {
    updatingApps.delete(dir);
  }
}

async function _doUpdate(app, emit, { syncFork }) {
  const dir = app.repoPath;
  const steps = [];
  const packageManager = app.type === 'bun' ? 'bun' : 'npm';
  const configuredRuntime = parseCommandArgs(app.startCommands?.[0] || '')[0];
  const packageManagerCommand = packageManager === 'bun' && configuredRuntime
    ? configuredRuntime
    : packageManager;

  if (syncFork) {
    emit('git-sync-fork', 'running', 'Syncing the origin fork from canonical upstream...');
    const sync = await syncManagedAppFork(app);
    const syncMessage = sync.alreadyUpToDate
      ? `${sync.fullName} is already current`
      : `Synced ${sync.fullName} from ${sync.source}`;
    emit('git-sync-fork', 'done', syncMessage);
    steps.push({ step: 'git-sync-fork', success: true, message: syncMessage });
  }

  emit('git-pull', 'running', 'Updating from origin default branch...');
  const pullResult = await gitService.updateDefaultBranch(dir);
  const pullMsg = pullResult.output?.trim() || `${pullResult.branch} is up to date`;
  emit('git-pull', 'done', pullMsg);
  steps.push({ step: 'git-pull', success: true, message: pullMsg });

  const companionRepoPaths = Array.isArray(app.companionRepoPaths)
    ? [...new Set(app.companionRepoPaths)].filter((path) => path && path !== dir)
    : [];
  for (let index = 0; index < companionRepoPaths.length; index += 1) {
    const companionPath = companionRepoPaths[index];
    const stepId = `git-pull:companion-${index + 1}`;
    emit(stepId, 'running', `Pulling companion repository ${index + 1}/${companionRepoPaths.length}...`);
    const companionPull = await gitService.updateDefaultBranch(companionPath);
    const companionMessage = companionPull.output?.trim() || `${companionPull.branch} is up to date`;
    emit(stepId, 'done', companionMessage);
    steps.push({ step: stepId, success: true, message: companionMessage });
  }

  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(await readFile(pkgPath, 'utf-8')) : null;
  const configuredUpdate = typeof app.updateCommand === 'string' ? app.updateCommand.trim() : '';
  const standardScript = process.platform === 'win32' ? 'update.ps1' : 'update.sh';
  const standardScriptPath = join(dir, standardScript);
  const usesStandardScript = !configuredUpdate && !pkg?.scripts?.['portos:update'] && existsSync(standardScriptPath);
  // PortOS running THIS checkout's own standard update script is the one case
  // whose update routine deletes the process awaiting it — and the only shape
  // updateExecutor knows how to launch, since it resolves update.sh from
  // `PATHS.root` rather than from the app record. Both narrowings matter: a
  // PortOS record carrying a custom `updateCommand`, or pointing somewhere
  // other than this checkout, keeps the ordinary attached path rather than
  // silently running a different script than the one configured.
  const detachSelfUpdate = app.id === PORTOS_APP_ID && usesStandardScript && dir === PATHS.root;
  if (configuredUpdate || pkg?.scripts?.['portos:update'] || usesStandardScript) {
    // A configured runtime may be an absolute Bun path, which is trusted app
    // configuration but not a commandSecurity allowlist token. Only free-form
    // registry commands go through that parser; the package-script form is a
    // fixed argument list selected by PortOS.
    const command = configuredUpdate
      ? validateCommand(configuredUpdate)
      : pkg?.scripts?.['portos:update']
        ? { valid: true, baseCommand: packageManagerCommand, args: ['run', 'portos:update'] }
        : process.platform === 'win32'
          ? { valid: true, baseCommand: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', standardScriptPath] }
          : { valid: true, baseCommand: standardScriptPath, args: [] };
    if (!command.valid) throw new Error(`Update command is not allowed: ${command.error}`);
    emit('app-update', 'running', 'Running the app update routine...');
    if (detachSelfUpdate) {
      // PortOS is itself a managed app, so an App Management update reaches
      // update.sh through THIS path — and the script's own
      // `pm2 delete ecosystem.config.cjs` step tree-kills portos-server.
      // PM2 walks PPID, so an attached spawn dies with the server it just
      // deleted, taking the in-flight `pm2 delete` with it and never reaching
      // the closing `pm2 start`: the install is left headless, with only the
      // entries declared after portos-cos still online (#5976).
      //
      // updateExecutor already owns the double-fork launch that survives that,
      // plus the STEP: progress parsing that maps straight onto this emit
      // contract, the still-running-script guard and recordUpdateResult — so
      // delegate rather than keeping a second detached-spawn implementation
      // in sync here. The version is only a logging/fallback label; the true
      // post-update version comes from the script's completion marker.
      const version = typeof pkg?.version === 'string' ? pkg.version : 'unknown';
      const outcome = await executeUpdate(version, emit);
      if (!outcome.success) {
        throw new Error(outcome.errorMessage || `PortOS update failed at step "${outcome.failedStep || 'unknown'}"`);
      }
    } else {
      await runCommand(command.baseCommand, command.args, dir);
    }
    emit('app-update', 'done', 'App update routine complete');
    steps.push({ step: 'app-update', success: true });
  }

  // update.sh/update.ps1 close with their own `pm2 start ecosystem.config.cjs`
  // (and their own dashboard handoff), so restarting PortOS on top of the
  // detached script would be redundant and would race it — the script may not
  // have finished re-registering the processes we would be restarting.
  const processNames = detachSelfUpdate ? [] : (app.pm2ProcessNames || []);
  if (processNames.length > 0) {
    emit('restart', 'running', 'Restarting app...');
    const restartResults = await Promise.all(
      processNames.map(name =>
        pm2Service.restartApp(name, app.pm2Home).then(() => null, e => e)
      )
    );
    const failures = processNames.filter((_, i) => restartResults[i]);
    if (failures.length > 0) {
      const msg = `${processNames.length - failures.length}/${processNames.length} restarted (failed: ${failures.join(', ')})`;
      emit('restart', 'warning', msg);
      steps.push({ step: 'restart', success: true, warning: msg });
    } else {
      emit('restart', 'done', `Restarted ${processNames.length} process(es)`);
      steps.push({ step: 'restart', success: true });
    }
  }

  return { success: true, steps };
}
