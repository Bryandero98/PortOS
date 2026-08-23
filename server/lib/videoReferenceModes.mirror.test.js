/**
 * Mirror parity test for server/lib/videoReferenceModes.js ↔
 * client/src/lib/videoReferenceModes.js
 *
 * The server decides whether a reference mode is honorable; the client only
 * previews that decision (which options to offer, what promise to print, what
 * conditioning strength will actually apply). A drifted client offers Inspire
 * on a runtime that pins frame one — the exact silent downgrade this contract
 * exists to prevent.
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

const SERVER_PATH = resolve(__dirname, 'videoReferenceModes.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/lib/videoReferenceModes.js');

const MIRRORED_NAMES = [
  'I2V_REFERENCE_MODES',
  'DEFAULT_I2V_REFERENCE_MODE',
  'I2V_REFERENCE_MODE_OPTIONS',
  'I2V_REFERENCE_MODE_RUNTIMES',
  'INSPIRE_DEFAULT_IMAGE_STRENGTH',
  'normalizeI2vReferenceMode',
  'isDefaultI2vReferenceMode',
  'isKnownI2vReferenceMode',
  'runtimeSupportsI2vReferenceMode',
  'i2vReferenceModeLabel',
  'resolveI2vReferenceStrength',
  'i2vReferenceModeViolation',
];

describe('videoReferenceModes server↔client mirror parity', () => {
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

      expect(serverDecl, `server/lib/videoReferenceModes.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client/src/lib/videoReferenceModes.js is missing: ${name}`).not.toBeNull();
      expect(
        clientNorm,
        `"${name}" diverged — the server copy is authoritative; port the change verbatim`,
      ).toBe(serverNorm);
    });
  }
});
