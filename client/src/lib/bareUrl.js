/**
 * Bare-URL detection — MIRROR of `server/lib/bareUrl.js` (authoritative there).
 *
 * The server files a capture whose entire text is a URL straight to the links
 * collection. The capture boxes preview that decision (the "will be saved to
 * Links" hint, and the Creative toggle it disables), so they must answer the
 * question exactly the way the server will — a looser client predicate promises
 * a filing the server won't perform.
 *
 * Port any change from the server copy verbatim; parity is enforced by
 * `server/lib/bareUrl.mirror.test.js`. (Distinct from `utils/urlNormalize.js`'s
 * `isUrl`, which answers a deliberately looser question for the Links quick-add.)
 */

// Explicit http(s) scheme — the URL constructor does the real validation below.
const HTTP_SCHEME_PATTERN = /^https?:\/\//i;

// SSH remote: git@host:owner/repo(.git)
const SSH_GIT_PATTERN = /^git@[a-z0-9.-]+:[\w.-]+\/[\w.-]+$/i;

// Scheme-less host[:port][/path] with a plausible alphabetic TLD:
// "example.com", "sub.example.co.uk/path?q=1", "example.com:8080/x".
const DOMAIN_LIKE_PATTERN = /^(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{2,5})?(?:[/?#]\S*)?$/i;

// Several ccTLDs double as common file extensions (`.md` Moldova, `.sh` St
// Helena, `.py` Paraguay…), so a scheme-less bare token like `notes.md` or
// `deploy.sh` is far more likely a filename in a note than a host. Only the
// scheme-less, path-less form is filtered — `https://foo.md` and `foo.md/page`
// still read as URLs. Digit-bearing extensions (`mp4`, `h264`) need no entry:
// DOMAIN_LIKE_PATTERN's all-alphabetic TLD already rejects them. Not exhaustive
// by construction — an extension that isn't also a plausible TLD can't reach here.
const FILE_EXTENSION_TAIL = new Set([
  'md', 'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'env', 'lock',
  'js', 'jsx', 'ts', 'tsx', 'css', 'html', 'htm', 'py', 'rb', 'sh', 'zsh', 'go', 'rs',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'tar', 'gz',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mov', 'wav'
]);

/**
 * True for a scheme-less, path-less `name.ext` whose tail is a known file
 * extension (`notes.md`) rather than a host.
 */
function looksLikeFilename(token) {
  if (/[/?#:]/.test(token)) return false;
  const tail = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
  return FILE_EXTENSION_TAIL.has(tail);
}

/**
 * If `text` is nothing but a single URL, return it normalized (an `https://`
 * scheme is prepended to a bare host). Returns null for free text, multi-token
 * input, a URL with surrounding prose, or a non-http(s)/git scheme.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function parseBareUrl(text) {
  const trimmed = (text ?? '').trim();
  // "Just a URL" means the whole capture is one token — any whitespace (a label,
  // a trailing note, a second URL) makes it a thought that mentions a link.
  if (!trimmed || /\s/.test(trimmed)) return null;

  if (SSH_GIT_PATTERN.test(trimmed)) return trimmed;

  let candidate = null;
  if (HTTP_SCHEME_PATTERN.test(trimmed)) {
    candidate = trimmed;
  } else if (DOMAIN_LIKE_PATTERN.test(trimmed) && !looksLikeFilename(trimmed)) {
    candidate = `https://${trimmed}`;
  }
  if (!candidate) return null;

  // Final gate: the parser rejects shapes the regexes let through (bad port,
  // malformed IPv6 host). The scheme needs no re-check — a candidate only exists
  // here because it matched `http(s)://` or had `https://` prepended.
  return URL.canParse(candidate) ? candidate : null;
}
