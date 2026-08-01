/**
 * Repo-wide guard: a mounted-guard ref must re-arm itself on mount.
 *
 * The broken shape is a ref seeded `useRef(true)` whose ONLY assignment is
 * `false` in an effect cleanup:
 *
 *   const mountedRef = useRef(true);
 *   useEffect(() => () => { mountedRef.current = false; }, []);   // ← no setup body
 *
 * It reads as correct, and it is — in production. But the app runs under
 * `React.StrictMode` (`client/src/main.jsx`), and React's dev build mounts every
 * component as setup → cleanup → setup on the SAME instance. Refs survive that
 * cycle, so the cleanup flips the flag to `false` and nothing ever flips it back:
 * every `if (mountedRef.current) setX(...)` in the component is dead for the rest
 * of the dev session. That shipped as two user-visible freezes — MusicGenPanel
 * stuck on "Loading generators…" forever, and every `useAsyncAction` button stuck
 * in its disabled/spinner state after one click (#3264).
 *
 * `hooks/useMounted.js` is the fix and the only sanctioned form: it assigns `true`
 * in the effect setup body, so the StrictMode remount re-arms the guard.
 *
 * The rule below is deliberately shape-based rather than name-based — a ref called
 * `editorMountedRef` (or anything else) carries the identical bug, and one of the
 * sites this guard was written for was named exactly that. Scoped to git-tracked
 * sources under `client/src` per the repo-hygiene convention in
 * `client/src/a11yConventions.test.js`, so an untracked scratch file can't fail it.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function trackedSourceFiles() {
  const out = execSync('git ls-files src', { cwd: CLIENT_ROOT, encoding: 'utf8' });
  return out.trim().split('\n').filter((f) => /\.jsx?$/.test(f) && !f.includes('.test.'));
}

// `const <name> = useRef(true)` — the seed value that marks a mounted-style guard.
// A ref seeded `useRef(false)` and raised to `true` on mount is a different (and
// correct) pattern, so it is intentionally out of scope.
const TRUE_SEEDED_REF = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useRef\(\s*true\s*\)/g;

const assignsRe = (name, value) => new RegExp(`\\b${name}\\.current\\s*=\\s*${value}\\b`);

/** Refs in `src` that are lowered to false but never re-raised to true. */
function findOneWayRefs(src) {
  const offenders = [];
  for (const match of src.matchAll(TRUE_SEEDED_REF)) {
    const name = match[1];
    if (assignsRe(name, 'false').test(src) && !assignsRe(name, 'true').test(src)) {
      offenders.push(name);
    }
  }
  return offenders;
}

describe('mounted-guard refs re-arm on mount (StrictMode)', () => {
  it('has no ref that is only ever set to false', () => {
    const violations = [];
    for (const file of trackedSourceFiles()) {
      const src = readFileSync(join(CLIENT_ROOT, file), 'utf8');
      for (const name of findOneWayRefs(src)) violations.push(`${file}: ${name}`);
    }

    expect(
      violations,
      'These refs are seeded `useRef(true)` and set to `false` on cleanup, but never '
      + 'back to `true` on setup. Under React.StrictMode the dev mount→cleanup→mount '
      + 'cycle reuses the same ref, so each one is permanently false after first mount '
      + 'and every setState it guards silently no-ops.\n'
      + 'Fix: replace the ref + its cleanup effect with `useMounted()` from '
      + '`client/src/hooks/useMounted.js`.\n'
      + `Offenders:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // Guards the guard: if the detector stops recognizing the broken shape, the test
  // above goes vacuously green and the bug class walks straight back in.
  it('detects the broken shape and accepts the useMounted shape', () => {
    const broken = `
      const mountedRef = useRef(true);
      useEffect(() => () => { mountedRef.current = false; }, []);
    `;
    const brokenRenamed = `
      const editorMountedRef = useRef(true);
      useEffect(() => () => { editorMountedRef.current = false; }, []);
    `;
    const fixed = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    expect(findOneWayRefs(broken)).toEqual(['mountedRef']);
    expect(findOneWayRefs(brokenRenamed)).toEqual(['editorMountedRef']);
    expect(findOneWayRefs(fixed)).toEqual([]);
  });

  it('scans a non-empty set of tracked sources', () => {
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // the whole guard pass by scanning nothing.
    expect(trackedSourceFiles().length).toBeGreaterThan(100);
  });
});
