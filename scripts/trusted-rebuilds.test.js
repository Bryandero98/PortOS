import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { TRUSTED_REBUILDS } from './trusted-rebuilds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every workspace that npm can install into with that workspace as the *local
// prefix*. npm resolves the project .npmrc from the local prefix and never walks
// up the tree, so each of these needs its own file — the repo-root .npmrc does
// NOT cover `cd client && npm install` or `npm ci --prefix client` (what CI
// runs). A missing file silently re-grants every dependency in that workspace an
// install-time code-execution slot, which is exactly the hole a preinstall-hook
// worm (the Aug 2026 keyv/cacheable compromise) walks through.
const WORKSPACES = ['.', 'client', 'server', 'autofixer'];

const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall'];

/** Packages in a workspace's installed tree that declare a lifecycle install hook. */
function packagesWithInstallHooks(workspace) {
  const modulesDir = join(ROOT, workspace, 'node_modules');
  if (!existsSync(modulesDir)) return null;
  const found = new Set();
  const scanDir = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Recurse one level into scopes (@scope/pkg) only.
      if (entry.name.startsWith('@')) {
        scanDir(join(dir, entry.name));
        continue;
      }
      const manifest = join(dir, entry.name, 'package.json');
      if (!existsSync(manifest)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      } catch {
        continue;
      }
      if (LIFECYCLE_HOOKS.some((hook) => pkg?.scripts?.[hook])) {
        found.add(pkg.name ?? entry.name);
      }
    }
  };
  scanDir(modulesDir);
  return found;
}

describe('ignore-scripts guard', () => {
  it.each(WORKSPACES)('%s/.npmrc pins ignore-scripts=true', (workspace) => {
    const npmrc = join(ROOT, workspace, '.npmrc');
    expect(existsSync(npmrc), `${workspace}/.npmrc is missing — npm does not inherit the root .npmrc for this workspace's install path`).toBe(true);
    const lines = readFileSync(npmrc, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(lines, `${workspace}/.npmrc must set ignore-scripts=true`).toContain('ignore-scripts=true');
  });
});

describe('trusted rebuild allowlist', () => {
  it('declares only known workspaces, each with a valid shape', () => {
    for (const [label, groups] of Object.entries(TRUSTED_REBUILDS)) {
      expect(WORKSPACES).toContain(label);
      expect(Array.isArray(groups)).toBe(true);
      for (const group of groups) {
        expect(Array.isArray(group.pkgs)).toBe(true);
        expect(group.pkgs.length).toBeGreaterThan(0);
        expect(typeof group.fatal).toBe('boolean');
      }
    }
  });

  // The point of the allowlist is that ignore-scripts=true blocks EVERY install
  // hook, so any package that legitimately needs one must be named explicitly.
  // If a new dependency shows up with a postinstall and nobody decides about it,
  // it is silently left unbuilt — which surfaces later as a confusing runtime
  // crash on a missing native binding. Fail here instead, at the point the
  // dependency is added, and force the decision: add it to the allowlist, or
  // confirm its hook is genuinely unnecessary and add it to the ignore list.
  const DELIBERATELY_UNBUILT = {
    // No install hook is needed for these to work; their scripts are optional
    // niceties (codegen / telemetry / prebuild shortcuts).
    server: []
  };

  it.each(WORKSPACES)('%s: every installed package with an install hook is accounted for', (workspace) => {
    const hooked = packagesWithInstallHooks(workspace);
    if (hooked === null) {
      // node_modules absent (e.g. the client workspace in the server CI job).
      return;
    }
    const label = workspace === '.' ? 'root' : workspace;
    const allowed = new Set([
      ...(TRUSTED_REBUILDS[label] ?? []).flatMap((group) => group.pkgs),
      ...(DELIBERATELY_UNBUILT[label] ?? [])
    ]);
    const unaccounted = [...hooked].filter((name) => !allowed.has(name));
    expect(
      unaccounted,
      `${workspace}: these packages declare an install hook that ignore-scripts=true blocks, but are not in the allowlist in scripts/trusted-rebuilds.js. Either add them (if the build is needed) or list them under DELIBERATELY_UNBUILT: ${unaccounted.join(', ')}`
    ).toEqual([]);
  });
});
