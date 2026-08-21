import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeStepEnv, writeStepOutput } from './githubOutput.js';

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

describe('writeStepEnv', () => {
  let envPath;
  const previous = process.env.GITHUB_ENV;

  beforeEach(() => {
    envPath = join(mkdtempSync(join(tmpdir(), 'gh-env-')), 'env.txt');
    writeFileSync(envPath, '');
    process.env.GITHUB_ENV = envPath;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = previous;
  });

  it('appends one name=value line per call', () => {
    writeStepEnv('CI_BASE_SHA', 'abc123');

    expect(readFileSync(envPath, 'utf8')).toBe('CI_BASE_SHA=abc123\n');
  });

  it('strips newlines so a value cannot forge a second variable', () => {
    writeStepEnv('CI_BASE_SHA', 'abc123\nPATH=/evil');

    expect(readFileSync(envPath, 'utf8')).toBe('CI_BASE_SHA=abc123 PATH=/evil\n');
  });

  it('writes to GITHUB_ENV, not GITHUB_OUTPUT', () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'output.txt');
    writeFileSync(outputPath, '');
    const previousOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputPath;

    writeStepEnv('CI_BASE_SHA', 'abc123');

    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    expect(readFileSync(outputPath, 'utf8')).toBe('');
    expect(readFileSync(envPath, 'utf8')).toBe('CI_BASE_SHA=abc123\n');
  });

  it('does nothing outside GitHub Actions', () => {
    delete process.env.GITHUB_ENV;

    expect(() => writeStepEnv('CI_BASE_SHA', 'abc123')).not.toThrow();
    expect(readFileSync(envPath, 'utf8')).toBe('');
  });
});
