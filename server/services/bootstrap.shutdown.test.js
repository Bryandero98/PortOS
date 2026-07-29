/**
 * Source contract for the graceful-shutdown handler's host-restart bookkeeping (#3202).
 *
 * `registerShutdownHandlers` has no unit harness — it wires real signal handlers
 * around a live HTTP/Socket.IO/DB stack — so the two ordering guarantees it must
 * uphold are asserted against the source instead. Both are the kind of thing a
 * well-meaning refactor silently breaks:
 *
 *   1. `markHostShuttingDown()` runs BEFORE the handler's first `await`. pm2's
 *      TreeKill signals the whole tree at once, so an agent PTY can exit during
 *      the very first await — and if the flag isn't latched yet, that exit is
 *      recorded as a completed run, which is the bug this issue is about.
 *   2. The marker is built from `activeAgents` (the agents THIS process owns),
 *      not from `getActiveAgentIds()` — runner-mode agents live in portos-cos,
 *      survive the restart untouched, and must never be named as interrupted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'bootstrap.js'), 'utf-8').replace(/\r\n/g, '\n');

/**
 * Slice out a function body by brace-matching from its opening `{`. A fixed
 * character window would read into whatever happens to follow — the trap noted
 * in the repo's other source-contract guards.
 */
function bodyAfter(source, anchor) {
  const start = source.indexOf(anchor);
  expect(start, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${anchor}`);
}

/** Blank out comments so prose about `await` isn't mistaken for code. */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

describe('shutdown handler — host-restart bookkeeping (#3202)', () => {
  const shutdownBody = bodyAfter(SRC, 'const shutdown = async (signal) =>');

  it('latches the host-shutdown flag before the handler awaits anything', () => {
    const code = stripComments(shutdownBody);
    const latchAt = code.indexOf('markHostShuttingDown()');
    expect(latchAt, 'markHostShuttingDown() is not called in shutdown()').toBeGreaterThan(-1);

    const firstAwaitAt = code.search(/\bawait\b/);
    // No await at all would also satisfy the ordering requirement.
    if (firstAwaitAt > -1) expect(latchAt).toBeLessThan(firstAwaitAt);
  });

  it('writes the marker from activeAgents only — runner agents survive the restart', () => {
    expect(shutdownBody).toContain('writeHostShutdownMarker(');
    expect(shutdownBody).toMatch(/writeHostShutdownMarker\(\{\s*agentIds:\s*\[\.\.\.activeAgents\.keys\(\)\]/);
    // getActiveAgentIds() folds in runnerAgents — naming those would tell the
    // next boot that portos-cos-owned agents were interrupted when they weren't.
    expect(shutdownBody).not.toContain('getActiveAgentIds');
  });

  it('writes the marker before the process exits', () => {
    expect(shutdownBody.indexOf('writeHostShutdownMarker('))
      .toBeLessThan(shutdownBody.indexOf('process.exit(0)'));
  });
});
