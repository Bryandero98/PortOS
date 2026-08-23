/**
 * Shared plumbing for a local daemon PortOS runs as an optional PM2 process
 * (`llamaServerManager.js` → `portos-llama-server`, `mtplxServerManager.js` →
 * `portos-mtplx`).
 *
 * Both managers answer the same two questions the same way, and the answers are
 * fiddly enough that two copies drift:
 *
 *   - **What did it print?** A launcher card is useless without the daemon's
 *     recent output, and the output lives in two places — the lines PortOS
 *     itself logged around the launch, and what `pm2 logs` has. They have to be
 *     merged without duplicating the overlap and without growing unbounded.
 *   - **What was it launched with?** After a PortOS restart the only record of a
 *     still-online daemon's configuration is its PM2 argv, so both managers
 *     recover the launch flags by reading values back out of that array.
 *
 * Deliberately NOT a "daemon manager" abstraction: what each daemon's launch
 * line means, when it may be started, and what a refusal should say are exactly
 * the parts that differ, and folding them together would produce a base class
 * with two special cases. This is the shared *mechanism* only.
 */

/** Same cap both managers used, and what the launcher cards render. */
const DEFAULT_MAX_LINES = 100;

/**
 * A bounded, timestamped ring buffer of a daemon's recent output.
 *
 * `withPm2Logs` does NOT fold the PM2 output into the buffer: PM2 owns those
 * lines and re-reads them on every status call, so remembering them here would
 * grow a second copy that outlives the process they came from. It returns the
 * merged VIEW a status response renders.
 *
 * @param {{maxLines?: number}} [options]
 */
export function createDaemonLogBuffer({ maxLines = DEFAULT_MAX_LINES } = {}) {
  let lines = [];

  const append = (line) => {
    if (!line) return;
    const text = String(line).trimEnd();
    if (!text) return;
    lines.push(`[${new Date().toISOString()}] ${text}`);
    if (lines.length > maxLines) lines = lines.slice(-maxLines);
  };

  return {
    append,
    maxLines,
    reset: () => { lines = []; },
    snapshot: () => [...lines],
    /**
     * This buffer's lines followed by anything in `pm2Output` it does not
     * already hold, capped to the same budget.
     * @param {string} pm2Output combined stdout + stderr from `pm2 logs`
     * @returns {string[]}
     */
    withPm2Logs(pm2Output) {
      const merged = [...lines];
      const seen = new Set(merged);
      for (const line of String(pm2Output || '').split('\n').map((l) => l.trimEnd()).filter(Boolean)) {
        if (seen.has(line)) continue;
        merged.push(line);
        seen.add(line);
      }
      return merged.length > maxLines ? merged.slice(-maxLines) : merged;
    },
  };
}

/**
 * The value following `flag` in a PM2 process's recorded argv, or `null`.
 *
 * `null` means the flag was NOT on the launch line, which is distinct from a
 * flag whose value happens to be falsy — a caller reconstructing a config must
 * leave an absent flag off a relaunch rather than substituting a default the
 * daemon never saw.
 *
 * @param {string[]|string} args PM2's `args` (an array, or the space-joined string it sometimes reports)
 * @param {string} flag
 * @returns {string|null}
 */
export function pm2ArgValue(args, flag) {
  const list = Array.isArray(args) ? args : String(args || '').split(' ');
  const idx = list.indexOf(flag);
  return idx !== -1 && idx + 1 < list.length ? list[idx + 1] : null;
}
