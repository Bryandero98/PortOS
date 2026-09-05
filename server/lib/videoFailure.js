/** Bounded, local-only video failure summaries shared by the runner and queue. */
import { scrubSecretTokens } from './secretText.js';

const MAX_TAIL_BYTES = 8192;
const MAX_CAUSE_LENGTH = 240;

// Only diagnostic-shaped lines qualify. Progress, prompts, JSON and bare exit
// codes cannot establish a repeated engine failure.
export function normalizeVideoFailure(error, { prompts = [] } = {}) {
  if (typeof error !== 'string') return null;
  let text = error.slice(-MAX_TAIL_BYTES).replace(/\x1b\[[0-9;]*m/g, '');
  for (const prompt of prompts.filter((p) => typeof p === 'string' && p)) {
    text = text.replaceAll(prompt, '[prompt]');
  }
  const missing = text.match(/(?:No module named|Python module) ['"]([\w.]+)['"]/);
  if (missing) return { classification: 'missing-module', cause: `Python module ${missing[1].slice(0, 128)} is missing` };
  if (/\b(?:CUDA|Metal|MPS|GPU).*out of memory|out of memory.*\b(?:CUDA|Metal|MPS|GPU)/i.test(text)) {
    return { classification: 'out-of-memory', cause: 'GPU memory exhausted' };
  }
  if (/Metal command-buffer watchdog|kIOGPUCommandBufferCallbackErrorImpactingInteractivity/.test(text)) {
    return { classification: 'metal-watchdog', cause: 'Metal command-buffer watchdog stopped the render' };
  }
  if (/watchdog timeout: no runner output/.test(text)) {
    return { classification: 'idle-timeout', cause: 'Video runtime stopped reporting progress' };
  }
  if (/\b(?:ENOENT|EACCES)\b/.test(text) && /spawn/i.test(text)) {
    const code = text.match(/\b(ENOENT|EACCES)\b/)[1];
    return { classification: 'runtime-launch', cause: `Video runtime could not start (${code})` };
  }
  if (/python.*not configured/i.test(text)) {
    return { classification: 'runtime-configuration', cause: 'Python runtime is not configured' };
  }
  const exception = text.match(/(?:^|\n|Exit code \d+:\s*|runJob threw:\s*)([\w.]*?(?:Error|Exception)):\s*([^\r\n]+)/);
  if (!exception) return null;
  const cause = scrubSecretTokens(exception[2])
    // Drop URL, credential assignments, quoted payloads and machine paths.
    .replace(/\b(?:https?|file):\/\/\S+/gi, '[url]')
    .replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, '[credential]')
    .replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '[value]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?!\s))[^\s,;)]*/g, '[path]')
    .replace(/\bprompt\b.*$/i, '[prompt]')
    .replace(/\b0x[\da-f]+\b/gi, '[address]')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_CAUSE_LENGTH);
  if (!/[a-z]{3}/i.test(cause.replace(/\[[^\]]*\]/g, ''))) return null;
  return { classification: exception[1].toLowerCase().slice(0, 128), cause };
}

export function createVideoDiagnosticTail() {
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  return {
    push(stream, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      tails[stream] = Buffer.concat([tails[stream], bytes.subarray(-MAX_TAIL_BYTES)]).subarray(-MAX_TAIL_BYTES);
    },
    summary(options) {
      // Prefer the final stderr exception; some runtimes only use stdout.
      for (const stream of ['stderr', 'stdout']) {
        const lines = tails[stream].toString('utf8').split(/[\r\n]+/).slice(-40).reverse();
        for (const line of lines) {
          if (!/^(?:[\w.]*?(?:Error|Exception)):\s/.test(line.trim())) continue;
          const failure = normalizeVideoFailure(line.trim(), options);
          if (failure) return `${line.trim().split(':')[0]}: ${failure.cause}`;
        }
      }
      return null;
    },
  };
}
