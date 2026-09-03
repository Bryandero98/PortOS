/**
 * Build the CoS task payload for the "Queue agent to investigate" action on an
 * installer failure (#5981).
 *
 * Every installer failure surface (`Flux2InstallModal`, `RuntimeInstallModal`
 * and its six call sites, `LocalSetupPanel`) reaches this one builder so the
 * queued task always carries the same reproducible context: which installer
 * failed, the stage it died on, the error text, and the tail of the streamed
 * install log — enough for an agent to work the failure without the user
 * re-typing anything.
 *
 * Pure: no React, no network. The caller hands the result straight to
 * `addCosTask`.
 */

// Keep the log tail large enough to hold a pip/bash traceback but small enough
// that a chatty 1000-line install stream can't push a multi-hundred-KB body
// through `POST /api/cos/tasks`.
export const INSTALL_FAILURE_LOG_TAIL_LINES = 80;
export const INSTALL_FAILURE_LOG_TAIL_CHARS = 6000;

const TRUNCATION_NOTE = '… (earlier log lines omitted)';

/**
 * Render the tail of a `useInstallStream` log array as plain text.
 * Accepts the hook's `{ kind, text }` entries as well as bare strings.
 * @param {Array<{ text?: string }|string>} logs
 * @returns {string} '' when there is nothing to show.
 */
export function installLogTail(logs) {
  if (!Array.isArray(logs)) return '';
  const lines = logs
    .map(entry => (typeof entry === 'string' ? entry : entry?.text))
    .filter(text => typeof text === 'string' && text.trim() !== '');
  if (lines.length === 0) return '';
  const truncatedByLine = lines.length > INSTALL_FAILURE_LOG_TAIL_LINES;
  let tail = lines.slice(-INSTALL_FAILURE_LOG_TAIL_LINES).join('\n');
  let truncatedByChar = false;
  if (tail.length > INSTALL_FAILURE_LOG_TAIL_CHARS) {
    tail = tail.slice(-INSTALL_FAILURE_LOG_TAIL_CHARS);
    truncatedByChar = true;
  }
  return truncatedByLine || truncatedByChar ? `${TRUNCATION_NOTE}\n${tail}` : tail;
}

const cleanLabel = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {object} input
 * @param {string} [input.label] - human name of the thing being installed ("FLUX.2 Runtime", "TRELLIS.2").
 * @param {string} [input.stage] - `currentStage` from `useInstallStream`, when the surface tracks stages.
 * @param {string} [input.error] - the hook's `error` string.
 * @param {Array} [input.logs] - the hook's `logs` array.
 * @param {string} [input.surface] - repo path of the UI that failed, so the agent starts in the right file.
 * @returns {{ description: string, prompt: string }} ready for `addCosTask`.
 */
export function buildInstallFailureTask({ label, stage, error, logs, surface } = {}) {
  const name = cleanLabel(label) || 'PortOS';
  const failedStage = cleanLabel(stage);
  const message = cleanLabel(error) || 'Installer failed with no error message.';
  const description = failedStage
    ? `Fix ${name} installer failure at the ${failedStage} stage`
    : `Fix ${name} installer failure`;

  const tail = installLogTail(logs);
  const sections = [
    `The ${name} installer failed in the PortOS UI. Investigate the root cause and fix it.`,
    '',
    `Installer: ${name}`,
    `Failing stage: ${failedStage || '(not reported)'}`,
    `Error: ${message}`,
  ];
  if (cleanLabel(surface)) sections.push(`Reported from: ${cleanLabel(surface)}`);
  if (tail) sections.push('', 'Install log tail:', '```', tail, '```');
  sections.push(
    '',
    'Reproduce the failure, find why the install step fails on this machine, and fix the installer (script, dependency pin, or error handling) so it succeeds or reports an actionable message.',
  );

  return { description, prompt: sections.join('\n') };
}
