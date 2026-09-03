import { describe, expect, it } from 'vitest';
import {
  MAX_REVIEW_BODY_CHARS,
  normalizeReviewReport,
  renderFindingBody,
  renderReviewBody,
  reviewReportText,
} from './prReviewReport.js';

const finding = (path, line, presentation) => ({
  comment: { path, line, side: 'RIGHT', body: 'rendered' },
  presentation: { title: '', body: '', suggestion: '', ...presentation },
});

describe('renderReviewBody', () => {
  it('renders a full structured report as scannable markdown sections', () => {
    const body = renderReviewBody({
      verdict: 'request_changes',
      report: {
        summary: 'The docs are accurate, but the prescribed install command contradicts the repo install path.',
        scope: 'docs-only change to two files under docs/',
        testEvidence: [
          { command: 'npm test -w server', status: 'pass', detail: '412 passed' },
          { command: 'npx vitest', status: 'not-run', detail: 'no node_modules in the disposable worktree' },
        ],
        verified: ['update.sh always ends on main — update.sh:132-143'],
        concerns: ['The Windows entry point is not mentioned.'],
      },
      blockingFindings: [finding('docs/SELF_UPDATE.md', 108, { title: 'Bare npm install dirties tracked lockfiles' })],
      nonBlockingFindings: [finding('docs/SELF_UPDATE.md', 112, { title: 'Ordering rationale is downstream of line 108' })],
    });

    expect(body).toContain('🔴 **Changes requested**');
    expect(body).toContain('**Scope:** docs-only change to two files under docs/');
    expect(body).toContain('#### ⛔ Blocking (1)');
    expect(body).toContain('- `docs/SELF_UPDATE.md:108` — Bare npm install dirties tracked lockfiles');
    expect(body).toContain('#### 💡 Non-blocking (1)');
    expect(body).toContain('#### Test evidence');
    expect(body).toContain('- ✅ `npm test -w server` — 412 passed');
    expect(body).toContain('- ⏭️ `npx vitest` — no node_modules in the disposable worktree');
    expect(body).toContain('#### Notes');
    expect(body).toContain('<details><summary>Claims verified against the code</summary>');
  });

  it('still renders a legacy plain-string summary with no structured fields', () => {
    const body = renderReviewBody({ verdict: 'approve', report: { summary: 'Looks good.' } });
    expect(body).toBe('✅ **Approved**\n\nLooks good.');
  });

  it('falls back to a verdict banner and default sentence when the report is empty', () => {
    expect(renderReviewBody({ verdict: 'defer', report: {} }))
      .toContain('💬 **Review — no verdict yet**');
    expect(renderReviewBody({})).toContain('This change needs follow-up before it can merge.');
  });

  it('appends the coordinator appendix as its own section', () => {
    const body = renderReviewBody({
      verdict: 'request_changes',
      report: { summary: 'Two problems.' },
      appendix: 'PortOS could not anchor one or more reported findings to this diff.',
    });
    expect(body.endsWith('PortOS could not anchor one or more reported findings to this diff.')).toBe(true);
  });

  it('drops whole low-priority sections instead of truncating mid-sentence', () => {
    const verified = Array.from({ length: 12 }, (_, i) => `${i} ${'v'.repeat(600)}`);
    const body = renderReviewBody({
      verdict: 'approve',
      report: {
        summary: 'x'.repeat(2_000),
        testEvidence: [{ command: 'npm test', status: 'pass', detail: 'green' }],
        concerns: ['One note.'],
        // 12 x ~600 chars overruns what is left of the budget on its own.
        verified,
      },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY_CHARS);
    expect(body).toContain('_Some sections of this review were omitted');
    // Verified claims are the lowest-priority section, so that whole section
    // goes; the sections above it survive intact rather than being cut short.
    expect(body).not.toContain('Claims verified against the code');
    expect(body).toContain('x'.repeat(2_000));
    expect(body).toContain('- ✅ `npm test` — green');
    expect(body).toContain('#### Notes\n- One note.');
  });
});

describe('renderFindingBody', () => {
  it('labels a blocking finding and renders an applyable suggestion block', () => {
    const body = renderFindingBody({
      title: 'Use the repo install path',
      body: 'Bare `npm install` rewrites tracked lockfiles.',
      suggestion: 'for d in . client server autofixer; do (cd "$d" && npm install --no-save); done',
    });
    expect(body).toBe([
      '⛔ **Blocking** — Use the repo install path',
      '',
      'Bare `npm install` rewrites tracked lockfiles.',
      '',
      '```suggestion',
      'for d in . client server autofixer; do (cd "$d" && npm install --no-save); done',
      '```',
    ].join('\n'));
  });

  it('labels a non-blocking finding and omits an absent suggestion', () => {
    const body = renderFindingBody({ body: 'Consider naming Windows too.' }, { blocking: false });
    expect(body).toBe('💡 **Non-blocking**\n\nConsider naming Windows too.');
  });

  it('drops a suggestion containing a fence so it cannot break out of the code block', () => {
    const body = renderFindingBody({ body: 'x', suggestion: '```\nrm -rf /\n```' });
    expect(body).not.toContain('```');
  });
});

describe('normalizeReviewReport', () => {
  it('collapses newlines in single-line fields so a model cannot inject headings', () => {
    const report = normalizeReviewReport({ scope: 'docs\n\n## Injected heading', verified: ['a\n- b'] });
    expect(report.scope).toBe('docs ## Injected heading');
    expect(report.verified).toEqual(['a - b']);
  });

  it('defaults an unknown test status to not-run and drops empty entries', () => {
    const report = normalizeReviewReport({ testEvidence: [{ command: 'a', status: 'green' }, {}, { detail: 'b' }] });
    expect(report.testEvidence).toEqual([
      { command: 'a', status: 'not-run', detail: '' },
      { command: '', status: 'not-run', detail: 'b' },
    ]);
  });
});

describe('reviewReportText', () => {
  it('exposes every model-authored string so the abuse scan sees the new fields', () => {
    expect(reviewReportText({
      summary: 'a', scope: 'b',
      testEvidence: [{ command: 'c', status: 'pass', detail: 'd' }],
      verified: ['e'], concerns: ['f'],
    })).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
