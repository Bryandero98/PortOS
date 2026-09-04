/**
 * Import-scoping guards (#6009).
 *
 * The Linux CI server suite spends more wall time importing modules than
 * running assertions, and almost none of that is any one test's fault: a
 * handful of widely-reached modules each pulled a subtree they only needed a
 * constant (or a boot-time function) from, and every test file downstream paid
 * for the whole thing. Narrowing those imports cut the suite's static module
 * instantiations — the sum, over all 1,588 server test files, of the modules in
 * each one's import closure — from ~115.5k to ~94.5k (-18%).
 *
 * That is a property nothing else in the tree defends, and it regresses
 * silently: re-pointing one of these imports back at the convenient barrel
 * still passes every behavioral test, it just quietly re-adds thousands of
 * module instantiations to CI. So each narrowing is pinned here as a negative
 * reachability assertion, paired with a positive control (per the contract in
 * `staticImportGraph.js`: a resolver gap must not be able to make the walk look
 * clean).
 *
 * BEFORE narrowing one of these — or any other production import — read the
 * "Import scoping" section of `server/AGENTS.md`. Bypassing a barrel that a
 * suite `vi.mock()`s reaches the real implementation instead of the double, and
 * the failure surfaces in an unrelated test file.
 */

import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { staticImportClosure } from './staticImportGraph.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// Server-relative POSIX paths, so a failure names `lib/db.js` rather than the
// absolute path of whoever's checkout is running the suite.
const abs = (relative) => join(SERVER_DIR, ...relative.split('/'));
const reaches = (entry, target) => staticImportClosure(abs(entry)).files.has(abs(target));

// Each row: the entry that was narrowed, the module it must no longer
// statically reach, and why the entry only ever needed a slice of it.
const NARROWED = [
  ['lib/db.js', 'lib/db/schema/index.js',
    'the DDL composer is boot-only — ensureSchemaImpl() imports it lazily'],
  ['lib/pipelineValidation.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SCOPES/CHECK_SEVERITIES, not the 13 check-definition modules'],
  ['lib/editorial/severityConfig.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SEVERITIES only'],
  ['services/pipeline/series.js', 'lib/editorial/checkRegistry.js',
    'needs CHECK_SEVERITIES only'],
  ['services/pipeline/applyCuts.js', 'lib/editorial/checkRegistry.js',
    'needs CUT_TYPES/SAFE_CUT_TYPES only'],
  ['services/apps.js', 'lib/validation.js',
    'needs sanitizeTaskMetadata, which cosValidation.js declares'],
  ['services/memoryEmbeddings.js', 'services/memoryBackend.js',
    'needs DEFAULT_MEMORY_CONFIG, which memoryConfig.js declares'],
  ['lib/llmRoutePin.js', 'lib/storyBible.js',
    'needs trimTo, which textUtils.js declares'],
  ['lib/slashdoInvocation.js', 'lib/tuiHandshake.js',
    'needs inferTuiCommand, which providerVendors.js declares'],
  ['services/voice/tools/pipeline.js', 'services/pipeline/issues.js',
    'needs NAVIGABLE_STAGE_IDS, which issuesShared.js declares'],
];

describe('narrowed imports stay narrow (#6009)', () => {
  it.each(NARROWED)('%s no longer statically reaches %s — it %s', (entry, target) => {
    expect(reaches(entry, target)).toBe(false);
  });

  // Positive controls. Without these the negatives above would also pass if
  // `staticImportClosure` stopped resolving these files at all.
  it('still sees the modules the narrowed entries were pointed AT', () => {
    expect(reaches('lib/pipelineValidation.js', 'lib/editorial/checkInfra/taxonomy.js')).toBe(true);
    expect(reaches('services/apps.js', 'lib/cosValidation.js')).toBe(true);
    expect(reaches('services/memoryEmbeddings.js', 'services/memoryConfig.js')).toBe(true);
    expect(reaches('lib/llmRoutePin.js', 'lib/textUtils.js')).toBe(true);
    expect(reaches('lib/slashdoInvocation.js', 'lib/providerVendors.js')).toBe(true);
    expect(reaches('services/voice/tools/pipeline.js', 'services/pipeline/issuesShared.js')).toBe(true);
  });

  // And a control on the other side: the barrels themselves still reach what
  // they re-export, so "nobody reaches checkRegistry" is a statement about the
  // narrowed callers, not about a broken registry.
  it('leaves the editorial barrel and the schema composer intact', () => {
    expect(reaches('lib/editorial/checkRegistry.js', 'lib/editorial/checks/proseStyle.js')).toBe(true);
    expect(reaches('lib/db/schema/index.js', 'lib/db/schema/catalog.js')).toBe(true);
  });
});
