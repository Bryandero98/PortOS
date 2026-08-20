import { describe, expect, it } from 'vitest';
import { runStreamingCommand } from './streamingSpawn.js';

const NODE = process.execPath;

describe('runStreamingCommand', () => {
  it('streams stdout and stderr lines in order and resolves success on exit 0', async () => {
    const lines = [];
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.log("one"); console.error("two"); console.log("three")'],
      (line) => lines.push(line),
    );

    expect(result).toEqual({ success: true });
    expect(lines).toContain('one');
    expect(lines).toContain('two');
    expect(lines).toContain('three');
  });

  it('carries the tail of the output into a non-zero exit, not just the code', async () => {
    // The whole reason for the tail: `brew upgrade ollama` exits 1 saying
    // "Error: ollama not installed", and "exited with code 1" is not a fix.
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.error("Error: ollama not installed"); process.exit(1)'],
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exit 1: .*ollama not installed/);
  });

  it('resolves rather than rejecting when the binary does not exist', async () => {
    // Callers run outside the Express request lifecycle — a rejection here
    // would surface as an unhandled rejection, not as a 500.
    const result = await runStreamingCommand('portos-no-such-binary-xyz', ['--version']);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('kills a command that outruns its timeout', async () => {
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'setTimeout(() => {}, 10000)'],
      undefined,
      { timeoutMs: 150 },
    );
    expect(result).toEqual({ success: false, error: 'timed out after 0s' });
  });

  it('survives a throwing output hook instead of taking the process down', async () => {
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'console.log("boom")'],
      () => { throw new Error('hook exploded'); },
    );
    expect(result).toEqual({ success: true });
  });
});

describe('runStreamingCommand — stream separation', () => {
  it('keeps stdout and stderr lines intact when partial chunks interleave', async () => {
    // One buffer shared by both streams splices a half-written stdout line into
    // the next stderr chunk: the caller sees `OUT-ERR-one` and loses both real
    // lines. `server/lib/README.md` states the rule this pins — one line reader
    // per stream.
    const lines = [];
    const result = await runStreamingCommand(
      NODE,
      ['-e', 'process.stdout.write("OUT-"); process.stderr.write("ERR-"); process.stdout.write("one\\n"); process.stderr.write("two\\n")'],
      (line) => lines.push(line),
    );

    expect(result).toEqual({ success: true });
    expect(lines).toContain('OUT-one');
    expect(lines).toContain('ERR-two');
  });
});
