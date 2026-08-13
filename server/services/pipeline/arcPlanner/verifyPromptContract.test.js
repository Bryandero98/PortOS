/**
 * Contract between `pipeline-arc-verify.md` and the context `buildVerifyContext`
 * hands it. The prompt's checklist and the rendered context are two independent
 * lists that must agree, with nothing but this file enforcing it — and a
 * disagreement is not a cosmetic drift. The foundation gate's structure arm
 * reverts its whole repair whenever `verifyArc` leaves ANY blocker, so a check
 * that reads a field the context never renders produces a finding no resolver
 * can close, and the gate stalls forever on a plan with nothing wrong with it.
 *
 * Two instances of that class have shipped:
 *   1. check #6 read each episode's `arcRole`, which the leaf did not render, so
 *      every series reported "zero pilot/finale" on every pass;
 *   2. the prompt judged whether an entity was grounded in the world bible while
 *      rendering only `worldCanonText` — the named-canon trunks, which stay
 *      empty until prose mints entities. A world's actual factions/locations/
 *      technology live in `worldCategoriesText`, which the sibling
 *      `pipeline-arc-resolve.md` rendered and this prompt did not, so the
 *      verifier flagged locked faction cards as "absent from the World Canon"
 *      while the resolver could plainly see them.
 *
 * Both directions are covered below: record fields the prompt cites must be
 * renderable, and the verify/resolve pair must see the same world.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { renderVerifyIssueLeaf, renderVerifySeasonFields } from './context.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shippedPrompt = (name) => join(REPO_ROOT, 'data.reference', 'prompts', 'stages', name);

// Backticked tokens that are deliberately NOT record fields. Anything backticked
// in the prompt that is not here must be renderable — that is the whole point of
// the guard, so extend this list only for genuinely non-field vocabulary.
const NON_FIELD_TOKENS = new Set([
  // Output-contract vocabulary.
  'issues', 'severity', 'high', 'medium', 'low',
  // `arcRole` VALUES, not field names.
  'pilot', 'finale', 'complication', 'midpoint', 'b-plot', 'all-is-lost',
]);

const backtickedTokens = (markdown) => {
  const out = new Set();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    // Strip the illustrative value a check may attach (`episodeCountTarget: 12`)
    // and the array marker (`issues[]`) so the bare identifier is what's tested.
    const token = match[1].split(':')[0].replace(/\[\]$/, '').trim();
    // Only single identifiers are candidate record fields. JSON blobs, dotted
    // arc paths (`arc.themes` — an arc field, not a leaf/season one), and prose
    // fragments are not.
    if (/^[a-z][A-Za-z0-9]*$/.test(token)) out.add(token);
  }
  return out;
};

const renderableFields = () => new Set([
  ...Object.keys(renderVerifyIssueLeaf({ stages: { idea: { input: 'x' } } })),
  ...Object.keys(renderVerifySeasonFields({})),
]);

describe('pipeline-arc-verify prompt ↔ buildVerifyContext leaf contract', () => {
  it('renders every record field the shipped checklist cites', async () => {
    const markdown = await readFile(shippedPrompt('pipeline-arc-verify.md'), 'utf-8');
    const renderable = renderableFields();
    const unrenderable = [...backtickedTokens(markdown)]
      .filter((token) => !NON_FIELD_TOKENS.has(token) && !renderable.has(token));
    expect(unrenderable).toEqual([]);
  });

  it('fails when a cited field is dropped from the leaf (bypass probe)', () => {
    // Proves the assertion above has teeth: a checklist naming `arcRole` against
    // a leaf that no longer renders it must be caught, not silently pass.
    const citedByPrompt = backtickedTokens('Check the episode `arcRole` balance.');
    const leafWithoutArcRole = new Set(
      Object.keys(renderVerifyIssueLeaf({ stages: {} })).filter((k) => k !== 'arcRole'),
    );
    const unrenderable = [...citedByPrompt]
      .filter((token) => !NON_FIELD_TOKENS.has(token) && !leafWithoutArcRole.has(token));
    expect(unrenderable).toEqual(['arcRole']);
  });
});

describe('pipeline-arc-verify ↔ pipeline-arc-resolve world parity', () => {
  // `buildResolveContext` wraps `buildVerifyContext`, so the pair is fed from one
  // world bag. A world variable the resolver renders but the verifier does not is
  // exactly the asymmetry that manufactures unsatisfiable groundedness findings:
  // the verifier calls a canon entity invented, the resolver can see it is not.
  const worldVars = (markdown) => new Set(
    [...markdown.matchAll(/\{\{\{?(world[A-Za-z0-9]*)\}?\}\}/g)].map((m) => m[1]),
  );

  it('shows the verifier every world block the resolver can see', async () => {
    const [verify, resolve] = await Promise.all([
      readFile(shippedPrompt('pipeline-arc-verify.md'), 'utf-8'),
      readFile(shippedPrompt('pipeline-arc-resolve.md'), 'utf-8'),
    ]);
    const verifyVars = worldVars(verify);
    const missing = [...worldVars(resolve)].filter((v) => !verifyVars.has(v));
    expect(missing).toEqual([]);
  });

  it('renders the category canon the world actually defines', async () => {
    const markdown = await readFile(shippedPrompt('pipeline-arc-verify.md'), 'utf-8');
    expect(markdown).toContain('{{worldCategoriesText}}');
  });
});
