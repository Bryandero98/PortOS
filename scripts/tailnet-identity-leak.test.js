import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Regression guard: a real Tailscale MagicDNS tailnet suffix, real device
// names, and a real CGNAT peer IP were once committed across ~14 tracked
// files (server routes/lib, client lib, several test fixtures, doc plans,
// and two changelog entries) — a violation of this repo's own CLAUDE.md
// "Sensitive Data & Privacy" section, which lists Tailscale node/MagicDNS
// names and Tailscale/LAN IPs as never-commit categories. This test fails
// the moment a real-looking value of either kind lands in a tracked file
// again, so the leak can't silently recur via a pasted log line, a doc
// example lifted from a live install, or a copy-pasted test fixture.
//
// We enumerate via `git grep` rather than walking the tree so the check
// covers exactly *tracked* files — gitignored runtime data (e.g. `data/`)
// and the `lib/slashdo` submodule (a separate upstream repo, not ours to
// police) are excluded for free.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// This file's own detector self-check (below) necessarily contains strings
// shaped like the patterns it's guarding against, so it must exclude
// itself from the repo-wide scan — otherwise it would fail on its own
// fixtures.
const SELF_PATHSPEC = ':!scripts/tailnet-identity-leak.test.js';

/**
 * Real Tailscale MagicDNS tailnet suffixes are auto-generated as the literal
 * `tail` prefix followed by a short lowercase alphanumeric token that always
 * contains at least one digit (this is the exact shape of the value that
 * leaked). Every placeholder already used across this codebase for a fake
 * tailnet host (`tailnet`, `tailwind`-shaped words, `tail-net`, `my-machine`,
 * `example`, `host-example`, `example-tailnet`, …) is a human-chosen word
 * with no digit in the "tail…" segment, so this pattern flags a real-looking
 * suffix without tripping on any existing fake one.
 */
const REAL_TAILNET_SUFFIX_SOURCE = '\\btail(?=[a-z0-9]*[0-9])[a-z0-9]{3,8}\\.ts\\.net';

/**
 * 100.64.0.0/10 is Tailscale's CGNAT range. Every address in this range that
 * is an intentional test/doc fixture (CGNAT-detection unit tests, the
 * documented Alibaba Cloud metadata IP used in SSRF-guard tests, this
 * finding's own redacted placeholders, …) is enumerated here. Anything else
 * found in a tracked file is treated as a possible real peer address.
 */
const ALLOWED_CGNAT_IPS = new Set([
  '100.64.0.0',
  '100.64.0.1',
  '100.64.0.5',
  '100.64.0.6',
  '100.64.0.50',
  '100.64.0.99',
  '100.100.42.7',
  '100.100.50.1',
  '100.100.100.200', // documented Alibaba Cloud metadata endpoint, not a peer
]);
const CGNAT_IP_SOURCE = '\\b100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}\\b';
const CGNAT_IP_RE = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;

/** Runs `git grep -inP <pattern>` over tracked files and returns matching lines. */
function gitGrepLines(patternSource) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '-n', '-i', '-P', patternSource, '--', '.', ':!lib/slashdo', SELF_PATHSPEC],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    return out.trim().split('\n').filter(Boolean);
  } catch (err) {
    // git grep exits 1 when there are zero matches — that's the success case.
    if (err.status === 1) return [];
    throw err;
  }
}

describe('no real Tailscale identity in tracked files (see CLAUDE.md Sensitive Data & Privacy)', () => {
  it('detector matches a real-shaped tailnet suffix and not existing placeholders (self-check)', () => {
    const re = new RegExp(REAL_TAILNET_SUFFIX_SOURCE, 'i');
    // A synthetic value shaped like a real auto-generated Tailscale suffix
    // (never an observed real one) — proves the detector actually fires.
    expect(re.test('device.tail9f00c2.ts.net')).toBe(true);
    // Every placeholder style already used in this repo must NOT trip it.
    expect(re.test('host-alpha.example-tailnet.ts.net')).toBe(false);
    expect(re.test('host.tailnet.ts.net')).toBe(false);
    expect(re.test('my-machine.ts.net')).toBe(false);
    expect(re.test('box.tail-net.ts.net')).toBe(false);
  });

  it('finds no real-looking tail<digits>.ts.net MagicDNS suffix in tracked files', () => {
    const hits = gitGrepLines(REAL_TAILNET_SUFFIX_SOURCE);
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('finds no un-allowlisted Tailscale CGNAT (100.64.0.0/10) address in tracked files', () => {
    const lines = gitGrepLines(CGNAT_IP_SOURCE);
    const offenders = lines.filter((line) => {
      const ips = line.match(CGNAT_IP_RE) || [];
      return ips.some((ip) => !ALLOWED_CGNAT_IPS.has(ip));
    });
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
