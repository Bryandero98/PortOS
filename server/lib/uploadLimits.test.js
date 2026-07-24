import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  JSON_BODY_LIMIT,
  JSON_BODY_LIMIT_BYTES,
  MAX_BASE64_UPLOAD_BYTES,
  MAX_SCREENSHOT_BYTES,
} from './uploadLimits.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

describe('uploadLimits', () => {
  it('keeps JSON_BODY_LIMIT and its byte form in agreement', () => {
    const mb = Number(JSON_BODY_LIMIT.replace(/mb$/i, ''));
    expect(Number.isFinite(mb)).toBe(true);
    expect(JSON_BODY_LIMIT_BYTES).toBe(mb * 1024 * 1024);
  });

  it('derives a file cap that actually fits the body limit once base64-encoded', () => {
    // The whole point of the constant: base64 inflates by 4/3, so a raw file at
    // the cap must still encode to less than the body limit. A cap that fails
    // this is the opaque-413 bug it exists to prevent.
    const encoded = Math.ceil(MAX_BASE64_UPLOAD_BYTES / 3) * 4;
    expect(encoded).toBeLessThan(JSON_BODY_LIMIT_BYTES);
    // …and it should not be needlessly conservative: one more MB must overflow.
    const oneMbMore = Math.ceil((MAX_BASE64_UPLOAD_BYTES + 1024 * 1024) / 3) * 4;
    expect(oneMbMore).toBeGreaterThan(JSON_BODY_LIMIT_BYTES);
  });

  it('is a whole number of MB so the advertised limit reads cleanly', () => {
    expect(MAX_BASE64_UPLOAD_BYTES % (1024 * 1024)).toBe(0);
  });

  it('caps screenshots below the wire limit', () => {
    expect(MAX_SCREENSHOT_BYTES).toBeLessThan(MAX_BASE64_UPLOAD_BYTES);
  });

  it('is the only place the express body limit is written', () => {
    // server/index.js must consume JSON_BODY_LIMIT rather than re-hardcode it —
    // otherwise raising the limit here silently leaves the parser behind.
    const indexSrc = read('../index.js');
    expect(indexSrc).toContain('JSON_BODY_LIMIT');
    expect(indexSrc).not.toMatch(/express\.(json|urlencoded)\(\{\s*limit:\s*['"]/);
  });

  it('matches the client mirror, which cannot import this module', () => {
    // client/src/utils/fileUpload.js hardcodes the same number to size-check
    // before uploading. If it drifts high, the user picks a file the parser
    // then rejects with no message — the bug this constant exists to kill.
    const clientSrc = read('../../client/src/utils/fileUpload.js');
    const match = clientSrc.match(/JSON_UPLOAD_MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/);
    expect(match, 'client mirror not found — did JSON_UPLOAD_MAX_FILE_SIZE move?').toBeTruthy();
    expect(Number(match[1]) * 1024 * 1024).toBe(MAX_BASE64_UPLOAD_BYTES);
  });

  it('is the only place per-route upload caps are written', () => {
    // A route that re-derives its own byte cap is how uploads.js and
    // attachments.js drifted to unreachable 100MB/50MB claims. Discover the
    // routes rather than listing them, so a NEW upload route added later is
    // covered too — a hardcoded list would leave it unguarded.
    // Detect the base64-in-JSON transport specifically — decoding a base64 body
    // or handing one to saveBase64Upload. Routes that take RAW bytes via
    // express.raw() (imageClean.js) carry their own limit and are correctly out
    // of scope: no ×4/3 inflation applies to them.
    const routesDir = join(HERE, '../routes');
    const uploadRoutes = readdirSync(routesDir)
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .filter((f) => /Buffer\.from\([^)]*'base64'\)|saveBase64Upload/
        .test(readFileSync(join(routesDir, f), 'utf8')));
    expect(uploadRoutes.length, 'no upload routes discovered — did the detection heuristic break?')
      .toBeGreaterThanOrEqual(4);

    for (const route of uploadRoutes) {
      const src = readFileSync(join(routesDir, route), 'utf8');
      // Assert the route USES a shared constant (positive), rather than
      // pattern-matching for the absence of one literal spelling — a route
      // could hardcode `= 52428800` under any name and slip past that.
      expect(src, `${route} must take its cap from lib/uploadLimits.js`)
        .toMatch(/MAX_BASE64_UPLOAD_BYTES|MAX_SCREENSHOT_BYTES/);
      // Belt-and-braces: no raw MB-shaped byte literal left in an upload route.
      expect(src, `${route} still hardcodes a raw byte cap`)
        .not.toMatch(/=\s*\d+\s*\*\s*1024\s*\*\s*1024/);
    }
  });

  it('matches the client mirror of the screenshot cap', () => {
    // Screenshots have their own (smaller, product-chosen) cap. It is mirrored
    // client-side too, so it needs the same drift guard as the wire limit —
    // otherwise raising one side silently leaves the other rejecting.
    const clientSrc = read('../../client/src/utils/fileUpload.js');
    const match = clientSrc.match(/SCREENSHOT_MAX_FILE_SIZE = (\d+) \* 1024 \* 1024/);
    expect(match, 'client screenshot mirror not found — did SCREENSHOT_MAX_FILE_SIZE move?').toBeTruthy();
    expect(Number(match[1]) * 1024 * 1024).toBe(MAX_SCREENSHOT_BYTES);
  });
});
