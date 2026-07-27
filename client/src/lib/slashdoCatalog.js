/**
 * Client mirror of `server/lib/slashdoCatalog.js` — which bundled slashdo
 * workflows PortOS offers as a one-click agent run (#3114).
 *
 * The server is the source of truth for WHICH workflows exist and what each one
 * does; this mirror carries only what the client renders (description, app-type
 * gate, drawer flag) plus the button styling the server has no business knowing.
 * A parity test in `server/lib/slashdoCatalog.test.js` asserts the two lists agree
 * on command / description / appTypes / configurable — so adding a workflow
 * server-side without mirroring it fails the suite rather than silently leaving
 * the Agent Operations panel a workflow short.
 *
 * (The import direction is one-way, matching the `constants.js` app-type mirror:
 * this module is dependency-free so a server test can import it, while the server
 * catalog isn't reachable from a Vite client build.)
 */

/**
 * slashdo's command namespace. Mirrors `SLASHDO_NAMESPACE` in
 * `server/lib/slashdoInvocation.js`.
 */
export const SLASHDO_NAMESPACE = 'do';

/**
 * How a slashdo workflow is SPELLED in PortOS UI — `/do:review`. Users know these
 * workflows by their Claude Code slash-command form, so that's what buttons,
 * chips, and tooltips show. This is a UI string only: the shape actually sent to
 * an agent is resolved per provider server-side (`resolveSlashdoInvocation`), and
 * for a codex/grok host it is a skill name, not a slash command.
 * @param {string} command - bare command name (`plan-task`)
 * @returns {string}
 */
export function slashdoLabel(command) {
  return `/${SLASHDO_NAMESPACE}:${command}`;
}

/** App-type gates — mirrors SLASHDO_APP_TYPES on the server. */
export const SLASHDO_APP_TYPES = Object.freeze({
  ANY: 'any',
  SWIFT: 'swift',
  NON_SWIFT: 'non-swift',
});

const CLASSES = {
  success: 'bg-port-success/20 text-port-success hover:bg-port-success/30 border-port-success/30',
  accent: 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30 border-port-accent/30',
  cyan: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border-cyan-500/30',
  blue: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border-blue-500/30',
  purple: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border-purple-500/30',
  warning: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30 border-port-warning/30',
  slate: 'bg-slate-500/20 text-slate-300 hover:bg-slate-500/30 border-slate-500/30',
};

/**
 * @typedef {Object} SlashdoWorkflowButton
 * @property {string} command - bare slashdo command name (`plan-task`)
 * @property {string} description - button tooltip
 * @property {string} appTypes - one of SLASHDO_APP_TYPES
 * @property {boolean} [configurable] - opens the run-settings drawer instead of
 *   queuing immediately
 * @property {string} classes - Tailwind classes for the button
 */

/** @type {ReadonlyArray<SlashdoWorkflowButton>} */
export const SLASHDO_WORKFLOWS = Object.freeze([
  {
    command: 'plan-task',
    description: 'Investigate the codebase and file a decision-complete issue',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.slate,
  },
  {
    command: 'next',
    description: "Claim the next unclaimed work item (per the app's Work Tracker) and ship a PR",
    appTypes: SLASHDO_APP_TYPES.ANY,
    configurable: true,
    classes: CLASSES.blue,
  },
  {
    command: 'replan',
    description: 'Audit the backlog, archive completed items, prune stale work',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.cyan,
  },
  {
    command: 'review',
    description: 'Deep code review of the changed files',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.accent,
  },
  {
    command: 'push',
    description: 'Commit and push all work with a changelog entry',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.success,
  },
  {
    command: 'release',
    description: 'Create a release PR',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.purple,
  },
  {
    command: 'better',
    description: 'Run a DevSecOps audit and remediation pass',
    appTypes: SLASHDO_APP_TYPES.NON_SWIFT,
    classes: CLASSES.warning,
  },
  {
    command: 'better-swift',
    description: 'Run a SwiftUI DevSecOps audit and remediation pass',
    appTypes: SLASHDO_APP_TYPES.SWIFT,
    classes: CLASSES.warning,
  },
  {
    command: 'depfree',
    description: 'Audit dependencies and remove the unnecessary ones',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.slate,
  },
  {
    command: 'scan',
    description: 'Read-only safety audit — malware patterns, network calls, vulnerable deps',
    appTypes: SLASHDO_APP_TYPES.ANY,
    classes: CLASSES.slate,
  },
]);

/**
 * The workflows launchable for one app, filtered by its Swift-ness. `better` and
 * `better-swift` are the same audit for different stacks, so exactly one of them
 * shows per app.
 * @param {boolean} isSwiftApp
 * @returns {SlashdoWorkflowButton[]}
 */
export function slashdoWorkflowsForApp(isSwiftApp) {
  return SLASHDO_WORKFLOWS.filter(w =>
    w.appTypes === SLASHDO_APP_TYPES.ANY
    || (isSwiftApp ? w.appTypes === SLASHDO_APP_TYPES.SWIFT : w.appTypes === SLASHDO_APP_TYPES.NON_SWIFT));
}
