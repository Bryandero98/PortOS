/**
 * Structured pr-reviewer report → GitHub markdown.
 *
 * Stage 3 of the pr-reviewer pipeline used to hand the coordinator one
 * `summary` string, which was posted verbatim as the review body: a single
 * unbroken wall of prose mixing the verdict, the test evidence, every verified
 * claim, and the blocking problem. Reviews are read by a human on the PR page,
 * so the model now returns those as separate fields and the deterministic
 * coordinator renders the markdown. The model never composes markup, which
 * keeps rendering (and its length budget) on the trusted side of the boundary.
 *
 * Every field is optional and a plain-string `summary` still renders, so an
 * older stage body — or a model that ignores the structured shape — degrades to
 * the previous single-paragraph review rather than losing its review entirely.
 *
 * Pure: no I/O, no forge calls.
 */

/** GitHub accepts far more, but a review a human can scan stays bounded. */
export const MAX_REVIEW_BODY_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_SCOPE_CHARS = 400;
const MAX_BULLET_CHARS = 600;
const MAX_BULLETS = 12;
const MAX_FINDING_TITLE_CHARS = 160;
const MAX_FINDING_BODY_CHARS = 3_000;
const MAX_SUGGESTION_CHARS = 2_000;
const TEST_STATUSES = ['pass', 'fail', 'not-run'];
const STATUS_ICON = { pass: '✅', fail: '❌', 'not-run': '⏭️' };
const TRIM_NOTE = '_Some sections of this review were omitted to stay within the comment size limit._';

const VERDICT_BANNER = {
  approve: '✅ **Approved**',
  request_changes: '🔴 **Changes requested**',
  defer: '💬 **Review — no verdict yet**',
};

/** Collapse whitespace runs so a model paragraph cannot inject list/heading markup mid-line. */
function line(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keep author paragraph breaks, drop trailing whitespace and runaway blank lines. */
function block(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

function bullets(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => line(item, MAX_BULLET_CHARS)).filter(Boolean).slice(0, MAX_BULLETS);
}

function normalizeTestEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const command = line(item?.command, MAX_BULLET_CHARS);
      const detail = line(item?.detail, MAX_BULLET_CHARS);
      if (!command && !detail) return null;
      const status = TEST_STATUSES.includes(item?.status) ? item.status : 'not-run';
      return { command, status, detail };
    })
    .filter(Boolean)
    .slice(0, MAX_BULLETS);
}

/**
 * Normalize the optional structured report fields of one stage-3 PR decision.
 * Unknown/malformed entries drop out; the caller still owns verdict, findings,
 * and every forge-state check.
 */
export function normalizeReviewReport(raw) {
  return {
    summary: block(raw?.summary, MAX_SUMMARY_CHARS),
    scope: line(raw?.scope, MAX_SCOPE_CHARS),
    testEvidence: normalizeTestEvidence(raw?.testEvidence),
    verified: bullets(raw?.verified),
    concerns: bullets(raw?.concerns),
  };
}

/** Normalize the presentation fields of one inline finding (anchoring stays with the caller). */
export function normalizeFindingPresentation(raw) {
  const suggestion = block(raw?.suggestion, MAX_SUGGESTION_CHARS);
  return {
    title: line(raw?.title, MAX_FINDING_TITLE_CHARS),
    body: block(raw?.body, MAX_FINDING_BODY_CHARS),
    // A fenced block inside the suggestion would close GitHub's own fence and
    // spill the rest of the comment into the diff as an applyable patch.
    suggestion: suggestion.includes('```') ? '' : suggestion,
  };
}

/** Every model-authored string in a report, for the model-abuse scan. */
export function reviewReportText(raw) {
  const report = normalizeReviewReport(raw);
  return [
    report.summary,
    report.scope,
    ...report.testEvidence.flatMap((item) => [item.command, item.detail]),
    ...report.verified,
    ...report.concerns,
  ].filter(Boolean);
}

/** Markdown for one inline review comment. */
export function renderFindingBody(finding, { blocking = true } = {}) {
  const { title, body, suggestion } = normalizeFindingPresentation(finding);
  const label = blocking ? '⛔ **Blocking**' : '💡 **Non-blocking**';
  return [
    title ? `${label} — ${title}` : label,
    '',
    body,
    ...(suggestion ? ['', '```suggestion', suggestion, '```'] : []),
  ].join('\n').trim();
}

function findingsSection(findings, heading, icon) {
  if (findings.length === 0) return null;
  return [
    `#### ${icon} ${heading} (${findings.length})`,
    ...findings.map(({ comment, presentation }) => {
      const label = presentation.title || line(presentation.body, 160);
      return `- \`${comment.path}:${comment.line}\` — ${label}`;
    }),
  ].join('\n');
}

/**
 * Render the review body a human reads on the PR page. Sections are emitted in
 * priority order and dropped from the end once the budget is spent, so a long
 * report loses its least important section instead of being cut mid-sentence.
 */
export function renderReviewBody({
  report,
  verdict,
  blockingFindings = [],
  nonBlockingFindings = [],
  appendix = '',
} = {}) {
  const normalized = normalizeReviewReport(report);
  const sections = [
    VERDICT_BANNER[verdict] || VERDICT_BANNER.defer,
    normalized.summary || 'This change needs follow-up before it can merge.',
    normalized.scope ? `**Scope:** ${normalized.scope}` : null,
    findingsSection(blockingFindings, 'Blocking', '⛔'),
    findingsSection(nonBlockingFindings, 'Non-blocking', '💡'),
    normalized.testEvidence.length > 0
      ? ['#### Test evidence', ...normalized.testEvidence.map((item) => {
        const icon = STATUS_ICON[item.status];
        const head = item.command ? `\`${item.command}\`` : item.detail;
        const tail = item.command && item.detail ? ` — ${item.detail}` : '';
        return `- ${icon} ${head}${tail}`;
      })].join('\n')
      : null,
    normalized.concerns.length > 0
      ? ['#### Notes', ...normalized.concerns.map((item) => `- ${item}`)].join('\n')
      : null,
    normalized.verified.length > 0
      ? ['<details><summary>Claims verified against the code</summary>', '',
        ...normalized.verified.map((item) => `- ${item}`), '</details>'].join('\n')
      : null,
    block(appendix, MAX_SUMMARY_CHARS) || null,
  ].filter(Boolean);

  const kept = [];
  // Reserve room for the trim note so adding it cannot push the body past the cap.
  const budget = MAX_REVIEW_BODY_CHARS - TRIM_NOTE.length - 2;
  let used = 0;
  let dropped = false;
  for (const section of sections) {
    const cost = section.length + 2;
    if (used + cost > budget) {
      dropped = true;
      continue;
    }
    kept.push(section);
    used += cost;
  }
  if (dropped) kept.push(TRIM_NOTE);
  return kept.join('\n\n');
}
