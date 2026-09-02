import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const BARRELS = new Set(['api.js']);

// Deliberate keeps — a one-line, reviewed decision rather than silent
// accumulation. CLIENT_BUILD_ID lives on socket.js (a build-injected identity
// for the stale-client check) and is listed here so a future api*.js keep
// follows the same seam.
const INTENTIONALLY_UNREFERENCED = Object.freeze(['CLIENT_BUILD_ID']);

const isTest = (name) => /\.test\.(js|jsx)$/.test(name);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(js|jsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

function collectNamedExports(src) {
  const names = new Set();
  let m;
  const decl = /^export (?:async function|function|const|let|var|class) (\w+)/gm;
  while ((m = decl.exec(src))) names.add(m[1]);
  const braced = /^export \{([^}]+)\}/gm;
  while ((m = braced.exec(src))) {
    for (const part of m[1].split(',')) {
      const bit = part.trim();
      if (!bit) continue;
      const as = bit.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

function identFiles(files) {
  const map = new Map();
  const ident = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const seen = new Set();
    let m;
    while ((m = ident.exec(src))) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      let arr = map.get(m[0]);
      if (!arr) map.set(m[0], arr = []);
      arr.push(file);
    }
  }
  return map;
}

function findDeadExports({ extra } = {}) {
  const all = walk(SRC_ROOT);
  const sources = all.filter((f) => !isTest(f));
  const apiFiles = readdirSync(HERE)
    .filter((f) => f.startsWith('api') && f.endsWith('.js') && !isTest(f) && f !== 'api.js')
    .map((f) => join(HERE, f));

  const corpus = sources.filter((f) => !BARRELS.has(relative(HERE, f)));
  const filesFor = identFiles(corpus);

  const dead = [];
  for (const file of apiFiles) {
    const names = collectNamedExports(readFileSync(file, 'utf8'));
    for (const name of names) {
      if (INTENTIONALLY_UNREFERENCED.includes(name)) continue;
      const hits = (filesFor.get(name) || []).filter((f) => f !== file);
      if (hits.length === 0) dead.push(`${relative(SRC_ROOT, file)}:${name}`);
    }
  }
  if (extra) {
    const hits = (filesFor.get(extra.name) || []).filter((f) => f !== extra.file);
    if (hits.length === 0 && !INTENTIONALLY_UNREFERENCED.includes(extra.name)) {
      dead.push(`${extra.file}:${extra.name}`);
    }
  }
  return dead;
}

describe('client API wrappers have callers', () => {
  it('lists no export referenced nowhere outside its module and the barrels', () => {
    const dead = findDeadExports();
    expect(dead, `caller-less wrappers:\n${dead.join('\n')}`).toEqual([]);
  });

  it('fails when a caller-less wrapper is added', () => {
    const dead = findDeadExports({
      extra: { file: 'services/apiFake.js', name: 'definitelyUnusedApiWrapper5727' },
    });
    expect(dead.some((row) => row.endsWith(':definitelyUnusedApiWrapper5727'))).toBe(true);
  });

  it('keeps the intentional-unreferenced allowlist explicit', () => {
    expect(INTENTIONALLY_UNREFERENCED).toEqual(['CLIENT_BUILD_ID']);
  });
});
// @vitest-environment node
