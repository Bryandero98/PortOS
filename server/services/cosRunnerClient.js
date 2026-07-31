/**
 * CoS Runner Client
 *
 * Communicates with the standalone portos-cos PM2 process
 * that manages agent spawning to prevent orphaned processes.
 */

import { io } from 'socket.io-client';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { PORTS } from '../lib/ports.js';

const COS_RUNNER_URL = process.env.COS_RUNNER_URL || `http://localhost:${PORTS.COS}`;

/**
 * Read a runner response body as JSON, tolerating a non-JSON body.
 *
 * The runner can answer with an HTML error page (e.g. a 500 while PM2 is
 * restarting it mid-request) instead of JSON, which would crash a bare
 * `response.json()` with `Unexpected token <`. The non-JSON fallback surfaces
 * the runner's raw message as `{ error: <raw text> }` so callers throw a useful
 * error; an empty body returns `{}` (the shared helper's `emptyValue`), distinct
 * from a parse failure, so spreading callers like `getRunnerHealth` don't pick
 * up a spurious `error`.
 */
const readRunnerJson = (response) =>
  readResponseJson(response, { fallback: (text) => ({ error: text.trim() }) });

// Socket.IO client for real-time events
let socket = null;
// Map of event name -> array of handlers (supports multiple listeners per event)
const eventHandlers = new Map();
// Runner-owned TUI PTYs are represented locally by small node-pty-compatible
// proxies. The callbacks survive Socket.IO reconnects within this server
// process; after a full server restart, runner-agent reconciliation owns the
// still-running process and its eventual completion.
const tuiSessions = new Map();

const dispatchTuiEvent = (event, data) => {
  const session = tuiSessions.get(data?.sessionId);
  if (!session) return;
  const handlers = event === 'tui:output' ? session.dataHandlers : session.exitHandlers;
  for (const handler of handlers) {
    try {
      const result = handler(event === 'tui:output'
        ? data.data
        : { exitCode: data.exitCode, signal: data.signal });
      if (result && typeof result.then === 'function') {
        result.catch(err => console.error(`🔌 CoS runner ${event} handler rejected: ${err.message}`));
      }
    } catch (err) {
      console.error(`🔌 CoS runner ${event} handler threw: ${err.message}`);
    }
  }
  if (event === 'tui:exit') tuiSessions.delete(data.sessionId);
};

const createTuiProxy = (sessionId, pid, state) => {
  const subscribe = (handlers, handler) => {
    handlers.add(handler);
    return { dispose: () => handlers.delete(handler) };
  };
  const emitControl = (event, payload = {}) => {
    if (!socket?.connected) {
      state.pendingControls.push({ event, payload });
      return true;
    }
    socket.emit(event, { sessionId, ...payload });
    return true;
  };
  return {
    sessionId,
    pid,
    ptyProcess: {
      pid,
      onData: (handler) => subscribe(state.dataHandlers, handler),
      onExit: (handler) => subscribe(state.exitHandlers, handler),
      write: (data) => emitControl('tui:input', { data }),
      resize: (cols, rows) => emitControl('tui:resize', { cols, rows }),
      kill: (signal = 'SIGTERM') => emitControl('tui:kill', { signal }),
    },
  };
};

/**
 * Initialize connection to CoS Runner
 */
export function initCosRunnerConnection() {
  if (socket) return;

  socket = io(COS_RUNNER_URL, {
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000
  });

  const dispatch = (event, data) => {
    const handlers = eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      // Guard against sync throws and async rejections so a single bad handler
      // can't crash the process via unhandledRejection.
      try {
        const ret = h(data);
        if (ret && typeof ret.then === 'function') {
          ret.catch(err => console.error(`🔌 CoS runner handler for ${event} rejected: ${err.message}`));
        }
      } catch (err) {
        console.error(`🔌 CoS runner handler for ${event} threw: ${err.message}`);
      }
    }
  };

  socket.on('connect', () => {
    console.log('🔌 Connected to CoS Runner');
    for (const [sessionId, state] of tuiSessions) {
      for (const { event, payload } of state.pendingControls.splice(0)) {
        socket.emit(event, { sessionId, ...payload });
      }
    }
    dispatch('connection:ready', undefined);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected from CoS Runner');
    dispatch('connection:lost', undefined);
  });

  socket.on('connect_error', (err) => {
    console.error(`🔌 CoS Runner connection error: ${err.message}`);
  });

  // Forward events to registered handlers
  socket.on('agent:output', (data) => dispatch('agent:output', data));
  socket.on('agent:completed', (data) => dispatch('agent:completed', data));
  socket.on('agent:error', (data) => dispatch('agent:error', data));
  socket.on('agent:btw', (data) => dispatch('agent:btw', data));
  socket.on('tui:output', (data) => dispatchTuiEvent('tui:output', data));
  socket.on('tui:exit', (data) => dispatchTuiEvent('tui:exit', data));

  // Batch orphaned agents event (startup cleanup)
  socket.on('agents:orphaned', (data) => dispatch('agents:orphaned', data));
}

/**
 * Spawn a TUI PTY in the durable CoS runner and return a node-pty-compatible
 * proxy used by the existing Shell/TUI orchestration.
 */
export async function spawnTuiSessionViaRunner(options) {
  const { onData, onExit, ...requestOptions } = options;
  const sessionId = requestOptions.sessionId || requestOptions.agentId;
  const state = {
    dataHandlers: new Set(onData ? [onData] : []),
    exitHandlers: new Set(onExit ? [onExit] : []),
    pendingControls: [],
  };
  tuiSessions.set(sessionId, state);
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/spawn-tui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...requestOptions, sessionId }),
  }, 60000).catch(err => {
    tuiSessions.delete(sessionId);
    throw err;
  });
  if (!response.ok) {
    tuiSessions.delete(sessionId);
    const error = await readRunnerJson(response);
    throw new Error(error.error || 'Failed to spawn runner-owned TUI session');
  }

  const result = await readRunnerJson(response);
  const pid = result.pid;

  return createTuiProxy(sessionId, pid, state);
}

/**
 * Recreate the local relay for a TUI that survived a portos-server restart.
 */
export function connectTuiSessionViaRunner({ sessionId, pid }) {
  const state = tuiSessions.get(sessionId) || {
    dataHandlers: new Set(),
    exitHandlers: new Set(),
    pendingControls: [],
  };
  tuiSessions.set(sessionId, state);
  return createTuiProxy(sessionId, pid, state);
}

/**
 * Register event handler (multiple handlers per event are supported)
 */
export function onCosRunnerEvent(event, handler) {
  if (!eventHandlers.has(event)) eventHandlers.set(event, []);
  eventHandlers.get(event).push(handler);
}

/**
 * Check if CoS Runner is available
 */
export async function isRunnerAvailable() {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/health`, {}, 10000).catch(() => null);
  if (!response || !response.ok) return false;
  return true;
}

/**
 * Get runner health status
 */
export async function getRunnerHealth() {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/health`, {}, 10000).catch(() => null);
  if (!response || !response.ok) {
    return { available: false, error: 'Runner not available' };
  }
  const data = await readRunnerJson(response);
  return { available: true, ...data };
}

/**
 * Spawn an agent via the CoS Runner
 */
export async function spawnAgentViaRunner(options) {
  const {
    agentId,
    taskId,
    prompt,
    workspacePath,
    model,
    envVars,
    // New: CLI-agnostic parameters
    cliCommand,
    cliArgs,
    // Legacy (deprecated)
    claudePath
  } = options;

  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId,
      taskId,
      prompt,
      workspacePath,
      model,
      envVars,
      cliCommand,
      cliArgs,
      claudePath
    }),
  }, 60000);

  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw new Error(error.error || 'Failed to spawn agent');
  }

  return readRunnerJson(response);
}

/**
 * Get list of active agents from runner
 */
export async function getActiveAgentsFromRunner() {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/agents`, {}, 10000);
  if (!response.ok) {
    throw new Error('Failed to get agents');
  }
  return readRunnerJson(response);
}

/**
 * Terminate an agent via the runner (graceful SIGTERM with SIGKILL fallback)
 */
export async function terminateAgentViaRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/terminate/${agentId}`, {
    method: 'POST'
  }, 30000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    // Preserve the runner's HTTP status so callers can distinguish a genuine
    // 404 (agent gone / runner restarted out of sync) from a 5xx infra failure.
    throw Object.assign(new Error(error.error || 'Failed to terminate agent'), { status: response.status });
  }
  return readRunnerJson(response);
}

/**
 * Force kill an agent via the runner (immediate SIGKILL)
 */
export async function killAgentViaRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/kill/${agentId}`, {
    method: 'POST'
  }, 30000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw Object.assign(new Error(error.error || 'Failed to kill agent'), { status: response.status });
  }
  return readRunnerJson(response);
}

/**
 * Pause an agent via the runner without emitting normal completion cleanup.
 */
export async function pauseAgentViaRunner(agentId, reason = null) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/pause/${agentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  }, 30000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw Object.assign(new Error(error.error || 'Failed to pause agent'), { status: response.status });
  }
  return readRunnerJson(response);
}

/**
 * Get process stats for an agent
 */
export async function getAgentStatsFromRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/agents/${agentId}/stats`, {}, 10000);
  if (!response.ok) {
    return null;
  }
  return readRunnerJson(response);
}

/**
 * Terminate all agents via the runner
 */
export async function terminateAllAgentsViaRunner() {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/terminate-all`, {
    method: 'POST'
  }, 30000);
  if (!response.ok) {
    throw new Error('Failed to terminate agents');
  }
  return readRunnerJson(response);
}

/**
 * Get agent output from runner
 */
export async function getAgentOutputFromRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/agents/${agentId}/output`, {}, 10000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw new Error(error.error || 'Failed to get agent output');
  }
  return readRunnerJson(response);
}
