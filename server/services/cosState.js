/**
 * CoS State Module
 *
 * Shared state management for Chief of Staff services.
 */

import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ensureDirs, safeJSONParse, readJSONFile, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { normalizeDomainAutonomy, getDomainMode } from '../lib/domainAutonomy.js';
import { normalizeDomainBudgets } from '../lib/domainBudgets.js';
import { createDefaultPersistentMindState, normalizePersistentMindState } from '../lib/persistentMind.js';
import { createDefaultPersistentMindCapabilities, normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { createDefaultPersistentMindProfile, normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { createDefaultPersistentMindPrompt, normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { DEFAULT_ALWAYS_APPROVE_KINDS } from './taskLearning/safetyKind.js';

export const STATE_FILE = join(PATHS.cos, 'state.json');
export const AGENTS_DIR = join(PATHS.cos, 'agents');
export const REPORTS_DIR = PATHS.reports;
export const SCRIPTS_DIR = PATHS.scripts;
export const ROOT_DIR = PATHS.root;

// Serialize every state.json read-merge-write on a single tail so two
// concurrent loadState→modify→saveState cycles can't interleave and clobber
// each other. Standardized on `createFileWriteQueue` — the documented
// single-JSON-file write-serialization convention (AGENTS.md; same mechanism
// settings.js and the issues/series/mediaCollections stores use) — instead of a
// bespoke async mutex. Identical `(fn) => Promise` contract, so the ~34 existing
// `withStateLock(...)` call sites are unchanged; the name is kept for that
// reason. The queue additionally silences its tail so one rejected write can't
// poison subsequent waiters (a strict improvement over the prior mutex).
export const withStateLock = createFileWriteQueue();

export const DEFAULT_CONFIG = {
  userTasksFile: 'data/TASKS.md',
  cosTasksFile: 'data/COS-TASKS.md',
  goalsFile: 'GOALS.md',
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  maxTotalProcesses: 50,
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] }
  ],
  autoStart: false,
  selfImprovementEnabled: true,
  appImprovementEnabled: true,
  improvementEnabled: true,
  avatarStyle: 'svg',
  dynamicAvatar: true,
  alwaysOn: true,
  appReviewCooldownMs: 1800000,
  idleReviewEnabled: true,
  idleReviewPriority: 'MEDIUM',
  proactiveMode: true,
  autonomousJobsEnabled: true,
  // Investigation tasks normally hold only failure loops for a human. This
  // opt-in also admits those loop/storm investigations unattended.
  autoApproveInvestigations: false,
  // Persisting a profile is not consent to wake the mind. Fresh and upgraded
  // installs stay disabled until the user explicitly starts it.
  persistentMindProfile: createDefaultPersistentMindProfile(),
  persistentMindPrompt: createDefaultPersistentMindPrompt(),
  // Action grants are independent of the provider profile. Existing and fresh
  // conversation-only installs never gain task-creation authority on upgrade.
  persistentMindCapabilities: createDefaultPersistentMindCapabilities(),
  // Per-domain autonomy guardrails (#711). Each domain is off | dry-run | execute.
  // Default is `execute` for every domain, reproducing pre-#711 behavior so no
  // migration is needed — an install with no stored value reads `execute`.
  domainAutonomy: normalizeDomainAutonomy({}),
  // Per-domain daily autonomy budgets (#711). Each domain caps maxActionsPerDay
  // and maxMinutesPerDay; `null` = unlimited, which is the default for every
  // domain — so an install with no stored value enforces nothing (no migration).
  domainBudgets: normalizeDomainBudgets({}),
  rehabilitationGracePeriodDays: 7,
  completedAgentRetentionMs: 86400000,
  embeddingProviderId: 'lmstudio',
  embeddingModel: '',
  autoFixThresholds: {
    maxLinesChanged: 50,
    allowedCategories: [
      'formatting',
      'dry-violations',
      'dead-code',
      'typo-fix',
      'import-cleanup'
    ]
  },
  confidenceAutoApproval: {
    enabled: true,
    highThreshold: 80,
    lowThreshold: 50,
    minSamples: 5
  },
  // Safety axis orthogonal to confidence (#2440): outward-facing / irreversible
  // work always needs human sign-off regardless of success rate. Reversible
  // internal work keeps the confidence success-rate gate. Tune which kinds are
  // forced to approval via `alwaysApproveKinds`.
  safetyKindApproval: {
    enabled: true,
    alwaysApproveKinds: [...DEFAULT_ALWAYS_APPROVE_KINDS]
  }
};

export const DEFAULT_STATE = {
  running: false,
  paused: false,
  pausedAt: null,
  pauseReason: null,
  config: DEFAULT_CONFIG,
  stats: {
    tasksCompleted: 0,
    totalRuntime: 0,
    agentsSpawned: 0,
    errors: 0,
    lastEvaluation: null,
    lastIdleReview: null
  },
  persistentMind: createDefaultPersistentMindState(),
  agents: {}
};

export async function ensureDirectories() {
  await ensureDirs([PATHS.data, PATHS.cos, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR]);
}

/**
 * Parse a persisted CoS state file, returning the object or `null` when the
 * bytes are not a JSON object.
 *
 * Never front this with a structural heuristic. The one this replaced rejected
 * any file containing the byte pair `}{` anywhere — a guess at a double-append
 * corruption that fires on perfectly VALID JSON as soon as a stored string
 * holds those two characters (an agent prompt quoting `{value}{ — project}`,
 * a diff carrying JSX). Each false positive discarded the whole file and
 * silently reset the user's config to DEFAULT_CONFIG. `JSON.parse` rejects a
 * genuine `{…}{…}` concatenation on its own, so the guess protected nothing.
 */
function parseStateFile(content) {
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: 'CoS state' });
  return isPlainObject(parsed) ? parsed : null;
}

/**
 * Apply the stored config over DEFAULT_CONFIG, running the legacy-key
 * migrations first. Shared by the normal load path and the corrupt-file
 * recovery path so a recovered config is normalized identically.
 */
function mergeStoredConfig(storedConfig) {
  const persistedConfig = { ...(storedConfig || {}) };

  // Migrate legacy split flags before merging defaults — DEFAULT_CONFIG.improvementEnabled = true
  // would otherwise shadow a v1 file that only set selfImprovementEnabled/appImprovementEnabled.
  if (persistedConfig.improvementEnabled === undefined &&
      (persistedConfig.selfImprovementEnabled !== undefined || persistedConfig.appImprovementEnabled !== undefined)) {
    persistedConfig.improvementEnabled =
      persistedConfig.selfImprovementEnabled || persistedConfig.appImprovementEnabled;
  }

  // Drop the retired `evaluationIntervalMs` key on read. CoS evaluation became
  // event-driven (the periodic evaluateTasks() timer was removed), so the field
  // no longer exists in DEFAULT_CONFIG or the (strict) update schema. Upgraded
  // installs still carry it in state.json; stripping it here keeps GET /config
  // from re-emitting a key the strict PUT schema would now reject on a full
  // round-trip, and purges it from disk on the next saveState.
  delete persistedConfig.evaluationIntervalMs;
  // The global four-level autonomy preset was only a UI shortcut that rewrote
  // independent capacity/work-generation fields. Domain guardrails now own the
  // actual off/dry-run/execute policy, so do not keep re-emitting this inert key
  // from upgraded state files. Per-job autonomyLevel remains a separate contract.
  delete persistedConfig.autonomyLevel;
  delete persistedConfig.comprehensiveAppImprovement;
  delete persistedConfig.immediateExecution;

  return {
    ...DEFAULT_CONFIG,
    ...persistedConfig,
    persistentMindCapabilities: normalizePersistentMindCapabilities(persistedConfig.persistentMindCapabilities),
    persistentMindProfile: normalizePersistentMindProfile(persistedConfig.persistentMindProfile),
    persistentMindPrompt: normalizePersistentMindPrompt(persistedConfig.persistentMindPrompt),
  };
}

// Mirror of the config slice as it was last persisted. state.json bundles the
// user's durable settings with the agent records and Mind runtime state, so it
// is rewritten constantly while the settings inside it are near-impossible to
// reconstruct. `atomicWrite` already rules out a torn write; what remains is
// disk-level damage or an out-of-tree editor — and when that lands, the
// recovery below merges this file back in rather than dropping the user to
// DEFAULT_CONFIG. Settings the user never touched are already the defaults, so
// a missing sidecar loses nothing that wasn't already lost.
export const CONFIG_BACKUP_FILE = join(PATHS.cos, 'config.last-known-good.json');

// Serialized copy of what the sidecar already holds, so the common saveState
// (an agent status tick, config untouched) stays a single file write.
let lastConfigBackupJson = null;

async function persistConfigBackup(config) {
  if (!isPlainObject(config)) return;
  // Serialize once and hand `atomicWrite` the string it would otherwise
  // produce itself, so the changed-config save doesn't stringify twice.
  const json = JSON.stringify(config, null, 2);
  if (json === lastConfigBackupJson) return;
  await atomicWrite(CONFIG_BACKUP_FILE, json)
    .then(() => { lastConfigBackupJson = json; })
    .catch((err) => console.error(`❌ Failed to back up CoS config: ${err.message}`));
}

// `readJSONFile` rather than a hand-rolled read: it carries the Windows
// swap-window retry, so a read that lands between `atomicWrite`'s temp write
// and its rename doesn't report "no sidecar" and drop the recovery below to
// DEFAULT_CONFIG — the exact loss the sidecar exists to prevent.
const readConfigBackup = () =>
  readJSONFile(CONFIG_BACKUP_FILE, null, { allowArray: false, logError: true });

/**
 * Fall back to default state after an unreadable state.json, keeping the
 * user's settings when the sidecar above can supply them. Backs the bad bytes
 * up first (retaining the 3 most recent) so the loss is inspectable.
 */
async function recoverFromUnreadableState(content) {
  console.log(`⚠️ Corrupted or empty state file at ${STATE_FILE}, returning default state`);
  const backupPath = `${STATE_FILE}.corrupted.${Date.now()}`;
  await writeFile(backupPath, content).catch(() => {});
  console.log(`📝 Backed up corrupted state to ${backupPath}`);
  // Cleanup old corrupted backups (keep only 3 most recent)
  const cosDir = dirname(STATE_FILE);
  const files = await readdir(cosDir).catch(() => []);
  const corrupted = files
    .filter(f => f.startsWith('state.json.corrupted.'))
    .sort()
    .reverse();
  for (const old of corrupted.slice(3)) {
    await rm(join(cosDir, old)).catch(() => {});
  }
  if (corrupted.length > 3) {
    console.log(`🗑️ Cleaned up ${corrupted.length - 3} old corrupted state backups`);
  }

  const recovered = structuredClone(DEFAULT_STATE);
  const savedConfig = await readConfigBackup();
  if (savedConfig) {
    // Already normalized when it was mirrored; re-merging costs nothing and
    // covers a sidecar that was hand-edited or written by an older version.
    recovered.config = mergeStoredConfig(savedConfig);
    console.log(`♻️ Restored CoS config from ${CONFIG_BACKUP_FILE}`);
  }
  return recovered;
}

// In-memory state cache — avoids re-reading state.json from disk on every call.
// All mutations go through withStateLock, so the cache stays consistent.
let stateCache = null;

// Master "Improve" flag with backward compat for the legacy split self/app flags.
// Falls through only when improvementEnabled is null/undefined — explicit `false` wins.
export function isImprovementEnabled(state) {
  return state.config.improvementEnabled ??
    (state.config.selfImprovementEnabled || state.config.appImprovementEnabled);
}

// Autonomous improvement-task QUEUING gate. Queuing mutates COS-TASKS.md with
// autonomous internal work, so it requires BOTH the idle-review flag AND the CoS
// auto-run domain in `execute` (off/dry-run are planning postures that withhold
// the queue mutation). Shared by the post-startup queue, the
// cos-improvement-check timer, and the perpetual drain-on-completion refill so
// the three gates can't drift apart.
export function canQueueImprovementTasks(state) {
  return Boolean(state.config.idleReviewEnabled) && getDomainMode(state.config, 'cos') === 'execute';
}

/**
 * Get current configuration
 */
export async function getConfig() {
  const state = await loadState();
  return state.config;
}

export async function loadState() {
  if (stateCache) return stateCache;

  await ensureDirectories();

  if (!existsSync(STATE_FILE)) {
    stateCache = structuredClone(DEFAULT_STATE);
    return stateCache;
  }

  const content = await readFile(STATE_FILE, 'utf-8');
  const state = parseStateFile(content);

  if (!state) {
    stateCache = await recoverFromUnreadableState(content);
    return stateCache;
  }

  stateCache = {
    ...DEFAULT_STATE,
    ...state,
    config: mergeStoredConfig(state.config),
    stats: { ...DEFAULT_STATE.stats, ...state.stats },
    persistentMind: normalizePersistentMindState(state.persistentMind),
    agents: state.agents ?? {}
  };
  return stateCache;
}

// Read the persisted state for safety checks, bypassing both the cache and
// loadState()'s defaulting. Unlike loadState(), this deliberately does not
// replace malformed JSON with defaults: a gate that authorizes a destructive
// action must distinguish "known empty" from "could not establish what is
// there". `trusted: false` means the file exists but could not be read as an
// object — every caller must treat that as "assume the worst", never as empty.
async function readStateForSafetyCheck() {
  await ensureDirectories();
  if (!existsSync(STATE_FILE)) return { trusted: true, state: null };
  const content = await readFile(STATE_FILE, 'utf-8');
  const state = parseStateFile(content);
  if (!state) return { trusted: false, state: null };
  return { trusted: true, state };
}

// The Persistent Mind slice, for the update route's image-work gate.
export async function readPersistentMindStateForSafetyCheck() {
  const { trusted, state } = await readStateForSafetyCheck();
  return { trusted, persistentMind: trusted ? state?.persistentMind ?? null : null };
}

// The agent records, for the update route's live-agent gate. Same contract:
// `trusted: false` is "the records could not be established", which that gate
// must read as "an agent may be running", not as "no agents are running" —
// getting that backwards restarts PortOS out from under a live agent.
export async function readAgentsStateForSafetyCheck() {
  const { trusted, state } = await readStateForSafetyCheck();
  const agents = state?.agents;
  return {
    trusted,
    agents: trusted && agents && typeof agents === 'object' && !Array.isArray(agents) ? agents : null,
  };
}

export async function saveState(state) {
  await ensureDirectories();
  stateCache = state;
  await atomicWrite(STATE_FILE, state);
  await persistConfigBackup(state.config);
}

// Resolve a single domain's autonomy mode (off | dry-run | execute) without
// importing cos.js (which would create circular deps). Domains gate their
// automatic behavior off this; an absent/invalid value resolves to `execute`.
export async function getDomainAutonomyMode(domainId) {
  const state = await loadState();
  return getDomainMode(state.config, domainId);
}

// Daemon state accessors — used by modules that need to check daemon status
// without importing cos.js (which would create circular deps)
let _daemonRunning = false;

export function isDaemonRunning() {
  return _daemonRunning;
}

export function setDaemonRunning(value) {
  _daemonRunning = value;
}
