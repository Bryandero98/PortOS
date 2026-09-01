/**
 * Temp-file / read-stream lifecycle contract for the Apple Health XML import.
 *
 * An `export.xml` is routinely 0.5-3GB and the route has already unlinked the
 * uploaded ZIP by the time the import runs, so `importAppleHealthXml` is the
 * last owner of that file: it must remove it and release its fd on EVERY exit,
 * not just the success path (issue #5654).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Keep the import off the real health day-file store; `writeDayFile` doubles as
// the injection point for a failing flush.
const store = vi.hoisted(() => ({ writeDayFile: null }));
vi.mock('./appleHealthIngest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readDayFile: vi.fn(async (date) => ({ date, metrics: {} })),
    writeDayFile: vi.fn((...args) => store.writeDayFile(...args)),
  };
});

// Capture the read streams the service opens so the fd-release half of the
// contract is assertable (unlink alone succeeds on POSIX with the fd still open).
const streams = [];
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createReadStream: (...args) => {
      const s = actual.createReadStream(...args);
      streams.push(s);
      return s;
    },
  };
});

const { importAppleHealthXml } = await import('./appleHealthXml.js');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
  <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-01-15 08:00:00 -0800" endDate="2025-01-15 08:05:00 -0800" value="120"/>
  <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2025-01-15 08:01:00 -0800" endDate="2025-01-15 08:01:00 -0800" value="72"/>
</HealthData>`;

const exists = (p) => access(p).then(() => true, () => false);

describe('importAppleHealthXml temp-file lifecycle', () => {
  let dir;
  let xmlPath;

  beforeEach(async () => {
    streams.length = 0;
    store.writeDayFile = async () => {};
    dir = await mkdtemp(join(tmpdir(), 'portos-apple-health-test-'));
    xmlPath = join(dir, 'export.xml');
    await writeFile(xmlPath, XML, 'utf-8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the input file and releases its fd after a successful import', async () => {
    const result = await importAppleHealthXml(xmlPath, null);

    expect(result).toEqual({ days: 1, records: 2 });
    expect(await exists(xmlPath)).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0].destroyed).toBe(true);
  });

  it('removes the input file and releases its fd when the flush rejects', async () => {
    store.writeDayFile = async () => { throw new Error('disk full'); };

    await expect(importAppleHealthXml(xmlPath, null)).rejects.toThrow('disk full');

    // Without the try/finally the multi-GB file and the open fd both survived
    // the rejection for the life of the process.
    expect(await exists(xmlPath)).toBe(false);
    expect(streams).toHaveLength(1);
    expect(streams[0].destroyed).toBe(true);
  });
});
