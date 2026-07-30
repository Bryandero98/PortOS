import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { rmSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Point the screenshots root at a throwaway temp dir but keep every real helper
// (saveImageUpload, sanitizeFilename, detectImageFormat, ...) so this exercises
// the actual save pipeline, not a mock of it. Created inside the hoisted factory
// to avoid a TDZ on an outer const.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join: j } = await import('path');
  const root = mkdtempSync(j(tmpdir(), 'portos-shell-image-'));
  return { ...actual, PATHS: { ...actual.PATHS, screenshots: j(root, 'screenshots') } };
});

// The PTY registry is the one thing worth faking — a real shell session would
// spawn a process just to assert what got written to it.
vi.mock('../services/shell.js', () => ({
  getSession: vi.fn(),
  pasteToSession: vi.fn(() => true),
}));

import { PATHS } from '../lib/fileUtils.js';
import { getSession, pasteToSession } from '../services/shell.js';
import shellRoutes from './shell.js';

const buildApp = () => {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/shell', shellRoutes);
  app.use(errorMiddleware);
  return app;
};

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const pngBase64 = PNG_BYTES.toString('base64');
const SESSION = 'sess-abcdef123456';
const post = (body) => request(buildApp()).post(`/api/shell/sessions/${SESSION}/image`).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockReturnValue({ _id: 'sess-abc' });
  vi.mocked(pasteToSession).mockReturnValue(true);
});

afterAll(() => rmSync(dirname(PATHS.screenshots), { recursive: true, force: true }));

describe('POST /api/shell/sessions/:sessionId/image', () => {
  it('writes the bytes and pastes message + absolute path into the session', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.png', message: 'what is this?' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(SESSION);
    expect(res.body.filename).toMatch(/^shell-[0-9a-f]{8}-photo\.png$/);
    // The absolute path is never in the response — it would leak the install layout.
    expect(JSON.stringify(res.body)).not.toContain(PATHS.screenshots);

    const stored = join(PATHS.screenshots, res.body.filename);
    expect(readFileSync(stored)).toEqual(PNG_BYTES);
    expect(pasteToSession).toHaveBeenCalledWith(SESSION, `what is this?\n${stored}`, { label: 'image drop' });
  });

  it('pastes the bare path when no message is given', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.png' });
    expect(res.status).toBe(200);
    expect(pasteToSession).toHaveBeenCalledWith(
      SESSION,
      join(PATHS.screenshots, res.body.filename),
      { label: 'image drop' },
    );
  });

  it('uniquifies the stored name so a repeated camera-roll name cannot overwrite', async () => {
    const before = readdirSync(PATHS.screenshots).length;
    const a = await post({ data: pngBase64, filename: 'IMG_0001.png' });
    const b = await post({ data: pngBase64, filename: 'IMG_0001.png' });
    expect(a.body.filename).not.toBe(b.body.filename);
    // Two distinct files on disk, not one overwritten twice.
    expect(readdirSync(PATHS.screenshots).length - before).toBe(2);
  });

  it('404s without writing anything when the session is gone', async () => {
    vi.mocked(getSession).mockReturnValue(null);
    const before = readdirSync(PATHS.screenshots).length;
    const res = await post({ data: pngBase64, filename: 'photo.png' });
    expect(res.status).toBe(404);
    expect(readdirSync(PATHS.screenshots)).toHaveLength(before);
    expect(pasteToSession).not.toHaveBeenCalled();
  });

  // Nothing will ever read the file, and this bucket is shared with screenshot
  // uploads — an orphan here is indistinguishable from a real one.
  it('404s and removes the written file when the session dies mid-write', async () => {
    vi.mocked(pasteToSession).mockReturnValue(false);
    const before = readdirSync(PATHS.screenshots).length;
    const res = await post({ data: pngBase64, filename: 'photo.png' });
    expect(res.status).toBe(404);
    expect(readdirSync(PATHS.screenshots).length - before).toBe(0);
  });

  it('rejects bytes that are not a supported image', async () => {
    const res = await post({ data: Buffer.from('not an image at all').toString('base64'), filename: 'photo.png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_TYPE');
    expect(pasteToSession).not.toHaveBeenCalled();
  });

  // The extension comes from the bytes, so a mislabelled upload can't land on disk
  // advertising a type it isn't.
  it('stores a PNG as .png even when the client claims .jpg', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.jpg' });
    expect(res.body.filename.endsWith('.png')).toBe(true);
  });

  it('400s on a missing payload', async () => {
    const res = await post({ filename: 'photo.png' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400s on an over-long message', async () => {
    const res = await post({ data: pngBase64, filename: 'photo.png', message: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
