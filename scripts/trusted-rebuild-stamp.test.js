import { describe, expect, it, vi } from 'vitest';

import { TRUSTED_REBUILDS } from './trusted-rebuilds.js';
import { STAMP_FILE, compareStamp, expectedStamp, runCli } from './trusted-rebuild-stamp.js';

const linux = { platform: 'linux', arch: 'x64', modules: '137' };

describe('expectedStamp', () => {
  it('binds the mark to the allowlist, not just to the workspace name', () => {
    // Regrouping or renaming a package has to invalidate an existing mark: the
    // tree was built against a different set of rebuilds.
    const before = expectedStamp('server', linux);
    const original = TRUSTED_REBUILDS.server;
    try {
      TRUSTED_REBUILDS.server = [{ pkgs: ['node-pty'], fatal: true }];
      expect(expectedStamp('server', linux).allowlist).not.toBe(before.allowlist);
    } finally {
      TRUSTED_REBUILDS.server = original;
    }
    expect(expectedStamp('server', linux)).toEqual(before);
  });

  it('records the ABI a compiled addon is actually bound to', () => {
    // The cache key carries the Node *major*; NODE_MODULE_VERSION is the thing
    // a .node file will refuse to load against.
    expect(expectedStamp('server', linux).modules).toBe('137');
    expect(expectedStamp('server', { ...linux, modules: 999 }).modules).toBe('999');
  });
});

describe('compareStamp', () => {
  const expected = expectedStamp('server', linux);

  it('accepts a tree built for the same allowlist, platform, and ABI', () => {
    expect(compareStamp(expected, { ...expected })).toEqual([]);
  });

  it('treats an absent mark as not rebuilt', () => {
    // The case the old require()-based check could never catch: npm ci alone
    // leaves every allowlisted package importable, because they ship prebuilt
    // bindings in their tarballs.
    expect(compareStamp(expected, null)).toEqual(['missing']);
  });

  it('names every field that disagrees', () => {
    expect(compareStamp(expected, { ...expected, platform: 'win32', modules: '115' }))
      .toEqual(['platform', 'modules']);
  });
});

describe('trusted-rebuild-stamp CLI', () => {
  const stamp = expectedStamp('server', linux);
  const expected = () => stamp;

  it('writes the mark next to the tree it describes', () => {
    const write = vi.fn();
    expect(runCli(['write', 'server'], { write, expected })).toBe(0);
    const [path, body] = write.mock.calls[0];
    // Split on either separator: this file runs in the Windows job too,
    // where join() yields backslashes.
    expect(path.split(/[\\/]/).slice(-3)).toEqual(['server', 'node_modules', STAMP_FILE]);
    expect(JSON.parse(body)).toEqual(stamp);
  });

  it('passes a matching mark and fails a mismatched or missing one', () => {
    expect(runCli(['check', 'server'], { read: () => stamp, expected })).toBe(0);
    expect(runCli(['check', 'server'], { read: () => ({ ...stamp, arch: 'arm64' }), expected })).toBe(1);
    expect(runCli(['check', 'server'], { read: () => null, expected })).toBe(1);
  });

  it('rejects a bad action or workspace before touching the tree', () => {
    // Same trap trusted-rebuilds.js guards: a typo must not fall through to a
    // green no-op, which is the false confidence this whole check exists to
    // remove.
    const write = vi.fn();
    expect(runCli(['check', 'sever'], { expected, write })).toBe(1);
    expect(runCli(['stamp', 'server'], { expected, write })).toBe(1);
    expect(runCli(['write'], { expected, write })).toBe(1);
    expect(write).not.toHaveBeenCalled();
  });
});
