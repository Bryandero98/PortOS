import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `stat`/`readFile` are mocked so a dataless file can be simulated on any
// platform (an evicted iCloud file cannot be created in a test), and so the
// suite can assert that the guarded read never issues `readFile` at all.
const statMock = vi.fn();
const readFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('fs/promises', () => ({
  stat: (...args) => statMock(...args),
  readFile: (...args) => readFileMock(...args),
}));

vi.mock('child_process', () => ({
  spawn: (...args) => spawnMock(...args),
}));

const UBIQUITY_DIR = '/Users/example/Library/Mobile Documents/iCloud~com~example~App/Documents';
const ICLOUD_PATH = `${UBIQUITY_DIR}/Store.json`;
const LOCAL_PATH = '/Users/example/projects/app/data/store.json';

// A dataless (evicted) file: real byte length, zero blocks allocated locally.
const datalessStats = { size: 503098, blocks: 0 };
const materializedStats = { size: 503098, blocks: 984 };

// A stand-in for the detached `brctl download` child requestMaterialization spawns.
function makeFakeChild() {
  const handlers = {};
  return {
    unref: vi.fn(),
    on(event, cb) { handlers[event] = cb; return this; },
    emit(event, ...args) { handlers[event]?.(...args); },
  };
}

let icloud;
let warnSpy;
let logSpy;
let platformSpy;

beforeEach(async () => {
  vi.resetModules();
  statMock.mockReset();
  readFileMock.mockReset();
  spawnMock.mockReset();
  // The guard is macOS-only; pin the platform so the suite is deterministic on
  // Linux CI as well as a developer Mac.
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  spawnMock.mockReturnValue(makeFakeChild());
  icloud = await import('./icloudFile.js');
  icloud._resetICloudFileStateForTest();
});

afterEach(() => {
  platformSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('isUbiquityPath', () => {
  it('recognizes a ubiquity-container path', () => {
    expect(icloud.isUbiquityPath(ICLOUD_PATH)).toBe(true);
  });

  it('rejects an ordinary path and non-strings', () => {
    expect(icloud.isUbiquityPath(LOCAL_PATH)).toBe(false);
    expect(icloud.isUbiquityPath(undefined)).toBe(false);
    expect(icloud.isUbiquityPath(42)).toBe(false);
  });
});

describe('isDatalessStats', () => {
  it('is true only for a non-empty file with zero local blocks', () => {
    expect(icloud.isDatalessStats(datalessStats)).toBe(true);
    expect(icloud.isDatalessStats(materializedStats)).toBe(false);
  });

  it('is false for a genuinely empty file (size 0), not dataless', () => {
    // A 0-byte file legitimately has 0 blocks — treating it as evicted would
    // refuse to read a real, readable, empty file forever.
    expect(icloud.isDatalessStats({ size: 0, blocks: 0 })).toBe(false);
  });

  it('is false for a missing stats object', () => {
    expect(icloud.isDatalessStats(null)).toBe(false);
    expect(icloud.isDatalessStats(undefined)).toBe(false);
  });
});

describe('isSuspectedDataless', () => {
  it('screens a dataless ubiquity file', async () => {
    statMock.mockResolvedValue(datalessStats);
    await expect(icloud.isSuspectedDataless(ICLOUD_PATH)).resolves.toBe(true);
  });

  it('does not stat a non-ubiquity path at all', async () => {
    // An ordinary APFS file can report blocks:0 when transparently compressed,
    // so the guard must never apply outside a ubiquity container.
    await expect(icloud.isSuspectedDataless(LOCAL_PATH)).resolves.toBe(false);
    expect(statMock).not.toHaveBeenCalled();
  });

  it('is inert off darwin', async () => {
    platformSpy.mockReturnValue('linux');
    await expect(icloud.isSuspectedDataless(ICLOUD_PATH)).resolves.toBe(false);
    expect(statMock).not.toHaveBeenCalled();
  });

  it('treats a stat failure as not-dataless (absent/EACCES is the caller\'s path)', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    await expect(icloud.isSuspectedDataless(ICLOUD_PATH)).resolves.toBe(false);
  });
});

describe('readIfMaterialized', () => {
  it('issues ZERO readFile calls against a dataless file', async () => {
    statMock.mockResolvedValue(datalessStats);

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).rejects.toMatchObject({
      code: icloud.ICLOUD_NOT_MATERIALIZED,
    });
    // The whole point: the blocking read is never issued.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('kicks a background brctl download for an evicted file', async () => {
    statMock.mockResolvedValue(datalessStats);

    await icloud.readIfMaterialized(ICLOUD_PATH).catch(() => {});

    expect(spawnMock).toHaveBeenCalledWith(
      'brctl',
      ['download', ICLOUD_PATH],
      expect.objectContaining({ detached: true })
    );
  });

  it('reads normally when the file is materialized', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('{"ok":true}');

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('{"ok":true}');
    expect(readFileMock).toHaveBeenCalledWith(ICLOUD_PATH, 'utf-8');
  });

  it('reads a non-iCloud path without any stat overhead', async () => {
    readFileMock.mockResolvedValue('local');

    await expect(icloud.readIfMaterialized(LOCAL_PATH)).resolves.toBe('local');
    expect(statMock).not.toHaveBeenCalled();
  });

  it('propagates a normal read error unchanged', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('coalesces concurrent reads of one path into a single read', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('shared');

    const results = await Promise.all([
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH),
    ]);

    expect(results).toEqual(['shared', 'shared', 'shared']);
    // Single-flight is what caps threadpool occupancy at one slot per path.
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache across settled calls (coalesces concurrency only)', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('first');
    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('second');
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it('shares a rejection with every concurrent caller and then clears', async () => {
    statMock.mockResolvedValue(datalessStats);

    const settled = await Promise.allSettled([
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH),
    ]);
    expect(settled.every(r => r.status === 'rejected')).toBe(true);
    expect(statMock).toHaveBeenCalledTimes(1);

    // The single-flight entry must be released even on rejection, or the path
    // would be permanently poisoned once iCloud recovers.
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('healed');
    await expect(icloud.readIfMaterialized(ICLOUD_PATH)).resolves.toBe('healed');
  });

  it('does not coalesce distinct paths', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockResolvedValue('x');

    await Promise.all([
      icloud.readIfMaterialized(`${UBIQUITY_DIR}/a.json`),
      icloud.readIfMaterialized(`${UBIQUITY_DIR}/b.json`),
    ]);

    expect(readFileMock).toHaveBeenCalledTimes(2);
  });
});

describe('requestMaterialization', () => {
  it('dedupes while a download is in flight, and retries after it exits', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(true);
    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Once the child exits the dedupe entry clears, so a later read can retry.
    child.emit('exit', 0, null);
    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('unrefs the child so a slow download cannot hold the process open', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    icloud.requestMaterialization(ICLOUD_PATH);
    expect(child.unref).toHaveBeenCalled();
  });

  it('warns once when brctl is missing', () => {
    const first = makeFakeChild();
    spawnMock.mockReturnValue(first);
    icloud.requestMaterialization(`${UBIQUITY_DIR}/a.json`);
    first.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));

    const second = makeFakeChild();
    spawnMock.mockReturnValue(second);
    icloud.requestMaterialization(`${UBIQUITY_DIR}/b.json`);
    second.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));

    const missingWarns = warnSpy.mock.calls.filter(([m]) => String(m).includes('brctl not found'));
    expect(missingWarns).toHaveLength(1);
  });

  it('is a no-op off darwin', () => {
    platformSpy.mockReturnValue('linux');
    expect(icloud.requestMaterialization(ICLOUD_PATH)).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('background-download safety caps', () => {
  it('caps concurrent brctl children so an evicted vault walk cannot fork thousands', async () => {
    statMock.mockResolvedValue(datalessStats);
    // A vault walk hits a distinct path per note. Without a cap this would be one
    // `brctl download` child per note.
    for (let i = 0; i < 50; i++) {
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/note-${i}.md`).catch(() => {});
    }
    expect(spawnMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('resumes healing later notes once earlier downloads exit', async () => {
    statMock.mockResolvedValue(datalessStats);
    const children = [];
    spawnMock.mockImplementation(() => { const c = makeFakeChild(); children.push(c); return c; });

    for (let i = 0; i < 10; i++) {
      await icloud.readIfMaterialized(`${UBIQUITY_DIR}/a-${i}.md`).catch(() => {});
    }
    expect(spawnMock).toHaveBeenCalledTimes(4);

    // Drain the in-flight set; the next read is free to kick a download again.
    children.forEach(c => c.emit('exit', 0, null));
    await icloud.readIfMaterialized(`${UBIQUITY_DIR}/b.md`).catch(() => {});
    expect(spawnMock).toHaveBeenCalledTimes(5);
  });

  it('does not hand a base64 caller the utf-8 caller\'s result', async () => {
    statMock.mockResolvedValue(materializedStats);
    readFileMock.mockImplementation((_p, enc) => Promise.resolve(`body-as-${enc}`));

    const [utf8, b64] = await Promise.all([
      icloud.readIfMaterialized(ICLOUD_PATH),
      icloud.readIfMaterialized(ICLOUD_PATH, { encoding: 'base64' }),
    ]);

    expect(utf8).toBe('body-as-utf-8');
    expect(b64).toBe('body-as-base64');
  });
});
