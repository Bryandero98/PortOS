import { describe, expect, it } from 'vitest';

import { BIOME_BIN, LINT_MODES, buildLintArgs, selectClientFiles } from './run-ci-lint.js';

describe('CI client lint runner', () => {
  it('lints the whole client src tree in full mode', () => {
    expect(buildLintArgs({ mode: 'full' })).toEqual(['lint', '--error-on-warnings', 'src']);
  });

  it('lints only the changed files in files mode, tolerating unmatched paths', () => {
    expect(buildLintArgs({
      mode: 'files',
      clientFiles: ['src/pages/Dashboard.jsx', 'src/lib/uuid.js'],
    })).toEqual([
      'lint',
      '--error-on-warnings',
      '--no-errors-on-unmatched',
      'src/pages/Dashboard.jsx',
      'src/lib/uuid.js',
    ]);
  });

  it('keeps only client/src JavaScript, stripping the workspace prefix', () => {
    expect(selectClientFiles([
      'client/src/pages/Dashboard.jsx',
      'client/src/lib/uuid.js',
      'client/src/components/Deep/Nested.JSX',
      'server/services/backup.js',
      'client/vite.config.js',
      'client/src/styles.css',
      'client/src/types.ts',
      'docs/DEPS.md',
    ])).toEqual([
      'src/pages/Dashboard.jsx',
      'src/lib/uuid.js',
      'src/components/Deep/Nested.JSX',
    ]);
  });

  it('supports exactly the two documented modes', () => {
    expect(LINT_MODES).toEqual(['files', 'full']);
  });

  // Regression guard for the ESLint -> Biome migration: the runner must not go
  // looking for the removed eslint bin, and must not pass eslint-only flags
  // (`--ext` is not a Biome flag and makes it exit non-zero).
  it('invokes biome, not eslint', () => {
    expect(BIOME_BIN).toContain('@biomejs');
    expect(BIOME_BIN).not.toContain('eslint');
    for (const mode of LINT_MODES) {
      const args = buildLintArgs({ mode, clientFiles: ['src/a.js'] });
      expect(args).not.toContain('--ext');
      expect(args[0]).toBe('lint');
    }
  });
});
