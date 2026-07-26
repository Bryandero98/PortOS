#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const mode = process.env.CI_LINT_MODE || 'full';
const repoFiles = JSON.parse(process.env.CI_LINT_FILES || '[]');
const clientFiles = repoFiles
  .filter((path) => /^client\/src\/.*\.(?:js|jsx)$/i.test(path))
  .map((path) => path.replace(/^client\//, ''));

if (mode === 'files' && clientFiles.length === 0) {
  console.log('No changed client JavaScript files require linting.');
  process.exit(0);
}
if (!['files', 'full'].includes(mode)) {
  console.error(`Unsupported CI lint mode: ${mode}`);
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslintBin = join(repoRoot, 'client', 'node_modules', 'eslint', 'bin', 'eslint.js');
const args = mode === 'full'
  ? [eslintBin, 'src', '--ext', '.js,.jsx']
  : [eslintBin, ...clientFiles];

console.log(`Running client lint in ${mode} mode${mode === 'files' ? ` (${clientFiles.length} file(s))` : ''}.`);
const result = spawnSync(process.execPath, args, {
  cwd: join(repoRoot, 'client'),
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
