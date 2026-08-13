import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { PORTS, resolvePostgresPort } from './ports.js';

// `ecosystem.config.cjs` is the source of truth for port numbers; `ports.js` is a
// hand-maintained ESM mirror of it (the ESM server can't require() the CJS
// config). These tests fail when the two drift apart — see docs/PORTS.md.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ecosystemPath = path.join(repoRoot, 'ecosystem.config.cjs');
const { PORTS: ECOSYSTEM_PORTS } = require(ecosystemPath);

// `POSTGRES` is resolved from PGMODE at config-load time, so it has no single
// literal counterpart in the mirror — it's covered by its own assertions below.
const RESOLVED_ONLY = ['POSTGRES'];
// The mirror keeps both PostgreSQL literals so callers can resolve either mode.
const MIRROR_ONLY = ['POSTGRES_NATIVE'];

describe('PORTS mirror of ecosystem.config.cjs', () => {
  it('mirrors every fixed port from the ecosystem config', () => {
    const expected = Object.fromEntries(
      Object.entries(ECOSYSTEM_PORTS).filter(([key]) => !RESOLVED_ONLY.includes(key))
    );
    const actual = Object.fromEntries(
      Object.entries(PORTS).filter(([key]) => !MIRROR_ONLY.includes(key))
    );
    expect(actual).toEqual(expected);
  });

  it('has no extra ports beyond the ecosystem config', () => {
    const extras = Object.keys(PORTS).filter(
      (key) => !(key in ECOSYSTEM_PORTS) && !MIRROR_ONLY.includes(key)
    );
    expect(extras).toEqual([]);
  });

  it('resolves the active PostgreSQL port to one of the mirrored literals', () => {
    expect([PORTS.POSTGRES_NATIVE, PORTS.POSTGRES_DOCKER]).toContain(ECOSYSTEM_PORTS.POSTGRES);
  });

  it('keeps the native PostgreSQL literal in sync with the config source', () => {
    // The native port only appears inside the config's PGMODE ternary, so there is
    // no exported constant to compare against — assert against the source line.
    // Compare whole numeric literals, not substrings: a config renumbered to 15432
    // or 54321 still *contains* "5432", so a substring check would pass on drift.
    const source = readFileSync(ecosystemPath, 'utf8');
    const postgresLine = source.split('\n').find((line) => /^\s*POSTGRES:/.test(line));
    expect(postgresLine).toBeTruthy();
    const literals = (postgresLine.replace(/\/\/.*$/, '').match(/\d+/g) || []).map(Number);
    expect(new Set(literals)).toEqual(new Set([PORTS.POSTGRES_NATIVE, PORTS.POSTGRES_DOCKER]));
  });
});

describe('resolvePostgresPort', () => {
  it('returns the native port for PGMODE=native', () => {
    expect(resolvePostgresPort('native')).toBe(5432);
  });

  it('returns the Docker port for PGMODE=docker', () => {
    expect(resolvePostgresPort('docker')).toBe(5561);
  });

  it('defaults to the Docker port when the mode is unset or unknown', () => {
    expect(resolvePostgresPort(undefined)).toBe(5561);
    expect(resolvePostgresPort('file')).toBe(5561);
  });
});
