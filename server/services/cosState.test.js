import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'cos-state-test-' });

vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));

const COS_DIR = join(tempRoot, 'cos');
const STATE_PATH = join(COS_DIR, 'state.json');

afterAll(cleanup);

// The module caches state in memory and remembers what it last mirrored to the
// config sidecar, so every case needs a fresh module instance.
const freshModule = async () => {
  vi.resetModules();
  return import('./cosState.js');
};

const writeState = (state) => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

beforeEach(() => {
  rmSync(COS_DIR, { recursive: true, force: true });
  mkdirSync(COS_DIR, { recursive: true });
});

describe('cosState persistence', () => {
  // The regression: a `}{` heuristic declared VALID state files corrupt as soon
  // as any stored string held that byte pair (a slashdo doc quoting
  // `{value}{ — project|global}`, a diff carrying JSX), and the fallback reset
  // every user setting to DEFAULT_CONFIG.
  it('keeps user config when a stored string contains "}{"', async () => {
    writeState({
      running: false,
      config: {
        maxConcurrentAgents: 20,
        maxConcurrentAgentsPerProject: 12,
      },
      agents: {
        'agent-1': {
          id: 'agent-1',
          // Verbatim shape of the text that triggered the false positive.
          prompt: 'Using saved defaults: --review-with={value}{, --review-iterations=…}{ — project|global}',
        },
      },
    });

    const { loadState } = await freshModule();
    const state = await loadState();

    expect(state.config.maxConcurrentAgents).toBe(20);
    expect(state.config.maxConcurrentAgentsPerProject).toBe(12);
    expect(state.agents['agent-1']).toBeDefined();
    // A valid file is never treated as corrupt, so nothing is quarantined.
    expect(readdirSync(COS_DIR).filter(f => f.startsWith('state.json.corrupted.'))).toHaveLength(0);
  });

  it('reports a "}{"-carrying state file as trusted to the update safety gate', async () => {
    writeState({ agents: { 'agent-1': { id: 'agent-1', status: 'running', prompt: 'a }{ b' } } });

    const { readAgentsStateForSafetyCheck } = await freshModule();

    // `trusted: false` here would make the update gate treat a live agent as
    // "records unreadable" and demand a manual state.json restore.
    await expect(readAgentsStateForSafetyCheck()).resolves.toEqual({
      trusted: true,
      agents: { 'agent-1': { id: 'agent-1', status: 'running', prompt: 'a }{ b' } },
    });
  });

  // Full round trip: save mirrors the config slice, and a state.json that is
  // genuinely unreadable afterwards recovers those settings instead of
  // dropping the user to DEFAULT_CONFIG.
  it('recovers saved config when state.json becomes unreadable', async () => {
    const saved = await freshModule();
    const state = await saved.loadState();
    state.config.maxConcurrentAgents = 20;
    state.config.maxConcurrentAgentsPerProject = 12;
    await saved.saveState(state);
    expect(JSON.parse(readFileSync(saved.CONFIG_BACKUP_FILE, 'utf-8')).maxConcurrentAgents).toBe(20);

    // A double-append: two complete objects concatenated. JSON.parse rejects it.
    writeFileSync(STATE_PATH, `${JSON.stringify({ config: {} })}${JSON.stringify({ config: {} })}`);

    const { loadState, DEFAULT_CONFIG } = await freshModule();
    const recovered = await loadState();

    expect(recovered.config.maxConcurrentAgents).toBe(20);
    expect(recovered.config.maxConcurrentAgentsPerProject).toBe(12);
    // Settings the sidecar doesn't carry still fall back to the shipped default.
    expect(recovered.config.maxTotalProcesses).toBe(DEFAULT_CONFIG.maxTotalProcesses);
    // Agent records are genuinely lost — but the bad bytes stay inspectable.
    expect(recovered.agents).toEqual({});
    expect(readdirSync(COS_DIR).filter(f => f.startsWith('state.json.corrupted.'))).toHaveLength(1);
  });
});
