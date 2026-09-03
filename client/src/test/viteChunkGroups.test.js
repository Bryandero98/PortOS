import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHUNK_GROUPS } from '../../vite.chunkGroups.js';

const CLIENT_DIR = resolve(import.meta.dirname, '../..');
// Client deps install into client/node_modules; a few hoist to the repo root.
const NODE_MODULES_DIRS = [
  resolve(CLIENT_DIR, 'node_modules'),
  resolve(CLIENT_DIR, '../node_modules'),
].filter(existsSync);

const isInstalled = (name) => NODE_MODULES_DIRS.some((dir) => (
  name.endsWith('*')
    ? readdirSync(dir).some((entry) => entry.startsWith(name.slice(0, -1)))
    : existsSync(resolve(dir, name))
));

const groupNamed = (name) => CHUNK_GROUPS.find((group) => group.name === name);

describe('vite chunk groups', () => {
  // The regression: a group regex naming a package that is not installed matches
  // nothing, so the named chunk quietly stops capturing what its comment claims.
  // `vendor-three` shipped that way against the removed `three-fenestra` (#5725).
  it('only names packages that are actually installed', () => {
    const missing = CHUNK_GROUPS.flatMap(({ name, packages }) =>
      packages.filter((pkg) => !isInstalled(pkg)).map((pkg) => `${name} -> ${pkg}`));
    expect(NODE_MODULES_DIRS.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('captures the whole three stack on both path separators', () => {
    const { test } = groupNamed('vendor-three');
    expect(test.test('/app/node_modules/three/build/three.module.js')).toBe(true);
    expect(test.test('/app/node_modules/three-stdlib/index.js')).toBe(true);
    expect(test.test('/app/node_modules/three-mesh-bvh/src/index.js')).toBe(true);
    expect(test.test('C:\\app\\node_modules\\@react-three\\fiber\\index.js')).toBe(true);
    // A `three`-prefixed package we do not depend on must not be swept in.
    expect(test.test('/app/node_modules/three-globe/index.js')).toBe(false);
  });

  it('keeps package names from bleeding across the separator', () => {
    // `react` must not swallow `react-router-dom` or a nested `react` copy's
    // sibling; the trailing separator is what enforces a whole-segment match.
    const { test } = groupNamed('vendor-react');
    expect(test.test('/app/node_modules/react/index.js')).toBe(true);
    expect(test.test('/app/node_modules/react-redux/index.js')).toBe(false);
    // Family prefixes still match every member.
    const charts = groupNamed('vendor-charts').test;
    expect(charts.test('/app/node_modules/d3-scale/src/band.js')).toBe(true);
    expect(charts.test('/app/node_modules/victory-vendor/d3-scale.js')).toBe(true);
  });
});
