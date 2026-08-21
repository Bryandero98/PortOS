import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ bufferedSpawn: vi.fn() }));
vi.mock('./bufferedSpawn.js', () => spawned);

const pathLookup = vi.hoisted(() => ({ findCommandOnPath: vi.fn(() => '/opt/homebrew/bin/mtplx') }));
vi.mock('./processEnv.js', () => pathLookup);

import { listMtplxCachedModels, pickMtplxCachedModel } from './mtplxModels.js';

const ok = (stdout) => ({ success: true, code: 0, signal: null, stdout, stderr: '', timedOut: false });

afterEach(() => {
  vi.clearAllMocks();
  pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
});

describe('listMtplxCachedModels', () => {
  it('reads the cache listing without touching the network', async () => {
    spawned.bufferedSpawn.mockResolvedValue(ok(JSON.stringify({
      cache_dir: '/cache/models',
      models: [{ repo_id: 'Example/Model-A', validation: { ok: true } }],
    })));

    const result = await listMtplxCachedModels();

    expect(spawned.bufferedSpawn).toHaveBeenCalledWith('/opt/homebrew/bin/mtplx', ['models', '--json'], expect.objectContaining({ shell: false }));
    expect(result).toEqual({ models: [{ repo_id: 'Example/Model-A', validation: { ok: true } }], error: null });
  });

  it('reports an EMPTY cache as [], not as a failure', async () => {
    // The sentinel that matters: `[]` means "read it, nothing is there" and the
    // caller must refuse to start; collapsing it into `null` would launch a
    // server that exits 1 the moment it looks for weights.
    spawned.bufferedSpawn.mockResolvedValue(ok(JSON.stringify({ cache_dir: '/cache/models', models: [] })));

    expect(await listMtplxCachedModels()).toMatchObject({ models: [], error: null });
  });

  it('returns null models — never [] — when the cache cannot be read at all', async () => {
    pathLookup.findCommandOnPath.mockReturnValue(null);
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: expect.stringMatching(/PATH/) });
    expect(spawned.bufferedSpawn).not.toHaveBeenCalled();

    pathLookup.findCommandOnPath.mockReturnValue('/opt/homebrew/bin/mtplx');
    spawned.bufferedSpawn.mockResolvedValue({ success: false, code: 2, stdout: '', stderr: 'usage: mtplx models\nerror: unknown flag', timedOut: false });
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: 'error: unknown flag' });

    spawned.bufferedSpawn.mockResolvedValue({ success: false, code: -1, stdout: '', stderr: '', timedOut: true });
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: expect.stringMatching(/timed out/) });

    spawned.bufferedSpawn.mockResolvedValue(ok('not json at all'));
    expect(await listMtplxCachedModels()).toMatchObject({ models: null, error: expect.stringMatching(/did not return a model list/) });
  });

  it('skips a banner printed ahead of the JSON payload', async () => {
    spawned.bufferedSpawn.mockResolvedValue(ok(`MTPLX 2.9.0\n${JSON.stringify({ cache_dir: '/c', models: [] })}`));
    expect(await listMtplxCachedModels()).toMatchObject({ models: [], error: null });
  });

  it('honours a custom command name', async () => {
    pathLookup.findCommandOnPath.mockReturnValue(null);
    await listMtplxCachedModels({ command: 'mtplx-next' });
    expect(pathLookup.findCommandOnPath).toHaveBeenCalledWith('mtplx-next');
  });
});

describe('pickMtplxCachedModel', () => {
  it('prefers a model carrying the recorded exactness contract', () => {
    expect(pickMtplxCachedModel([
      { repo_id: 'Example/Plain', has_runtime_contract: false, validation: { ok: true } },
      { repo_id: 'Example/Verified', has_runtime_contract: true, validation: { ok: true } },
    ])).toBe('Example/Verified');
  });

  it('falls back to any complete model when none carries a contract', () => {
    expect(pickMtplxCachedModel([{ repo_id: 'Example/Plain', validation: { ok: true } }])).toBe('Example/Plain');
  });

  it('refuses a half-finished pull — a partial directory would fail on load', () => {
    expect(pickMtplxCachedModel([
      { repo_id: 'Example/Partial', has_runtime_contract: true, validation: { ok: false, missing_files: ['mtp sidecar'] } },
    ])).toBeNull();
  });

  it('accepts a row from an older CLI that reports no validation block', () => {
    expect(pickMtplxCachedModel([{ repo_id: 'Example/Old' }])).toBe('Example/Old');
  });

  it('returns null for an empty, unreadable, or id-less cache', () => {
    expect(pickMtplxCachedModel([])).toBeNull();
    expect(pickMtplxCachedModel(null)).toBeNull();
    expect(pickMtplxCachedModel([{ path: '/cache/broken' }])).toBeNull();
  });
});
