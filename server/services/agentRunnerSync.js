/**
 * Runner agent recovery.
 *
 * Rehydrates the in-memory `runnerAgents` map from the CoS Runner after a
 * server restart, so completion events for agents spawned before the restart
 * still land. Extracted from `agentLifecycle.js` (issue #2837): both
 * `agentManagement.js` and `subAgentSpawner.js` need it, and importing it from
 * the lifecycle orchestrator dragged that whole module graph into a cycle.
 *
 * Leaf with respect to the agent cluster — must not import `agentLifecycle.js`
 * or `agentManagement.js` (enforced by `agentImportCycles.test.js`).
 */

import { connectTuiSessionViaRunner, getActiveAgentsFromRunner } from './cosRunnerClient.js';
import { isInternalTaskId } from '../lib/taskParser.js';
import { runnerAgents } from './agentState.js';
import { getAgent } from './cosAgents.js';
import * as shellService from './shell.js';

/**
 * Sync running agents from the runner (recovery after server restart).
 * This allows us to receive completion events for agents spawned before restart.
 */
export async function syncRunnerAgents() {
  const agents = await getActiveAgentsFromRunner().catch(err => {
    console.error(`❌ Failed to get active agents from runner: ${err.message}`);
    return [];
  });
  if (agents.length === 0) return 0;

  console.log(`🔄 Syncing ${agents.length} running agents from CoS Runner`);

  // Get all tasks to find task data for each agent
  const { getAllTasks } = await import('./cos.js');
  const allTasksData = await getAllTasks().catch(() => ({ user: {}, cos: {} }));

  // Build a task lookup map from all task sources, tagging each with its taskType
  const taskMap = new Map();
  const addTasks = (groupedTasks, taskType) => {
    if (!groupedTasks) return;
    for (const tasks of Object.values(groupedTasks)) {
      if (Array.isArray(tasks)) {
        for (const task of tasks) {
          taskMap.set(task.id, { ...task, taskType });
        }
      }
    }
  };

  addTasks(allTasksData.user?.grouped, 'user');
  addTasks(allTasksData.cos?.grouped, 'internal');

  let syncedCount = 0;
  for (const agent of agents) {
    // Only sync if not already tracked
    if (!runnerAgents.has(agent.id)) {
      const task = taskMap.get(agent.taskId);

      const inferredType = isInternalTaskId(agent.taskId) ? 'internal' : 'user';
      // Recover the run id from the PERSISTED agent record (#3244). The runner's
      // /agents response describes the live process and carries no `metadata`,
      // but `spawnViaRunner` wrote `runId` into the agent record before handing
      // off, so it is still on disk — `agentManagement.js` reads it the same way
      // on its orphan path. Dropping it here left the survivor's run permanently
      // open (`completeAgentRun` returns early on a null id), so the Runs list
      // showed it running forever and `recordCompletedRunUsage` never fired —
      // silently exempting the longest-lived runs in the system from all cost
      // accounting. Survivors are the normal case since #3202 made TUI agents
      // durable, so this cannot stay a best-effort null.
      const persisted = await getAgent(agent.id).catch(() => null);
      const recoveredRunId = persisted?.metadata?.runId || null;
      runnerAgents.set(agent.id, {
        taskId: agent.taskId,
        task: task || { id: agent.taskId, taskType: inferredType, description: 'Recovered from runner' },
        runId: recoveredRunId,
        model: persisted?.metadata?.model || null,
        hasStartedWorking: true,
        startedAt: agent.startedAt
      });
      if (!recoveredRunId) {
        console.warn(`⚠️ Recovered agent ${agent.id} has no run id on record — its run stays open and unbilled`);
      }
      if (agent.kind === 'tui' && agent.sessionId && !shellService.getSession(agent.sessionId)) {
        const session = connectTuiSessionViaRunner(agent);
        shellService.registerExternalSession(agent.sessionId, session.ptyProcess, {
          cwd: agent.workspacePath,
          kind: 'agent-tui',
          agentId: agent.id,
          label: `Recovered TUI ${agent.id}`,
          command: agent.command,
        });
        session.ptyProcess.onExit(({ exitCode }) => {
          shellService.unregisterExternalSession(agent.sessionId, { exitCode });
        });
      }
      console.log(`🔄 Recovered agent ${agent.id} (task: ${agent.taskId})`);
      syncedCount++;
    }
  }

  return syncedCount;
}
