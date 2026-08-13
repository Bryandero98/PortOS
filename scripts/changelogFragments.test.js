/**
 * Covers the conflict-free changelog fragment scheme, plus two drift guards
 * over the repo itself:
 *
 *   - every fragment currently sitting in `.changelog/next/` is well-formed, so
 *     a typo'd filename fails in CI rather than at release time when the entry
 *     would silently miss the notes (this file is in ALWAYS_RUN_TESTS so a
 *     changelog-only PR actually runs it);
 *   - `.gitattributes` unions the fragments and, deliberately, NOT `NEXT.md` —
 *     union there silently revives a whole previous release across the
 *     `/do:release` rename. The guard pins both halves of that decision.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendToSection,
  collectFragments,
  parseFragmentName,
  readFragments,
  REPO_ROOT,
  SECTIONS,
  slugFromBranch,
  slugify,
  toBullets,
  writeFragment,
} from './changelogFragments.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'portos-changelog-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name, body) => writeFileSync(join(dir, name), body);

describe('parseFragmentName', () => {
  it('accepts a known section prefix with a dashed slug', () => {
    expect(parseFragmentName('fixed-issue-3916.md')).toEqual({ section: 'fixed', slug: 'issue-3916' });
    expect(parseFragmentName('added-agent-d3651f27.md')).toEqual({ section: 'added', slug: 'agent-d3651f27' });
  });

  it('rejects an unknown section, a missing slug, and a non-markdown file', () => {
    expect(parseFragmentName('deprecated-thing.md')).toBeNull();
    expect(parseFragmentName('fixed-.md')).toBeNull();
    expect(parseFragmentName('fixed-thing.txt')).toBeNull();
    expect(parseFragmentName('Fixed-Thing.md')).toBeNull();
  });
});

describe('slug derivation', () => {
  it('takes the last branch segment, which is unique per agent or claim', () => {
    expect(slugFromBranch('claim/issue-3916')).toBe('issue-3916');
    expect(slugFromBranch('cos/task-msrknq4w/agent-d3651f27')).toBe('agent-d3651f27');
    expect(slugFromBranch('main')).toBe('main');
  });

  it('returns empty for a branch that yields nothing usable, so callers can fall back', () => {
    expect(slugFromBranch('')).toBe('');
    expect(slugFromBranch('///')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('normalizes mixed case and punctuation', () => {
    expect(slugify('Fix The_Thing (again)')).toBe('fix-the-thing-again');
  });
});

describe('toBullets', () => {
  it('wraps bare prose as a single bullet and flattens its newlines', () => {
    expect(toBullets('The thing\nno longer breaks.')).toEqual(['- The thing no longer breaks.']);
  });

  it('preserves an existing bullet list and normalizes the marker', () => {
    expect(toBullets('- one\n\n* two\n')).toEqual(['- one', '- two']);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(toBullets('   \n  ')).toEqual([]);
  });
});

describe('appendToSection', () => {
  it('appends under an existing heading without disturbing the others', () => {
    const before = '## Added\n\n- first\n\n## Fixed\n\n- a fix\n';
    expect(appendToSection(before, 'added', ['- second'])).toBe(
      '## Added\n\n- first\n- second\n\n## Fixed\n\n- a fix\n'
    );
  });

  it('creates a missing section in canonical order rather than at the end', () => {
    const after = appendToSection('## Added\n\n- a\n\n## Fixed\n\n- f\n', 'changed', ['- c']);
    expect(after).toBe('## Added\n\n- a\n\n## Changed\n\n- c\n\n## Fixed\n\n- f\n');
  });

  it('appends a section that sorts last when nothing follows it', () => {
    expect(appendToSection('## Added\n\n- a\n', 'removed', ['- r'])).toBe('## Added\n\n- a\n\n## Removed\n\n- r\n');
  });

  it('builds the file from scratch when the changelog is empty', () => {
    expect(appendToSection('', 'fixed', ['- f'])).toBe('## Fixed\n\n- f\n');
  });

  it('keeps an unknown heading and any preamble in place', () => {
    const before = '# Release v9.9.9\n\n## Overview\n\nA release.\n\n## Fixed\n\n- f\n';
    expect(appendToSection(before, 'fixed', ['- g'])).toBe(
      '# Release v9.9.9\n\n## Overview\n\nA release.\n\n## Fixed\n\n- f\n- g\n'
    );
  });

  it('is a no-op when there are no bullets to add', () => {
    expect(appendToSection('## Added\n\n- a\n', 'fixed', [])).toBe('## Added\n\n- a\n');
  });
});

describe('readFragments', () => {
  it('sorts by filename so collection is deterministic across installs', () => {
    write('fixed-zeta.md', '- z');
    write('fixed-alpha.md', '- a');
    expect(readFragments(dir).fragments.map((f) => f.slug)).toEqual(['alpha', 'zeta']);
  });

  it('reports malformed and empty fragments instead of silently dropping them', () => {
    write('fixed-ok.md', '- ok');
    write('notes.md', '- stray');
    write('fixed-blank.md', '   \n');
    const { fragments, invalid } = readFragments(dir);
    expect(fragments.map((f) => f.slug)).toEqual(['ok']);
    expect(invalid.sort()).toEqual(['fixed-blank.md', 'notes.md']);
  });

  it('ignores dotfiles such as .gitkeep', () => {
    write('.gitkeep', '');
    expect(readFragments(dir).invalid).toEqual([]);
  });

  it('returns empty for a directory that does not exist yet', () => {
    expect(readFragments(join(dir, 'absent'))).toEqual({ fragments: [], invalid: [] });
  });
});

describe('collectFragments', () => {
  it('folds every section into the target and deletes the fragments', async () => {
    const target = join(dir, 'NEXT.md');
    writeFileSync(target, '## Fixed\n\n- existing\n');
    write('fixed-b.md', '- second fix');
    write('added-a.md', '- a feature');
    write('removed-c.md', '- a removal');

    const result = await collectFragments({ dir, target });

    expect(result.collected).toBe(3);
    expect(readFileSync(target, 'utf8')).toBe(
      '## Added\n\n- a feature\n\n## Fixed\n\n- existing\n- second fix\n\n## Removed\n\n- a removal\n'
    );
    // The fragments are gone, so a second collect cannot duplicate them.
    expect(readdirSync(dir)).toEqual(['NEXT.md']);
  });

  it('creates the target when a release has already consumed NEXT.md', async () => {
    const target = join(dir, 'NEXT.md');
    write('added-a.md', '- a feature');
    await collectFragments({ dir, target });
    expect(readFileSync(target, 'utf8')).toBe('## Added\n\n- a feature\n');
  });

  it('leaves everything alone under keep, so a preview cannot lose an entry', async () => {
    const target = join(dir, 'NEXT.md');
    writeFileSync(target, '## Fixed\n\n- existing\n');
    write('fixed-a.md', '- new');

    const result = await collectFragments({ dir, target, keep: true });

    expect(result.markdown).toContain('- new');
    expect(readFileSync(target, 'utf8')).toBe('## Fixed\n\n- existing\n');
    expect(existsSync(join(dir, 'fixed-a.md'))).toBe(true);
  });

  it('collects the valid fragments even when one is malformed', async () => {
    const target = join(dir, 'NEXT.md');
    write('fixed-good.md', '- good');
    write('bogus.md', '- bogus');

    const result = await collectFragments({ dir, target });

    expect(result.collected).toBe(1);
    expect(result.invalid).toEqual(['bogus.md']);
    expect(readFileSync(target, 'utf8')).toBe('## Fixed\n\n- good\n');
    expect(existsSync(join(dir, 'bogus.md'))).toBe(true);
  });

  it('preserves the guidance comment NEXT.md carries above its first heading', async () => {
    const target = join(dir, 'NEXT.md');
    writeFileSync(target, '<!-- write a fragment, do not append here -->\n\n## Fixed\n\n- existing\n');
    write('fixed-a.md', '- new');
    await collectFragments({ dir, target });
    expect(readFileSync(target, 'utf8')).toBe(
      '<!-- write a fragment, do not append here -->\n\n## Fixed\n\n- existing\n- new\n'
    );
  });

  it('is a no-op with nothing to collect', async () => {
    const target = join(dir, 'NEXT.md');
    writeFileSync(target, '## Fixed\n\n- existing\n');
    expect((await collectFragments({ dir, target })).collected).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe('## Fixed\n\n- existing\n');
  });
});

describe('writeFragment', () => {
  it('writes a bullet for a bare sentence', async () => {
    const { path, appended } = await writeFragment({ section: 'fixed', slug: 'issue-1', text: 'It works.', dir });
    expect(appended).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('- It works.\n');
  });

  it('appends to the same branch fragment instead of minting a second file', async () => {
    await writeFragment({ section: 'fixed', slug: 'issue-1', text: 'First.', dir });
    const { path, appended } = await writeFragment({ section: 'fixed', slug: 'issue-1', text: 'Second.', dir });
    expect(appended).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('- First.\n- Second.\n');
    expect(readdirSync(dir)).toEqual(['fixed-issue-1.md']);
  });

  it('refuses an unknown section, an unusable slug, and empty text', async () => {
    await expect(writeFragment({ section: 'deprecated', slug: 'a', text: 'x', dir })).rejects.toThrow(
      /Unknown changelog section/
    );
    await expect(writeFragment({ section: 'fixed', slug: '-bad-', text: 'x', dir })).rejects.toThrow(
      /Unusable changelog slug/
    );
    await expect(writeFragment({ section: 'fixed', slug: 'a', text: '  ', dir })).rejects.toThrow(
      /empty changelog entry/
    );
  });

  it('round-trips through readFragments for every section', async () => {
    for (const section of SECTIONS) await writeFragment({ section, slug: 'x', text: `${section} entry`, dir });
    const { fragments, invalid } = readFragments(dir);
    expect(invalid).toEqual([]);
    expect(fragments.map((f) => f.section).sort()).toEqual([...SECTIONS].sort());
  });
});

describe('repo guards', () => {
  it('every fragment checked into .changelog/next is well-formed', () => {
    expect(readFragments().invalid).toEqual([]);
  });

  it('.gitattributes unions the fragments but never the NEXT.md accumulator', () => {
    const gitattributes = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
    expect(gitattributes).toMatch(/^\.changelog\/next\/\*\.md\s+merge=union$/m);
    // Union on NEXT.md resolves the modify/modify a branch outliving a
    // /do:release produces by keeping BOTH sides, which silently republishes
    // the previous release's whole changelog. A conflict there is correct.
    expect(gitattributes).not.toMatch(/^\.changelog\/NEXT\.md\s+merge=union$/m);
  });

  it('the fragment guard runs on every CI plan, including a changelog-only PR', async () => {
    const { ALWAYS_RUN_TESTS } = await import('./ci-test-plan.js');
    expect(ALWAYS_RUN_TESTS).toContain('scripts/changelogFragments.test.js');
  });

  it('the collect and add entry points are wired as npm scripts', () => {
    const { scripts } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(scripts['changelog:add']).toContain('changelog-add.js');
    expect(scripts['changelog:collect']).toContain('changelog-collect.js');
    expect(scripts['changelog:preview']).toContain('--preview');
  });
});
