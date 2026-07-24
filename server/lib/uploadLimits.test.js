import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
    // attachments.js drifted to unreachable 100MB/50MB claims.
    for (const route of ['uploads.js', 'attachments.js', 'brainSongbook.js', 'screenshots.js']) {
      const src = read(`../routes/${route}`);
      expect(src, `${route} should import its cap from lib/uploadLimits.js`)
        .toContain("from '../lib/uploadLimits.js'");
      expect(src, `${route} re-derives a raw byte cap instead of importing one`)
        .not.toMatch(/const MAX_(FILE_SIZE|ATTACHMENT_SIZE)\s*=\s*\d+\s*\*/);
    }
  });
});
