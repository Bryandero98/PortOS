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
 * `hooks/useMounted.js` is the fix, and the sanctioned form for new code. (A dozen
 * older sites still inline the same body correctly — they DO set `true` on setup,
 * so they are safe and this guard passes them; converting them is follow-up
 * cleanup, not a correctness fix.)
 *
 * The rule is deliberately shape-based rather than name-based — a ref called
 * `editorMountedRef` carries the identical bug, and one of the sites this guard
 * was written for was named exactly that.
 *
 * ## What this guard CANNOT see
 *
 * It is a source grep, not a scope-aware AST pass, so these semantically identical
 * shapes slip through. They are listed so the next person extending it knows where
 * the floor is rather than trusting a green run too far:
 *
 *   - `let`/`var` declarations (the pattern hardcodes `const`).
 *   - A non-literal seed: `const INIT = true; const r = useRef(INIT)`.
 *   - Two components in ONE file where A is correct and B is broken — the scan is
 *     file-scoped, so A's `= true` satisfies B. Live risk: three separate
 *     `mountedRef`s coexist in `components/meatspace/post/PostCognitiveDrillRunner.jsx`.
 *   - A ref created in one file and lowered in another (a hook returning its ref to
 *     a caller that writes `ref.current = false`).
 *   - Aliasing (`const g = mountedRef; g.current = false`), computed access
 *     (`ref['current']`), or assignment funneled through a setter function.
 *   - An assignment that only appears inside a comment (no comment stripping).
 *
 * Tightening any of these means moving to an AST pass; the shapes above are all
 * unusual enough in this codebase that the grep earns its keep as-is.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { trackedSourceFiles } from '../test/trackedFiles.js';

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `const <name> = useRef(true)` — the seed value that marks a mounted-style guard.
// A ref seeded `useRef(false)` and raised to `true` on mount is a different (and
// correct) pattern, so it is intentionally out of scope.
const TRUE_SEEDED_REF = /const\s+([A-Za-z_$][\w$]*)\s*=\s*useRef\(\s*true\s*\)/g;

// `=` and `||=` both count as re-arming. Matching only `=` would report a ref
// re-armed with `ref.current ||= true` as broken — a false positive that would
// push someone to "fix" already-correct code.
const assignsRe = (name, value) => new RegExp(`\\b${name}\\.current\\s*(?:\\|\\|)?=\\s*${value}\\b`);

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
    const files = trackedSourceFiles(CLIENT_ROOT);
    // A broken `git ls-files` (wrong cwd, detached checkout) would otherwise make
    // this guard pass by scanning nothing at all.
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    for (const file of files) {
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
  it('detects the broken shape and accepts every correct re-arm', () => {
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
    // `||=` re-arms just as well as `=`; flagging it would be a false positive.
    const fixedLogicalAssign = `
      const mountedRef = useRef(true);
      useEffect(() => {
        mountedRef.current ||= true;
        return () => { mountedRef.current = false; };
      }, []);
    `;
    // A ref that is never lowered has nothing to re-arm.
    const neverLowered = 'const readyRef = useRef(true);';

    expect(findOneWayRefs(broken)).toEqual(['mountedRef']);
    expect(findOneWayRefs(brokenRenamed)).toEqual(['editorMountedRef']);
    expect(findOneWayRefs(fixed)).toEqual([]);
    expect(findOneWayRefs(fixedLogicalAssign)).toEqual([]);
    expect(findOneWayRefs(neverLowered)).toEqual([]);
  });
});
