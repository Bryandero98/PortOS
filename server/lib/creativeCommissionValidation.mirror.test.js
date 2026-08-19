/**
 * Mirror parity for the commission BRIEF field caps: server/lib/creativeCommissionValidation.js
 * ↔ client/src/components/creative-commission/commissionForm.js.
 *
 * The client uses these as the textarea/input `maxLength`, which is a SILENT
 * limit — the browser simply stops accepting characters, with no validation
 * error to explain why a pasted brief lost its tail. A client cap below the
 * server's therefore truncates the user's brief invisibly, and one above it
 * turns a paste into a 400 at save time. Both are drift the suite should catch,
 * so the caps are asserted identical rather than left to convention.
 *
 * Only the numbers are mirrored — the schemas themselves stay server-side.
 * Compared as source text rather than by importing both modules (the cheaper
 * `issueLength.mirror.test.js` shape) because the client side of this pair pulls
 * in client-only packages that do not resolve in the server test env.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compareDeclaration } from './mirrorParity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = resolve(__dirname, 'creativeCommissionValidation.js');
const CLIENT_PATH = resolve(__dirname, '../../client/src/components/creative-commission/commissionForm.js');

const MIRRORED_NAMES = [
  'COMMISSION_NAME_MAX',
  'COMMISSION_INTENT_MAX',
  'COMMISSION_STYLE_SPEC_MAX',
  'COMMISSION_BRIEF_TAG_MAX',
];

describe('creative commission brief caps server↔client mirror parity', () => {
  const serverSrc = readFileSync(SERVER_PATH, 'utf8');
  const clientSrc = readFileSync(CLIENT_PATH, 'utf8');

  for (const name of MIRRORED_NAMES) {
    it(`${name} is declared identically on both sides`, () => {
      const { serverDecl, clientDecl, serverNorm, clientNorm } =
        compareDeclaration(serverSrc, clientSrc, name);

      expect(serverDecl, `server creativeCommissionValidation.js is missing: ${name}`).not.toBeNull();
      expect(clientDecl, `client commissionForm.js is missing: ${name}`).not.toBeNull();
      expect(clientNorm, `"${name}" diverged between server and client`).toBe(serverNorm);
    });
  }
});
