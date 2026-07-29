/**
 * Tests for the host-shutdown signal + durable marker (#3202).
 *
 * The marker is what lets the NEXT boot tell "PortOS was restarted out from
 * under a running agent" apart from "the agent's own process died" — so the
 * contract that matters most here is that every read path DEGRADES rather than
 * throws. A garbled/absent marker must yield "nobody was interrupted", which
 * routes those agents through the pre-existing (safe) orphan path instead of
 * crashing boot recovery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpRoot;

// PATHS.cos is where the marker lives; point it at a scratch dir so the suite
// never touches the install's real data/.
vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, get PATHS() { return { ...actual.PATHS, cos: globalThis.__hostShutdownTestCos }; } };
});

const {
  markHostShuttingDown,
  isHostShuttingDown,
  resetHostShutdownFlagForTests,
  writeHostShutdownMarker,
  readHostShutdownMarker,
  clearHostShutdownMarker,
  hostShutdownMarkerPath,
  HOST_SHUTDOWN_REASON,
} = await import('./hostShutdown.js');

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'portos-host-shutdown-'));
  globalThis.__hostShutdownTestCos = tmpRoot;
  resetHostShutdownFlagForTests();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  delete globalThis.__hostShutdownTestCos;
});

describe('in-process shutdown flag', () => {
  it('starts false and latches once marked', () => {
    expect(isHostShuttingDown()).toBe(false);
    markHostShuttingDown();
    expect(isHostShuttingDown()).toBe(true);
    // Idempotent — a second signal must not un-latch it.
    markHostShuttingDown();
    expect(isHostShuttingDown()).toBe(true);
  });

  it('names a stable completion reason', () => {
    expect(HOST_SHUTDOWN_REASON).toBe('host-shutdown');
  });
});

describe('marker round-trip', () => {
  it('writes the live agent ids and reads them back', async () => {
    expect(await writeHostShutdownMarker({ agentIds: ['a1', 'a2'], signal: 'SIGTERM' })).toBe(true);

    const marker = await readHostShutdownMarker();
    expect(marker.agentIds).toEqual(['a1', 'a2']);
    expect(marker.signal).toBe('SIGTERM');
    expect(marker.at).toEqual(expect.any(String));
  });

  it('dedupes ids and drops non-string entries', async () => {
    await writeHostShutdownMarker({ agentIds: ['a1', 'a1', '', null, 7, 'a2'], signal: 'SIGINT' });

    expect((await readHostShutdownMarker()).agentIds).toEqual(['a1', 'a2']);
  });

  it('writes nothing when no agents were live', async () => {
    expect(await writeHostShutdownMarker({ agentIds: [], signal: 'SIGTERM' })).toBe(false);
    expect(await readHostShutdownMarker()).toBeNull();
  });

  it('clears the marker', async () => {
    await writeHostShutdownMarker({ agentIds: ['a1'], signal: 'SIGTERM' });
    await clearHostShutdownMarker();

    expect(await readHostShutdownMarker()).toBeNull();
  });

  it('clearing a marker that is not there is a no-op, not a throw', async () => {
    await expect(clearHostShutdownMarker()).resolves.toBeUndefined();
  });
});

// Every one of these would previously have to be handled by the caller. Boot
// recovery runs before anything else, so a throw here would be a boot crash —
// the degraded answer ("nobody was interrupted") is always the right one.
describe('a damaged marker degrades to "nobody was interrupted"', () => {
  const writeRaw = async (contents) => {
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(hostShutdownMarkerPath(), contents);
  };

  it('returns null for absent', async () => {
    expect(await readHostShutdownMarker()).toBeNull();
  });

  it('returns null for unparseable JSON', async () => {
    await writeRaw('{ "agentIds": ["a1"');
    expect(await readHostShutdownMarker()).toBeNull();
  });

  it('returns null for a JSON array (wrong shape)', async () => {
    await writeRaw('["a1","a2"]');
    expect(await readHostShutdownMarker()).toBeNull();
  });

  it('returns an empty agent list when agentIds is missing or not an array', async () => {
    await writeRaw(JSON.stringify({ at: 'x', signal: 'SIGTERM' }));
    expect((await readHostShutdownMarker()).agentIds).toEqual([]);

    await writeRaw(JSON.stringify({ agentIds: 'a1' }));
    expect((await readHostShutdownMarker()).agentIds).toEqual([]);
  });

  it('normalizes non-string at/signal to null rather than surfacing junk', async () => {
    await writeRaw(JSON.stringify({ at: 12345, signal: { x: 1 }, agentIds: ['a1'] }));

    const marker = await readHostShutdownMarker();
    expect(marker.at).toBeNull();
    expect(marker.signal).toBeNull();
    expect(marker.agentIds).toEqual(['a1']);
  });
});

describe('marker location', () => {
  it('lives under the CoS data dir so a data wipe clears it too', async () => {
    await writeHostShutdownMarker({ agentIds: ['a1'], signal: 'SIGTERM' });

    expect(hostShutdownMarkerPath()).toBe(join(tmpRoot, 'host-shutdown.json'));
    expect(JSON.parse(await readFile(hostShutdownMarkerPath(), 'utf8')).agentIds).toEqual(['a1']);
  });
});
