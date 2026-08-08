/**
 * Mirror parity test for server/lib/githubRepoUrl.js ↔ client/src/lib/githubRepoUrl.js
 *
 * The server decides whether a captured URL gets cloned; the client previews
 * that decision by revealing the post-clone agent options (malware scan /
 * learn-from-repo) only for a repo URL. A drifted client either offers those
 * options for a link that will never be cloned, or hides them for one that will.
 *
 * Comparison strips comments, so the intentionally divergent header commentary
 * does not fail the test — only logic does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'githubRepoUrl.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/githubRepoUrl.js');

const MIRRORED_NAMES = [
  'SSH_REPO_RE',
  'HTTPS_REPO_RE',
  'parseGitHubUrl',
  'isGitHubRepoUrl',
];

describe('githubRepoUrl server↔client mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');

  it('both files are non-empty', () => {
    expect(serverSrc.length).toBeGreaterThan(100);
    expect(clientSrc.length).toBeGreaterThan(100);
  });

  for (const name of MIRRORED_NAMES) {
    it(`${name} is present and identical on both sides (code only)`, () => {
      const { serverDecl, clientDecl, serverNorm, clientNorm } =
        compareDeclaration(serverSrc, clientSrc, name);

      expect(serverDecl, `server/lib/githubRepoUrl.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/lib/githubRepoUrl.js is missing: ${name}`).not.toBeNull();
      expect(
        clientNorm,
        `"${name}" diverged — the server copy is authoritative; port the change verbatim`,
      ).toBe(serverNorm);
    });
  }
});
