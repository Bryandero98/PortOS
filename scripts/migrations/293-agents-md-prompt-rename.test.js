import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './293-agents-md-prompt-rename.js';
import { DEFAULT_TASK_PROMPTS, PROMPT_VERSIONS, PREVIOUS_DEFAULT_PROMPTS } from '../../server/services/taskPromptDefaults.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The outgoing default is the last entry appended for each key — the body an
// install that never customized the prompt is holding right now.
const outgoing = (key) => PREVIOUS_DEFAULT_PROMPTS[key].at(-1);

describe('migration 293 — AGENTS.md prompt rename', () => {
  let rootDir;
  let schedulePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-293-'));
    mkdirSync(join(rootDir, 'data/cos'), { recursive: true });
    schedulePath = join(rootDir, 'data/cos/task-schedule.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('upgrades every uncustomized affected prompt to the AGENTS.md wording', async () => {
    writeJson(schedulePath, {
      tasks: {
        'claim-issue': { prompt: outgoing('claim-issue'), promptVersion: PROMPT_VERSIONS['claim-issue'] - 1 },
        'release-check': { prompt: outgoing('release-check'), promptVersion: PROMPT_VERSIONS['release-check'] - 1 },
        'stash-cleanup': { prompt: outgoing('stash-cleanup'), promptVersion: 1 },
      },
    });

    const result = await migration.up({ rootDir });
    const tasks = readJson(schedulePath).tasks;

    expect(result.updated).toBe(3);
    for (const key of ['claim-issue', 'release-check', 'stash-cleanup']) {
      expect(tasks[key].prompt).toBe(DEFAULT_TASK_PROMPTS[key]);
      expect(tasks[key].promptVersion).toBe(PROMPT_VERSIONS[key]);
      expect(tasks[key].prompt).toContain('AGENTS.md');
    }
  });

  it('leaves a user-customized prompt untouched', async () => {
    writeJson(schedulePath, {
      tasks: {
        'claim-issue': {
          prompt: 'MY OWN CLAIM PROMPT that mentions CLAUDE.md on purpose',
          promptVersion: 1,
          promptCustomized: true,
        },
      },
    });

    const result = await migration.up({ rootDir });
    const task = readJson(schedulePath).tasks['claim-issue'];

    expect(result.updated).toBe(0);
    expect(task.prompt).toBe('MY OWN CLAIM PROMPT that mentions CLAUDE.md on purpose');
    expect(task.promptVersion).toBe(1);
  });

  it('leaves a prompt already at the current version alone', async () => {
    writeJson(schedulePath, {
      tasks: {
        'plan-task': { prompt: DEFAULT_TASK_PROMPTS['plan-task'], promptVersion: PROMPT_VERSIONS['plan-task'] },
      },
    });

    expect((await migration.up({ rootDir })).updated).toBe(0);
  });

  it('is a no-op when no schedule file exists', async () => {
    expect((await migration.up({ rootDir })).updated).toBe(0);
  });
});
