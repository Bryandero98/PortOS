/**
 * GitHub Actions step-output/summary append helpers for CI scripts.
 *
 * ZERO external dependencies — these run in jobs that have not installed
 * anything yet. Do NOT import from server/lib or any installed package.
 */

import { appendFileSync } from 'fs';

/**
 * Append `name=value` to $GITHUB_OUTPUT, or do nothing outside Actions.
 *
 * Newlines and carriage returns are stripped: the `name=value` form has no
 * escape, so an embedded newline silently truncates the value and lets the
 * remainder forge a second output. Callers that render a value as markdown
 * should sanitize further at their own call site.
 *
 * @param {string} name - output name
 * @param {unknown} value - stringified before writing
 */
export function writeStepOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`);
}
