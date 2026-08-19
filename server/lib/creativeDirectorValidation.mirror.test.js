/**
 * Mirror parity for the Creative Director directive `goal` cap:
 * server/lib/creativeDirectorValidation.js ↔ client/src/lib/creativeDirectorPlan.js.
 *
 * The client uses it as the composer textarea's `maxLength` — a SILENT limit. The
 * Plan tab loads a commission-spawned project's directive into that composer for
 * editing, so a client cap below the schema's would drop the tail of a long goal
 * on save with no error, and the project would re-plan against the mutilated
 * brief. Compared as source text rather than by importing both modules (the
 * cheaper `issueLength.mirror.test.js` shape) because the client side of this
 * pair pulls in client-only packages that do not resolve in the server test env.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'creativeDirectorValidation.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/creativeDirectorPlan.js');

describe('creative director goal cap server↔client mirror parity', () => {
  it('CREATIVE_DIRECTOR_GOAL_MAX is declared identically on both sides', () => {
    const serverSrc = readFileSync(SERVER_PATH, 'utf8');
    const clientSrc = readFileSync(CLIENT_PATH, 'utf8');
    const { serverDecl, clientDecl, serverNorm, clientNorm } =
      compareDeclaration(serverSrc, clientSrc, 'CREATIVE_DIRECTOR_GOAL_MAX');

    expect(serverDecl, 'server creativeDirectorValidation.js is missing the cap').not.toBeNull();
    expect(clientDecl, 'client creativeDirectorPlan.js is missing the cap').not.toBeNull();
    expect(clientNorm, 'CREATIVE_DIRECTOR_GOAL_MAX diverged between server and client').toBe(serverNorm);
  });
});
