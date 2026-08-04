import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

import { TRUSTED_REBUILDS, discoverWorkspaces, workspaceDir } from './trusted-rebuilds.js';

// Discovered, not hand-listed: a hardcoded roster here would silently miss a
// workspace added later, leaving it with no `ignore-scripts` guard while this
// suite stayed green — the same drift the shared allowlist exists to prevent.
const WORKSPACES = discoverWorkspaces();

const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall'];

/**
 * Packages in a workspace's installed tree that declare a lifecycle install hook.
 * Returns null when the workspace has no node_modules (e.g. the client tree in
 * the server CI job), which is a skip rather than a pass.
 *
 * Only two levels are ever walked — top-level `node_modules/*` and one level into
 * `node_modules/@scope/*` — because npm scopes do not nest.
 */
function packagesWithInstallHooks(label) {
  const modulesDir = join(workspaceDir(label), 'node_modules');
  if (!existsSync(modulesDir)) return null;

  const dirNames = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const packageDirs = dirNames(modulesDir).flatMap((name) => (
    name.startsWith('@')
      ? dirNames(join(modulesDir, name)).map((scoped) => join(modulesDir, name, scoped))
      : [join(modulesDir, name)]
  ));

  const found = new Set();
  for (const packageDir of packageDirs) {
    const manifest = join(packageDir, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    if (LIFECYCLE_HOOKS.some((hook) => pkg?.scripts?.[hook])) found.add(pkg.name);
  }
  return found;
}

describe('ignore-scripts guard', () => {
  it('discovers every installable workspace', () => {
    // Sanity-check the discovery itself: if it silently returned only the root,
    // every per-workspace assertion below would vacuously pass.
    expect(WORKSPACES).toContain('root');
    expect(WORKSPACES).toContain('client');
    expect(WORKSPACES).toContain('server');
    expect(WORKSPACES.length).toBeGreaterThanOrEqual(4);
  });

  // npm resolves the project .npmrc from the *local prefix* and never walks up the
  // tree, so the repo-root file does NOT cover `cd client && npm install` or
  // `npm ci --prefix client` (what CI runs). A workspace missing this file silently
  // re-grants every dependency in it an install-time code-execution slot — the
  // vector the Aug 2026 keyv/cacheable worm used via a preinstall hook.
  it.each(WORKSPACES)('%s/.npmrc pins ignore-scripts=true', (label) => {
    const npmrc = join(workspaceDir(label), '.npmrc');
    expect(existsSync(npmrc), `${label}/.npmrc is missing — npm does not inherit the root .npmrc for this workspace's install path`).toBe(true);
    const lines = readFileSync(npmrc, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(lines, `${label}/.npmrc must set ignore-scripts=true`).toContain('ignore-scripts=true');
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

  it('groups packages by distinct failure semantics, not one group per package', () => {
    // Each group is another npm spawn, so a group only earns its cost by carrying
    // a different `fatal` value than its neighbours.
    for (const [label, groups] of Object.entries(TRUSTED_REBUILDS)) {
      const fatalValues = groups.map((group) => group.fatal);
      expect(new Set(fatalValues).size, `${label}: two groups share the same \`fatal\` value — merge them into one npm rebuild call`).toBe(groups.length);
    }
  });

  // ignore-scripts=true blocks EVERY install hook, so any package that legitimately
  // needs one must be named explicitly. If a new dependency arrives with a
  // postinstall and nobody decides about it, it is silently left unbuilt — which
  // surfaces much later as a confusing runtime crash on a missing native binding.
  // Fail here instead, when the dependency lands, and force the decision.
  const DELIBERATELY_UNBUILT = {};

  it.each(WORKSPACES)('%s: every installed package with an install hook is accounted for', (label) => {
    const hooked = packagesWithInstallHooks(label);
    if (hooked === null) return; // node_modules absent in this job
    const allowed = new Set([
      ...(TRUSTED_REBUILDS[label] ?? []).flatMap((group) => group.pkgs),
      ...(DELIBERATELY_UNBUILT[label] ?? [])
    ]);
    const unaccounted = [...hooked].filter((name) => !allowed.has(name));
    expect(
      unaccounted,
      `${label}: these packages declare an install hook that ignore-scripts=true blocks, but are not in the allowlist in scripts/trusted-rebuilds.js. Either add them (if the build is needed) or list them under DELIBERATELY_UNBUILT: ${unaccounted.join(', ')}`
    ).toEqual([]);
  });
});
