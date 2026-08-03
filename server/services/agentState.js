/**
 * Shared mutable state for agent tracking.
 * Imported by agentLifecycle.js, agentManagement.js, and subAgentSpawner.js.
 */

// activeAgents: direct spawn mode processes (Map<agentId, { process, task, runId, ... }>)
export const activeAgents = new Map();

// runnerAgents: runner-spawned agents (Map<agentId, { taskId, task, runId, model, ... }>)
export const runnerAgents = new Map();

// userTerminatedAgents: agents the user explicitly killed (Set<agentId>)
export const userTerminatedAgents = new Set();

// pausedAgents: agents whose process is being stopped without finalizing the
// task or cleaning up the worktree (Map<agentId, { pausedAt, reason }>)
export const pausedAgents = new Map();

// spawningTasks: tasks currently being spawned (Set<taskId>) — deduplication guard
export const spawningTasks = new Set();

// useRunner: whether CoS Runner mode is active
export let useRunner = false;
export const setUseRunner = (val) => { useRunner = val; };

// Active agent IDs (direct-mode + runner-mode), for zombie/orphan detection.
// Lives here in the side-effect-free state module so callers (cleanup jobs,
// zombie sweeps) can read it without importing the heavier `subAgentSpawner.js`
// orchestrator (which re-exports the whole agent-lifecycle module graph).
// `subAgentSpawner` re-exports it for backward compatibility.
export const getActiveAgentIds = () => [...activeAgents.keys(), ...runnerAgents.keys()];

// Does THIS process already own the agent's lifecycle?
//
// Ownership is split across the two maps by spawn mode, and which map an agent
// lands in is not guessable from its `executionMode`: a runner-backed TUI
// (`runner-tui`) is driven by the live `spawnTuiAgent` closure, so it registers
// in `activeAgents` — NEVER in `runnerAgents`, even though the runner owns its
// process and lists it in `/agents`. Only `spawnViaRunner` populates
// `runnerAgents`. Consult this rather than either map alone: checking
// `runnerAgents` by itself reads a live TUI as an unowned restart survivor,
// which is exactly how `syncRunnerAgents` came to hoist running TUI agents and
// let a stray runner `agent:completed` event double-finalize them.
export const isAgentOwnedLocally = (agentId) => activeAgents.has(agentId) || runnerAgents.has(agentId);

// Metadata booleans may arrive as true/'true' or false/'false' (JSON vs TASKS.md string round-trip)
export const isTruthyMeta = (value) => value === true || value === 'true';
export const isFalsyMeta = (value) => value === false || value === 'false';

// Metadata strings may be absent, empty, or non-string (objects/numbers leak past `||` checks).
// Returns `value` only when it's a non-empty string, otherwise `fallback`.
export const metaStringOr = (value, fallback) => (typeof value === 'string' && value) ? value : fallback;
