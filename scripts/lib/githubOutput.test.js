import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeStepOutput } from './githubOutput.js';

describe('writeStepOutput', () => {
  let outputPath;
  const previous = process.env.GITHUB_OUTPUT;

  beforeEach(() => {
    outputPath = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'output.txt');
    writeFileSync(outputPath, '');
    process.env.GITHUB_OUTPUT = outputPath;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
  });

  it('appends one name=value line per call', () => {
    writeStepOutput('verified', true);
    writeStepOutput('reason', 'identical tree');

    expect(readFileSync(outputPath, 'utf8')).toBe('verified=true\nreason=identical tree\n');
  });

  it('strips newlines so a value cannot forge a second output', () => {
    writeStepOutput('reason', 'first line\nverified=true');

    expect(readFileSync(outputPath, 'utf8')).toBe('reason=first line verified=true\n');
  });

  it('does nothing outside GitHub Actions', () => {
    delete process.env.GITHUB_OUTPUT;

    expect(() => writeStepOutput('verified', false)).not.toThrow();
    expect(readFileSync(outputPath, 'utf8')).toBe('');
  });
});
