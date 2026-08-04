/**
 * Single source of truth for the packages allowed to run install scripts.
 *
 * Every workspace pins `ignore-scripts=true` in its own .npmrc (npm reads the
 * project config from the local prefix and never walks upward, so each
 * workspace needs its own file — see client/.npmrc). That blocks the
 * preinstall/postinstall hook that supply-chain worms use as their execution
 * slot, at the cost of also skipping the handful of *legitimate* native builds.
 * Those are rebuilt explicitly here — an allowlist, so adding a dependency
 * never silently grants it an install-time code-execution slot.
 *
 * Consumed by scripts/ensure-deps.js, the root `setup` script, and CI. Keep the
 * list here only — a second copy in a workflow file is how it drifts.
 *
 * Usage as a CLI (what CI and `npm run setup` call):
 *   node scripts/trusted-rebuilds.js server
 */
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * `fatal: true` means a failed rebuild fails the install — the package is
 * required at runtime and a missing binding crashes the server. `fatal: false`
 * is best-effort: the dependency degrades rather than breaks.
 *
 * client / autofixer are intentionally absent: nothing in either needs an
 * install script (vite 8 dropped the esbuild binary dependency that used to).
 */
export const TRUSTED_REBUILDS = {
  server: [
    // Builds the native PTY addon. The shell/TUI features hard-require it.
    { pkgs: ['node-pty'], fatal: true },
    // Retained as insurance: sharp ships prebuilt bindings via
    // optionalDependencies today (no lifecycle hook), so this is currently a
    // no-op — but it is runtime-critical if it ever regains one.
    { pkgs: ['sharp'], fatal: true },
    // Transitive, behind optional local-inference features. Its postinstall
    // fetches platform binaries; absent them the feature is unavailable, not
    // fatal. protobufjs's postinstall only generates a minimal build.
    { pkgs: ['onnxruntime-node', 'protobufjs'], fatal: false }
  ]
};

/**
 * Rebuild the trusted packages for one workspace.
 * Returns true when every fatal group succeeded.
 */
export function rebuildTrusted(dir, label) {
  const groups = TRUSTED_REBUILDS[label];
  if (!groups) return true;
  let ok = true;
  for (const { pkgs, fatal } of groups) {
    try {
      execFileSync(NPM, ['rebuild', ...pkgs], { cwd: dir, stdio: 'inherit', windowsHide: true });
    } catch (err) {
      console.error(`⚠️  npm rebuild ${pkgs.join(' ')} failed for ${label}: ${err.message ?? err}`);
      if (fatal) ok = false;
    }
  }
  return ok;
}

// CLI entry: `node scripts/trusted-rebuilds.js <label> [dir]`
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const label = process.argv[2];
  if (!label) {
    console.error(`❌ usage: node scripts/trusted-rebuilds.js <${Object.keys(TRUSTED_REBUILDS).join('|')}>`);
    process.exit(1);
  }
  const dir = process.argv[3] ?? (label === 'root' ? ROOT : join(ROOT, label));
  if (!TRUSTED_REBUILDS[label]) {
    console.log(`✅ no trusted rebuilds needed for ${label}`);
    process.exit(0);
  }
  console.log(`🔨 Rebuilding trusted install-script packages for ${label}`);
  process.exit(rebuildTrusted(dir, label) ? 0 : 1);
}
