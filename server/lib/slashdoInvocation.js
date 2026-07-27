/**
 * Slashdo invocation resolver (#3089).
 *
 * A CoS task can name a bundled slashdo workflow (`plan-task`, `next`, `review`,
 * …) instead of hand-written prose. How an agent actually *invokes* that workflow
 * is NOT a prefix swap — slashdo installs itself differently per host CLI
 * (`lib/slashdo/src/environments.js`), so the same command lands in three shapes:
 *
 * | Host CLI                 | namespacing   | invocation                     |
 * |--------------------------|---------------|--------------------------------|
 * | Claude Code              | `subdirectory`| `/do:<cmd> <args>`             |
 * | OpenCode                 | `flat`        | `/do-<cmd> <args>`             |
 * | Codex / Grok / Antigravity | `directory` | Agent Skill, selected by NAME  |
 *
 * There is no `$do:<cmd>` form. Because the provider is only known at spawn
 * time (the task form's provider select defaults to "Auto"), a task persists the
 * bare command name in `metadata.slashdoCommand` and this module resolves the
 * concrete invocation when the prompt is built.
 *
 * Skill-style hosts (and any provider we can't positively identify) get the
 * command's markdown body inlined into the prompt instead — the provider-agnostic
 * fallback that works even when that environment has no slashdo install at all.
 */
import { isClaudeProvider, isOpencodeProvider } from './providerModels.js';
import { inferTuiCommand } from './tuiHandshake.js';

/** slashdo's command namespace — `commands/do/<cmd>.md` in the submodule. */
export const SLASHDO_NAMESPACE = 'do';

/**
 * The three invocation shapes slashdo's installer produces. `slash-namespaced`
 * and `slash-flat` are typed as a slash command by the host CLI; `skill` is an
 * Agent Skill the model selects by name/description (no prefix, nothing to type).
 */
export const SLASHDO_INVOCATION_STYLES = Object.freeze({
  SLASH_NAMESPACED: 'slash-namespaced',
  SLASH_FLAT: 'slash-flat',
  SKILL: 'skill',
});

/** Bare slashdo command names are file-path segments — keep them inert. */
const COMMAND_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * True when `name` is a well-formed bare slashdo command (`plan-task`, `pr-better`).
 * Rejects anything that could escape `commands/do/` — the value reaches
 * `loadSlashdoFile`, which joins it into a path.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidSlashdoCommand(name) {
  return typeof name === 'string' && COMMAND_NAME_RE.test(name);
}

/**
 * The flat/skill name slashdo's installer gives a command in `flat` and
 * `directory` environments: `do/plan-task` → `do-plan-task`. Mirrors
 * `getSkillName` in `lib/slashdo/src/transformer.js`.
 * @param {string} command - bare command name (`plan-task`)
 * @returns {string}
 */
export function slashdoSkillName(command) {
  return `${SLASHDO_NAMESPACE}-${command}`;
}

/**
 * Which invocation shape a provider gets — the single home for the
 * provider→slashdo-shape decision (`hasSlashdo` / `tuiSlashdoFree` in
 * `agentPromptBuilder.js` derive from this rather than re-deriving it).
 *
 * Detection reuses the shared provider predicates, so a path-configured or
 * renamed binary is recognised. An unidentified provider falls through to
 * `skill`; guessing `/do:<cmd>` for an unknown host would hand it a line of
 * prose it can't run, while `skill` always works because the caller inlines the
 * procedure.
 *
 * `leanMode` (small local models behind `claude --bare`) also resolves to
 * `skill`: the lean session skips project command discovery, so `/do:<cmd>`
 * would resolve to nothing.
 *
 * **Unknown-command posture (`assumeClaudeWhenUnknown`).** A provider with no
 * launch command is genuinely ambiguous, and the two kinds of caller want
 * opposite answers:
 * - **Rendering an invocation for a task** (default, `false`): stay strict, like
 *   `isClaudeProvider`. Printing `/do:next` for a host that turns out not to be
 *   Claude hands the agent an uninvokable line; `skill` + the inlined body works
 *   everywhere, so "unknown" must not read as Claude.
 * - **Deciding whether a spawned agent may TYPE `/do:pr`** (`true`): the answer
 *   must match the command the spawners will ACTUALLY launch, which for a blank
 *   `provider.command` is `inferTuiCommand(provider.id)` — the same fallback
 *   `agentTuiSpawning.js` and `buildCliSpawnConfig` both apply. So this posture
 *   resolves the command the spawner would pick rather than guessing: a custom
 *   provider id with no command launches `claude` and IS slashdo-capable, while
 *   `codex-tui` with no command launches `codex` and is not.
 * Only the blank-command case is affected — a provider that names its command
 * resolves the same under either posture.
 *
 * @param {Object} [opts]
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand]
 * @param {boolean} [opts.leanMode]
 * @param {boolean} [opts.assumeClaudeWhenUnknown=false] - when the provider names
 *   no command, resolve the one the spawners would infer from its id instead of
 *   falling through to `skill`.
 * @returns {string} one of SLASHDO_INVOCATION_STYLES
 */
export function resolveSlashdoStyle({
  providerId = null,
  providerCommand = null,
  leanMode = false,
  assumeClaudeWhenUnknown = false,
} = {}) {
  // A blank command is only resolved for the spawner posture; the strict default
  // deliberately leaves it blank so `isClaudeProvider` won't read it as Claude.
  const command = (assumeClaudeWhenUnknown && !providerCommand)
    ? inferTuiCommand(providerId)
    : providerCommand;
  const provider = { id: providerId, command };
  if (isOpencodeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_FLAT;
  if (leanMode) return SLASHDO_INVOCATION_STYLES.SKILL;
  if (isClaudeProvider(provider)) return SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
  // Codex / Grok / Antigravity install Agent Skills, not slash commands — as
  // does anything we can't positively identify.
  return SLASHDO_INVOCATION_STYLES.SKILL;
}

/**
 * True when a session can be handed a typed Claude Code slash command — both the
 * slashdo ones (`/do:pr`, `/do:push`) and Claude's own built-ins (`/simplify`).
 * `SLASH_NAMESPACED` is exactly the Claude-Code-with-project-commands case, so
 * one predicate answers both: OpenCode gets `SLASH_FLAT` (no `/do:pr`, no
 * `/simplify`), codex/grok/antigravity get `SKILL`, and a lean `--bare` session
 * gets `SKILL` because it skips command discovery entirely.
 *
 * This is the single home for the completion-workflow gates in
 * `agentPromptBuilder.js` (formerly three inline provider-id allowlists:
 * `hasSlashdo`, `tuiSlashdoFree`, and the guideline-bullet `slashdoFree`). It
 * uses the `assumeClaudeWhenUnknown` posture because those gates describe a
 * session the spawners are about to launch, and every spawner resolves a blank
 * command to `claude`.
 *
 * `assumeClaudeWhenUnknown` defaults to `true` here (unlike `resolveSlashdoStyle`)
 * because the callers are describing a CLI/TUI session about to be spawned. An
 * HTTP-API provider is never spawned as a local CLI, so the API path passes
 * `false` — a blank provider there is not a latent `claude`.
 *
 * @param {Object} [opts] - same shape as `resolveSlashdoStyle`
 * @returns {boolean}
 */
export function canTypeSlashCommands({
  providerId = null,
  providerCommand = null,
  leanMode = false,
  assumeClaudeWhenUnknown = true,
} = {}) {
  return resolveSlashdoStyle({ providerId, providerCommand, leanMode, assumeClaudeWhenUnknown })
    === SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED;
}

/**
 * Resolve the concrete invocation for a slashdo-backed task.
 *
 * @param {Object} opts
 * @param {string} opts.command - bare command name (`plan-task`)
 * @param {string} [opts.args] - free-form arguments (the task description)
 * @param {string|null} [opts.providerId]
 * @param {string|null} [opts.providerCommand] - the provider's launch command
 * @param {boolean} [opts.leanMode]
 * @returns {{ command: string, skillName: string, style: string, args: string,
 *   invocation: string }|null} null when `command` is missing or not a
 *   well-formed slashdo command name.
 */
export function resolveSlashdoInvocation({
  command,
  args = '',
  providerId = null,
  providerCommand = null,
  leanMode = false,
} = {}) {
  if (!isValidSlashdoCommand(command)) return null;

  const style = resolveSlashdoStyle({ providerId, providerCommand, leanMode });
  const skillName = slashdoSkillName(command);
  const trimmedArgs = typeof args === 'string' ? args.trim() : '';
  const suffix = trimmedArgs ? ` ${trimmedArgs}` : '';

  const invocation = style === SLASHDO_INVOCATION_STYLES.SLASH_NAMESPACED
    ? `/${SLASHDO_NAMESPACE}:${command}${suffix}`
    : style === SLASHDO_INVOCATION_STYLES.SLASH_FLAT
      ? `/${skillName}${suffix}`
      : `Use the \`${skillName}\` skill${trimmedArgs ? ` on: ${trimmedArgs}` : ''}`;

  return { command, skillName, style, args: trimmedArgs, invocation };
}

/**
 * Render the prompt section for a resolved slashdo invocation. Pure — the
 * caller loads `body` (via `loadSlashdoFile`) and passes it in, so this module
 * stays side-effect free.
 *
 * The body is inlined for EVERY style, not just `skill`. PortOS bundles slashdo
 * as a submodule and only exposes it as slash commands through the repo-local
 * `.claude/commands/do/` symlinks — which exist in the PortOS checkout, not in
 * the managed-app workspaces most CoS tasks run in, and only for Claude Code.
 * So a typed invocation is a shortcut for hosts that happen to have slashdo
 * installed, never the thing the prompt depends on. Same posture as every other
 * slashdo consumer here (`loadSlashdoCommand`, the `/do:rpr` and review-loop
 * inlining), which is why the submodule exists at all: no global install required.
 *
 * @param {ReturnType<typeof resolveSlashdoInvocation>} resolved
 * @param {string|null} [body] - the command's markdown
 * @returns {string} markdown section, or '' when `resolved` is null
 */
export function buildSlashdoSection(resolved, body = null) {
  if (!resolved) return '';

  // Without explicit args the workflow operates on the task described above —
  // say so rather than re-printing the whole description inside the invocation.
  const target = resolved.args ? '' : ' Apply it to the task described above.';

  const lines = ['### Slashdo Workflow'];
  if (resolved.style === SLASHDO_INVOCATION_STYLES.SKILL) {
    lines.push(
      `This task runs the bundled slashdo **${resolved.skillName}** workflow. ${resolved.invocation}.${target}`,
      'Your CLI exposes slashdo as Agent Skills — selected by name, with no slash-command form to type.'
    );
  } else {
    lines.push(
      `This task runs the bundled slashdo **${resolved.skillName}** workflow.${target} If your CLI has slashdo installed you can invoke it directly:`,
      '',
      '```',
      resolved.invocation,
      '```'
    );
  }
  if (body) {
    lines.push(
      '',
      'The full procedure is inlined below — follow it exactly rather than improvising:',
      '',
      body.trim()
    );
  }
  return lines.join('\n');
}
