/**
 * Build the client-side filename for a Universe Markdown world-bible export.
 *
 * This mirrors the server's `universeMarkdownFilename` contract so a file
 * saved by the browser has the same safe name as the response attachment.
 * Contract cases live in `universeMarkdownFilename.cases.js` and are shared
 * by the client and server tests.
 */

export const slugifyUniverseName = (name) => String(name ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'universe';

export const universeMarkdownFilename = (name) => `${slugifyUniverseName(name)}.md`;
