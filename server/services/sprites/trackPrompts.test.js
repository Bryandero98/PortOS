/**
 * Per-track i2v prompt resolution (#3136, #3152).
 *
 * Two things are proven here, and the first is the load-bearing one:
 *
 * 1. **The seeded templates are byte-identical to the compiled builders they
 *    replaced.** #3152 demoted `scanner` and `ambient` from compiled rows to store
 *    rows, which moved their wording from `prompts.js` code into a
 *    `promptTemplate` string. That is only a safe refactor if the bytes sent to
 *    the provider are unchanged — a template that dropped a clause, mangled a
 *    placeholder, or reordered the correction note would render a subtly different
 *    animation and pass every other check, because nothing downstream re-reads
 *    what was asked for. So this compares `buildTrackVideoPrompt` (template path)
 *    against `buildScannerPrompt`/`buildAmbientVideoPrompt` (the compiled builders
 *    kept exported precisely as this reference) across the argument space that
 *    varies the output: chroma key form, facing, record kind, and the correction
 *    clause. `prompts.test.js` still pins the builders' own wording, so the two
 *    suites together pin the templates to reviewed text rather than to themselves.
 *
 * 2. **A user-defined row resolves through its own template**, with the
 *    placeholder and unknown-track rules the resolver promises.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { storedTrackRow, expectCarriesCorrection } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-track-prompts-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, { data: TEST_ROOT, sprites: join(TEST_ROOT, 'sprites') });
  return actual;
});

const {
  buildTrackVideoPrompt, tryBuildTrackVideoPrompt, renderPromptTemplate,
} = await import('./trackPrompts.js');
const {
  buildWalkVideoPrompt, buildScannerPrompt, buildAmbientVideoPrompt,
} = await import('./prompts.js');
const { WALK_TRACK, SCANNER_TRACK, AMBIENT_TRACK } = await import('./animationTracks.js');
const {
  __resetAnimationTrackStore, animationTrackStorePath, ANIMATION_TRACK_STORE_SCHEMA_VERSION,
} = await import('./animationTrackStore.js');

const STORE_PATH = animationTrackStorePath();

const writeTracks = (tracks) => {
  mkdirSync(join(TEST_ROOT, 'sprites'), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify({
    schemaVersion: ANIMATION_TRACK_STORE_SCHEMA_VERSION, tracks,
  }, null, 2));
};

beforeEach(() => {
  rmSync(STORE_PATH, { force: true });
  __resetAnimationTrackStore();
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

// The argument space that actually varies these prompts. Each seeded template
// interpolates a DIFFERENT chroma form (scanner embeds the bare hex, ambient the
// named phrase), so both keys are exercised — a template that used the wrong
// variable would change one prompt on the wire and this is what catches it.
const ARG_CASES = [
  { label: 'magenta key', args: { name: 'Placeholder Hero', kind: 'character', direction: 'east', chromaKey: '#FF00FF' } },
  { label: 'green key', args: { name: 'Example Willow', kind: 'place', direction: 'south', chromaKey: '#00FF00' } },
  {
    label: 'with a correction note',
    args: {
      name: 'Placeholder Hero', kind: 'character', direction: 'north-west', chromaKey: '#FF00FF',
      correctionPrompt: 'the sweep never returns to the start pose',
    },
  },
  {
    // A whitespace-only note must leave the prompt byte-identical to a blind
    // regenerate — the hard contract `correctionClause` promises, which the
    // template path has to inherit rather than re-implement.
    label: 'with a blank correction note',
    args: { name: 'Example Willow', kind: 'object', direction: 'south', chromaKey: '#00FF00', correctionPrompt: '   ' },
  },
  {
    // An unrecognized chroma hex falls back inside `keyColorPhrase`; both paths
    // must make the same fallback or the ambient wording diverges.
    label: 'with an unnamed chroma hex',
    args: { name: 'Example Willow', kind: 'place', direction: 'south', chromaKey: '#123456' },
  },
];

describe('the seeded templates reproduce the compiled builders exactly (#3152)', () => {
  it.each(ARG_CASES)('scanner — $label', ({ args }) => {
    expect(buildTrackVideoPrompt(SCANNER_TRACK, args)).toBe(buildScannerPrompt(args));
  });

  it.each(ARG_CASES)('ambient — $label', ({ args }) => {
    expect(buildTrackVideoPrompt(AMBIENT_TRACK, args)).toBe(buildAmbientVideoPrompt(args));
  });

  it('is not vacuous — the two tracks\' prompts genuinely differ', () => {
    // Guards the assertions above against the failure mode where every builder
    // returns the same string (or an empty one) and equality proves nothing.
    const args = ARG_CASES[0].args;
    const scanner = buildTrackVideoPrompt(SCANNER_TRACK, args);
    const ambient = buildTrackVideoPrompt(AMBIENT_TRACK, args);
    expect(scanner).not.toBe(ambient);
    expect(scanner).toContain('scanner');
    expect(ambient).toContain('ambient loop');
    expect(scanner.length).toBeGreaterThan(100);
  });

  it('routes walk through its COMPILED builder, not a template', () => {
    // Walk is the one built-in, so its wording must still come from code — a
    // stored template shadowing it would move the mandatory baseline's prompt out
    // of the reviewed catalog.
    const args = ARG_CASES[0].args;
    expect(buildTrackVideoPrompt(WALK_TRACK, args)).toBe(buildWalkVideoPrompt(args));
  });
});

describe('a user-defined row resolves through its own template', () => {
  // The shared stored-row shape (spriteTestFixtures.js) with only the fields this
  // suite cares about overridden — the template (every placeholder, both chroma
  // forms) and `kinds: ['character']`, so walk stays `character`'s baseline and the
  // merged table still validates.
  const CUSTOM = storedTrackRow({
    id: 'jetpack-burst',
    label: 'Jetpack burst',
    directional: true,
    kinds: ['character'],
    contractFrameCountField: 'jetpackBurstFrameCount',
    selectionKind: 'reviewed-jetpack-burst-selection',
    setKind: 'finalized-jetpack-burst-set',
    finalErrorCode: 'JETPACK_BURST_SET_FINAL',
    standaloneContract: false,
    promptTemplate: 'Animate {{name}} ({{kind}}) firing a jetpack burst while facing {{direction}}. Matte: {{chromaKeyPhrase}} / raw {{chromaKey}}.',
  });

  it('interpolates every supported placeholder', () => {
    writeTracks([CUSTOM]);
    expect(buildTrackVideoPrompt('jetpack-burst', {
      name: 'Placeholder Hero', kind: 'character', direction: 'east', chromaKey: '#FF00FF',
    })).toBe(
      'Animate Placeholder Hero (character) firing a jetpack burst while facing east. '
      + 'Matte: magenta (#FF00FF) / raw #FF00FF.',
    );
  });

  it('wraps a user template in the same correction sandwich as every compiled builder', () => {
    // Not a placeholder on purpose: a correction has to frame the render up front
    // and override it at the end, so a template that interpolated it mid-sentence
    // would bury it — the failure #3216 fixed.
    writeTracks([CUSTOM]);
    const prompt = buildTrackVideoPrompt('jetpack-burst', {
      name: 'Placeholder Hero', kind: 'character', direction: 'east', chromaKey: '#FF00FF',
      correctionPrompt: 'more flame, less smoke',
    });
    expectCarriesCorrection(expect, prompt, 'more flame, less smoke');
    // The template body sits BETWEEN the two halves, not after them.
    expect(prompt.indexOf('jetpack burst')).toBeGreaterThan(prompt.indexOf('Required fix:'));
    expect(prompt.trimEnd().endsWith('stays as the attached source image shows it.')).toBe(true);
  });

  it('rebuilds a known track and answers null for an unknown one (tryBuild…)', () => {
    // The provenance-rebuild path in `assetPrompt.js`: a run may name a track a
    // newer peer wrote, or one whose row the user has since deleted. Only that case
    // becomes `null`; a known track still returns its real prompt.
    writeTracks([CUSTOM]);
    const args = { name: 'Placeholder Hero', kind: 'character', direction: 'east', chromaKey: '#FF00FF' };
    expect(tryBuildTrackVideoPrompt('jetpack-burst', args)).toContain('jetpack burst');
    expect(tryBuildTrackVideoPrompt(WALK_TRACK, args)).toBe(buildWalkVideoPrompt(args));
    expect(tryBuildTrackVideoPrompt('never-registered', args)).toBeNull();
  });

  it('throws for a track neither compiled nor stored, naming what IS known', () => {
    // The unknown-id boundary: silently sending walk's wording would render a
    // gait loop that passes every later check.
    writeTracks([CUSTOM]);
    expect(() => buildTrackVideoPrompt('never-registered', {})).toThrow(/never-registered/);
    expect(() => buildTrackVideoPrompt('never-registered', {})).toThrow(/jetpack-burst/);
  });
});

describe('renderPromptTemplate', () => {
  const args = { name: 'Placeholder Hero', kind: 'character', direction: 'east', chromaKey: '#FF00FF' };

  it('leaves an UNKNOWN placeholder literal rather than blanking it', () => {
    // A visible `{{drection}}` is a typo the user can find and fix; a silently
    // dropped clause reads as the model ignoring their instruction.
    expect(renderPromptTemplate('facing {{drection}} now', args)).toBe('facing {{drection}} now');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderPromptTemplate('{{ name }} and {{name}}', args)).toBe('Placeholder Hero and Placeholder Hero');
  });

  it('renders an absent value as empty rather than as "undefined"', () => {
    expect(renderPromptTemplate('[{{direction}}]', { name: 'x' })).toBe('[]');
  });

  it('does not interpolate inherited Object keys', () => {
    expect(renderPromptTemplate('{{toString}}', args)).toBe('{{toString}}');
  });
});
