/**
 * Directory-driven guard for the schema composer (#5682).
 *
 * schema.test.js pins the composer against a HAND-WRITTEN list of module
 * names, so it can only check the modules someone remembered to add to it.
 * This file derives its expectations from `readdirSync` instead, which is the
 * half that catches the real failure mode: adding
 * `server/lib/db/schema/foo.js` and wiring only the `import` + `export {}`
 * block ships a module whose `CREATE TABLE` never runs, so a fresh install
 * (and every peer install upgrading) is missing the table and the feature
 * fails at first query with a Postgres `relation does not exist`.
 *
 * The directory-level barrel/README guard in server/lib/index.test.js does not
 * reach here — its `readdirSync` is non-recursive — hence this local copy of
 * the same contract, modeled on server/lib/editorial/checkInfraBarrel.test.js.
 *
 * Out of scope: DDL statement text and ordering (schema.test.js and
 * db.catalogDdlParity.test.js own those).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildUpgradeDdl, buildCatalogDdl } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BARREL_SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
const README_SRC = readFileSync(join(HERE, 'README.md'), 'utf8');

const MODULE_FILES = readdirSync(HERE)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'index.js')
  .sort();

// Membership is checked statement-by-statement rather than by array identity,
// because a module legitimately contributes more than one separately-positioned
// array (catalog.js → `catalogDdl` + `catalogUserTypesDdl`) and audit.js
// contributes `auditDdl` plus the generated `buildAuditTriggers()`. Checking
// EVERY statement — not just the array's first — also catches a composer that
// spreads only part of an array. Membership encodes no ordering: statement
// order stays schema.test.js's job.
const COMPOSED_STATEMENTS = new Set([...buildUpgradeDdl(), ...buildCatalogDdl()]);

describe('db/schema composer covers every module in the directory (#5682)', () => {
  it('found the domain modules', () => {
    expect(MODULE_FILES.length).toBeGreaterThan(0);
  });

  it('index.js imports every non-test module', () => {
    for (const f of MODULE_FILES) {
      expect(BARREL_SRC, `db/schema/${f} is never imported by index.js`).toContain(`'./${f}'`);
    }
  });

  it.each(MODULE_FILES)('%s exports at least one *Ddl array and every statement is composed', async (f) => {
    const mod = await import(`./${f}`);
    const ddlExports = Object.entries(mod).filter(([name]) => name.endsWith('Ddl'));

    // Naming convention is the hook this guard hangs on: a module exporting no
    // `*Ddl` array would silently opt out of the composition check below.
    expect(ddlExports.length, `${f} exports no *Ddl array (see README.md for the convention)`)
      .toBeGreaterThan(0);

    for (const [name, statements] of ddlExports) {
      expect(Array.isArray(statements), `${f} export '${name}' is not an array`).toBe(true);
      expect(statements.length, `${f} export '${name}' is empty`).toBeGreaterThan(0);
      const uncomposed = statements.filter((sql) => !COMPOSED_STATEMENTS.has(sql));
      expect(
        uncomposed.length,
        `${f} export '${name}' has ${uncomposed.length} statement(s) that never run — spread it into `
          + `buildUpgradeDdl() or buildCatalogDdl() in index.js. First: ${uncomposed[0]?.slice(0, 120)}`,
      ).toBe(0);
    }
  });

  it('every non-test module has a backtick-wrapped README row', () => {
    // Require the documented-row form (`module.js`) rather than a bare
    // substring, so a name appearing only in prose can't satisfy the guard.
    for (const f of MODULE_FILES) {
      expect(README_SRC, `missing README row for db/schema/${f}`).toContain('`' + f + '`');
    }
  });
});
// @vitest-environment node
