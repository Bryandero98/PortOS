/**
 * Mirror parity test for server/lib/bareUrl.js ↔ client/src/lib/bareUrl.js
 *
 * The server decides where a capture is filed; the client only previews that
 * decision ("that's a URL — it will be saved to Links", and the Creative toggle
 * it disables). A drifted client promises a filing the server won't perform —
 * exactly the lie this mirror exists to prevent.
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

const SERVER_PATH = resolve(__dirname, 'bareUrl.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/bareUrl.js');

const MIRRORED_NAMES = [
  'HTTP_SCHEME_PATTERN',
  'SSH_GIT_PATTERN',
  'DOMAIN_LIKE_PATTERN',
  'FILE_EXTENSION_TAIL',
  'looksLikeFilename',
  'parseBareUrl',
];

describe('bareUrl server↔client mirror parity', () => {
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

      expect(serverDecl, `server/lib/bareUrl.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/lib/bareUrl.js is missing: ${name}`).not.toBeNull();
      expect(
        clientNorm,
        `"${name}" diverged — the server copy is authoritative; port the change verbatim`,
      ).toBe(serverNorm);
    });
  }
});
