/**
 * Shared source-comparison helpers for server↔client "mirror" parity tests.
 *
 * Several client modules are byte-for-byte mirrors of an authoritative server
 * module (see the "server mirrors" section of client/src/lib/README.md). Each
 * mirror is pinned by a `<name>.mirror.test.js` that extracts the mirrored
 * declarations from both files and diffs them with comments stripped, so
 * per-side commentary can diverge but logic cannot.
 *
 * Every such test needs the same two primitives, and hand-rolling them per
 * mirror means a bug in the brace-walker has to be found and fixed once per
 * copy — copies that had already drifted (one handled `async function`, the
 * other counted brackets) before this was extracted.
 *
 * Deliberately pure — no `vitest` import — so the server/lib barrel does not
 * pull a test framework into production. Callers own the assertions.
 */

/**
 * Strip single-line (`//`) and block (`/* … *\/`) comments, then collapse all
 * whitespace runs to a single space.
 *
 * This is what lets the two sides carry different commentary — only code
 * survives the normalization.
 */
export function stripCommentsAndNormalize(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Index of the delimiter matching the opener at `openIdx`, or -1 if unbalanced.
 * Counts `{}`, `()` and `[]` together — good enough for the declarations we
 * mirror, and the parity diff is textual anyway.
 */
function matchDelimiter(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract a top-level declaration by name — `function` / `async function` /
 * `const` (regex literal, array/object initializer, `Object.freeze(…)`, arrow
 * function). Returns the declaration text, or `null` when the name is absent
 * or its source is unbalanced.
 *
 * The two forms terminate differently, and conflating them is a trap worth
 * spelling out: a naive "walk to the first time depth returns to 0" returns
 * `function f(a)` — the closing paren of the PARAMETER LIST — so the entire
 * body escapes the parity diff and a gutted mirror passes green. Likewise it
 * truncates `const RE = /(?:a|b):\/\//i` at the non-capturing group's `)`.
 * So: a function is walked to the matching brace of its BODY, and a const to
 * its terminating `;`.
 */
export function extractDeclaration(src, name) {
  const startRe = new RegExp(`(?:export\\s+)?(?:async\\s+function|function|const)\\s+${name}[\\s=(]`);
  const match = startRe.exec(src);
  if (!match) return null;

  const start = match.index;

  if (/(?:async\s+)?function\s/.test(match[0])) {
    // Skip the parameter list, then return through the body's matching brace.
    const parenOpen = src.indexOf('(', start);
    if (parenOpen === -1) return null;
    const parenClose = matchDelimiter(src, parenOpen);
    if (parenClose === -1) return null;
    const braceOpen = src.indexOf('{', parenClose);
    if (braceOpen === -1) return null;
    const braceClose = matchDelimiter(src, braceOpen);
    return braceClose === -1 ? null : src.slice(start, braceClose + 1);
  }

  // `const`: run to the statement's terminating `;` at depth 0. This ends a
  // regex literal, an array/object initializer, and an arrow function alike.
  // Caveat: a `;` inside a top-level string/regex literal would end the slice
  // early — no mirrored declaration does that, and a full lexer isn't worth it
  // here. Every mirrored `const` must be semicolon-terminated.
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

/**
 * Compare one named declaration across two sources.
 *
 * Returns `{ serverDecl, clientDecl, serverNorm, clientNorm, match }` —
 * `*Decl` are null when absent, so a caller can tell "missing" apart from
 * "present but diverged" and assert each with its own message.
 */
export function compareDeclaration(serverSrc, clientSrc, name) {
  const serverDecl = extractDeclaration(serverSrc, name);
  const clientDecl = extractDeclaration(clientSrc, name);
  const serverNorm = serverDecl == null ? null : stripCommentsAndNormalize(serverDecl);
  const clientNorm = clientDecl == null ? null : stripCommentsAndNormalize(clientDecl);
  return {
    serverDecl,
    clientDecl,
    serverNorm,
    clientNorm,
    match: serverNorm != null && serverNorm === clientNorm,
  };
}

// A single-quoted JS string literal, escapes included, as written in source.
const STRING_LITERAL_RE = /'((?:[^'\\]|\\.)*)'/g;
// `new RegExp([ 'a', 'b' ].join('|'), 'i')` — the multi-line, per-alternative
// array form the server files use so each alternative can carry its own comment.
const ARRAY_FORM_RE = /new RegExp\(\s*\[(.*)\]\.join\('\|'\)\s*,\s*'i'\s*\)/;
// A `/…/i` regex literal, terminated by the statement's `;` or a `.test(` call.
// Greedy on purpose: `[-_/:]` puts an unescaped `/` mid-pattern, so a lazy walk
// would stop inside a character class.
const REGEX_LITERAL_RE = /\/(.*)\/i(?=\.test\(|;)/;

/**
 * The alternation source of a capability regex, whichever of the two forms the
 * declaration is typeset in — the array form above, or a plain `/…/i` literal.
 *
 * `/` is normalized (an escaped `\/` and a bare `/` mean the same thing to the
 * engine, and only one of them is legal inside a literal outside a character
 * class), so the two sides may differ in slash escaping but not in what they
 * accept. Returns null when the declaration is neither form.
 */
export function regexAlternationSource(declText) {
  if (declText == null) return null;
  const norm = stripCommentsAndNormalize(declText);
  const array = ARRAY_FORM_RE.exec(norm);
  const source = array
    ? [...array[1].matchAll(STRING_LITERAL_RE)]
      // Source text → string VALUE: `'llama-?3\\.[1-9]'` is the regex fragment
      // `llama-?3\.[1-9]`. Comparing the raw literals instead would report a
      // divergence on every escaped metacharacter.
      .map(([, body]) => body.replace(/\\(.)/g, '$1'))
      .join('|')
    : REGEX_LITERAL_RE.exec(norm)?.[1] ?? null;
  return source == null ? null : source.replace(/\\\//g, '/');
}

/**
 * Compare a case-insensitive regex mirrored across two files that spell it
 * differently — an array of per-alternative strings on one side, a single
 * inline literal on the other — by what it MATCHES rather than by its text.
 *
 * `compareDeclaration` can't be used there: the two typesettings never compare
 * equal even when they accept exactly the same ids, and forcing one side to
 * adopt the other's form is churn for no behavioural gain.
 *
 * `clientName` defaults to `serverName`; pass it when the client inlines the
 * pattern inside a differently-named predicate (`isToolUseModel` wrapping what
 * the server declares as `TOOL_USE_RE`).
 */
export function compareRegexDeclaration(serverSrc, clientSrc, serverName, clientName = serverName) {
  const serverDecl = extractDeclaration(serverSrc, serverName);
  const clientDecl = extractDeclaration(clientSrc, clientName);
  const serverSource = regexAlternationSource(serverDecl);
  const clientSource = regexAlternationSource(clientDecl);
  return {
    serverDecl,
    clientDecl,
    serverSource,
    clientSource,
    match: serverSource != null && serverSource === clientSource,
  };
}
