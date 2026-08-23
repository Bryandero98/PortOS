import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-cos-scripts-' });

vi.mock('../lib/fileUtils.js', async () => makeProxy(await vi.importActual('../lib/fileUtils.js')));

const { SCRIPTS_DIR } = await import('./cosState.js');
const { getScript } = await import('./cos.js');

afterAll(cleanup);

describe('getScript', () => {
  it('returns a script and its metadata for a valid script name', async () => {
    await mkdir(SCRIPTS_DIR, { recursive: true });
    await writeFile(join(SCRIPTS_DIR, 'deploy.sh'), '#!/bin/sh\necho deploy\n');
    await writeFile(join(SCRIPTS_DIR, 'deploy.json'), '{"label":"Deploy"}');

    await expect(getScript('deploy')).resolves.toEqual({
      name: 'deploy',
      content: '#!/bin/sh\necho deploy\n',
      metadata: { label: 'Deploy' },
    });
  });

  it.each(['../settings', 'nested/script', 'nested\\script', '%2Fsettings', '.hidden', 'script name'])(
    'rejects hostile or malformed script name %j',
    async (name) => {
      await expect(getScript(name)).rejects.toMatchObject({
        message: 'Invalid script name',
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    },
  );
});
