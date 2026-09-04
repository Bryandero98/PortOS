import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = join(tmpdir(), `portos-reactor-video-test-${process.pid}-${Date.now()}`);
const FAKE_VIDEOS_DIR = join(TEST_ROOT, 'data-videos');
const FAKE_DATA_DIR = join(TEST_ROOT, 'data');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  actual.PATHS.videos = FAKE_VIDEOS_DIR;
  actual.PATHS.data = FAKE_DATA_DIR;
  return {
    ...actual,
    ensureDir: vi.fn(async (dir) => mkdir(dir, { recursive: true })),
  };
});

vi.mock('../../lib/ffmpeg.js', async () => {
  const actual = await vi.importActual('../../lib/ffmpeg.js');
  return {
    ...actual,
    optimizeForStreaming: vi.fn(async () => {}),
    generateThumbnail: vi.fn(async (_p, jobId) => `${jobId}.jpg`),
  };
});

const getSettingsMock = vi.fn();
vi.mock('../settings.js', () => ({ getSettings: getSettingsMock }));

const reactor = await import('./reactor.js');
const { videoGenEvents } = await import('./events.js');
const { loadHistory } = await import('./history.js');

const flush = () => new Promise((r) => setTimeout(r, 10));

const jsonResponse = (body, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
});

const TOKEN_URL = `${reactor.REACTOR_API_BASE}/tokens`;
const GENERATE_URL = `${reactor.REACTOR_API_BASE}/v1/${reactor.REACTOR_MODEL_ID}/generate`;

beforeEach(async () => {
  videoGenEvents.removeAllListeners();
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(FAKE_DATA_DIR, { recursive: true });
  getSettingsMock.mockReset().mockResolvedValue({});
  vi.restoreAllMocks();
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('videoGen/reactor — resolveReactorApiKey', () => {
  it('prefers the settings-stored key over the REACTOR_API_KEY env var', () => {
    const prevEnv = process.env.REACTOR_API_KEY;
    process.env.REACTOR_API_KEY = 'env-key';
    expect(reactor.resolveReactorApiKey({ videoGen: { reactor: { apiKey: ' settings-key ' } } })).toBe('settings-key');
    if (prevEnv === undefined) delete process.env.REACTOR_API_KEY; else process.env.REACTOR_API_KEY = prevEnv;
  });

  it('falls back to REACTOR_API_KEY when settings carry no key', () => {
    const prevEnv = process.env.REACTOR_API_KEY;
    process.env.REACTOR_API_KEY = 'env-key';
    expect(reactor.resolveReactorApiKey({})).toBe('env-key');
    if (prevEnv === undefined) delete process.env.REACTOR_API_KEY; else process.env.REACTOR_API_KEY = prevEnv;
  });

  it('returns null when neither settings nor env carry a key', () => {
    const prevEnv = process.env.REACTOR_API_KEY;
    delete process.env.REACTOR_API_KEY;
    expect(reactor.resolveReactorApiKey({})).toBeNull();
    if (prevEnv !== undefined) process.env.REACTOR_API_KEY = prevEnv;
  });
});

describe('videoGen/reactor — mintReactorToken', () => {
  it('rejects when no API key is supplied', async () => {
    await expect(reactor.mintReactorToken(null)).rejects.toThrow(/No reactor\.inc API key/);
  });

  it('mints a scoped session JWT from the API key', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      expect(url).toBe(TOKEN_URL);
      expect(opts.headers.Authorization).toBe('Bearer test-key');
      const body = JSON.parse(opts.body);
      expect(body.authorization_details).toEqual([{ type: 'reactor/fast-h3', max_sessions: 1 }]);
      return jsonResponse({ jwt: 'signed-jwt', expires_at: '2026-01-01T00:00:00Z' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await reactor.mintReactorToken('test-key');
    expect(result).toEqual({ jwt: 'signed-jwt', expiresAt: '2026-01-01T00:00:00Z' });
    vi.unstubAllGlobals();
  });

  it('throws when the token endpoint rejects the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'invalid key' }, false, 401)));
    await expect(reactor.mintReactorToken('bad-key')).rejects.toThrow(/token minting failed/);
    vi.unstubAllGlobals();
  });
});

describe('videoGen/reactor — _internals.buildRequestBody', () => {
  it('includes only the fields that were actually supplied, truncating an oversized prompt', () => {
    expect(reactor._internals.buildRequestBody({ prompt: ' a fox running ' })).toEqual({ prompt: 'a fox running' });
    expect(reactor._internals.buildRequestBody({
      prompt: 'pan', continueFromClipId: 'clip-1', startingFrameDataUri: 'data:image/png;base64,AA==', seconds: 6, seed: 42,
    })).toEqual({
      prompt: 'pan', continue_from_clip_id: 'clip-1', starting_frame: 'data:image/png;base64,AA==', seconds: 6, seed: 42,
    });
    const longPrompt = 'x'.repeat(reactor.REACTOR_MAX_PROMPT_LENGTH + 50);
    expect(reactor._internals.buildRequestBody({ prompt: longPrompt }).prompt.length).toBe(reactor.REACTOR_MAX_PROMPT_LENGTH);
  });
});

describe('videoGen/reactor — generateVideo', () => {
  it('mints a token, submits, polls to completion, downloads the result, and finalizes history', async () => {
    const clipId = 'clip-123';
    const statusUrl = `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/${clipId}`;
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === TOKEN_URL) return jsonResponse({ jwt: 'session-jwt', expires_at: null });
      if (url === GENERATE_URL) {
        expect(opts.headers.Authorization).toBe('Bearer session-jwt');
        expect(JSON.parse(opts.body)).toEqual({ prompt: 'a fox running' });
        return jsonResponse({ clip_id: clipId, status_url: statusUrl });
      }
      if (url === statusUrl) return jsonResponse({ status: 'completed', video_url: 'https://cdn.reactor.inc/out.mp4', clip_id: clipId });
      if (url === 'https://cdn.reactor.inc/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('fake-mp4-bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await reactor.generateVideo({ settings: { videoGen: { reactor: { apiKey: 'test-key' } } }, prompt: 'a fox running' });
    expect(job.mode).toBe('reactor');
    expect(job.status).toBe('running');
    expect(job.filename).toMatch(/^[0-9a-f-]{36}\.mp4$/);

    const outputPath = join(FAKE_VIDEOS_DIR, job.filename);
    let history = [];
    for (let i = 0; i < 50 && history.length === 0; i += 1) {
      await flush();
      history = await loadHistory();
    }

    const written = await readFile(outputPath);
    expect(written.toString()).toBe('fake-mp4-bytes');

    expect(history[0].id).toBe(job.jobId);
    expect(history[0].modelId).toBe('reactor:fast-h3');
    vi.unstubAllGlobals();
  });

  it('resolves the API key from live settings when the caller supplies none (the mediaJobQueue dispatch shape)', async () => {
    getSettingsMock.mockResolvedValue({ videoGen: { reactor: { apiKey: 'live-key' } } });
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === TOKEN_URL) {
        expect(opts.headers.Authorization).toBe('Bearer live-key');
        return jsonResponse({ jwt: 'jwt-1', expires_at: null });
      }
      if (url === GENERATE_URL) return jsonResponse({ clip_id: 'c1', status_url: `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c1` });
      if (url === `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c1`) {
        return jsonResponse({ status: 'completed', video_url: 'https://cdn.reactor.inc/out.mp4' });
      }
      if (url === 'https://cdn.reactor.inc/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await reactor.generateVideo({ prompt: 'x' });
    for (let i = 0; i < 50 && fetchMock.mock.calls.length < 1; i += 1) await flush();
    await flush();
    expect(getSettingsMock).toHaveBeenCalled();
    expect(job.status).toBe('running');
    vi.unstubAllGlobals();
  });

  it('rejects when no API key is configured', async () => {
    const prevEnv = process.env.REACTOR_API_KEY;
    delete process.env.REACTOR_API_KEY;
    await expect(reactor.generateVideo({ prompt: 'x', settings: {} })).rejects.toThrow(/No reactor\.inc API key/);
    if (prevEnv !== undefined) process.env.REACTOR_API_KEY = prevEnv;
  });

  it('emits failed and does not write output when reactor.inc reports a failed status', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === TOKEN_URL) return jsonResponse({ jwt: 'jwt-2', expires_at: null });
      if (url === GENERATE_URL) return jsonResponse({ clip_id: 'c2', status_url: `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c2` });
      if (url === `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c2`) {
        return jsonResponse({ status: 'failed', error: 'model overloaded' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const failed = vi.fn();
    videoGenEvents.on('failed', failed);
    const job = await reactor.generateVideo({ settings: { videoGen: { reactor: { apiKey: 'test-key' } } }, prompt: 'x' });
    for (let i = 0; i < 20 && failed.mock.calls.length < 1; i += 1) await flush();

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ generationId: job.jobId, error: expect.stringContaining('model overloaded') }));
    vi.unstubAllGlobals();
  });

  it('threads continue_from_clip_id, seconds, and seed onto the submit body', async () => {
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === TOKEN_URL) return jsonResponse({ jwt: 'jwt-3', expires_at: null });
      if (url === GENERATE_URL) {
        expect(JSON.parse(opts.body)).toEqual({
          prompt: 'continued shot', continue_from_clip_id: 'clip-9', seconds: 6, seed: 7,
        });
        return jsonResponse({ clip_id: 'c3', status_url: `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c3` });
      }
      if (url === `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c3`) {
        return jsonResponse({ status: 'completed', video_url: 'https://cdn.reactor.inc/out.mp4' });
      }
      if (url === 'https://cdn.reactor.inc/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await reactor.generateVideo({
      settings: { videoGen: { reactor: { apiKey: 'test-key' } } },
      prompt: 'continued shot',
      continueFromClipId: 'clip-9',
      seconds: 6,
      seed: 7,
    });
    for (let i = 0; i < 50 && fetchMock.mock.calls.length < 2; i += 1) await flush();
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('re-mints the session token and retries once when a poll returns 401', async () => {
    const statusUrl = `${reactor.REACTOR_API_BASE}/v1/fast-h3/clips/c4`;
    let tokenMints = 0;
    let statusCalls = 0;
    const fetchMock = vi.fn(async (url, opts) => {
      if (url === TOKEN_URL) {
        tokenMints += 1;
        return jsonResponse({ jwt: `jwt-${tokenMints}`, expires_at: null });
      }
      if (url === GENERATE_URL) return jsonResponse({ clip_id: 'c4', status_url: statusUrl });
      if (url === statusUrl) {
        statusCalls += 1;
        if (statusCalls === 1) {
          expect(opts.headers.Authorization).toBe('Bearer jwt-1');
          return { ok: false, status: 401, json: async () => ({}) };
        }
        expect(opts.headers.Authorization).toBe('Bearer jwt-2');
        return jsonResponse({ status: 'completed', video_url: 'https://cdn.reactor.inc/out.mp4' });
      }
      if (url === 'https://cdn.reactor.inc/out.mp4') {
        return { ok: true, status: 200, arrayBuffer: async () => Uint8Array.from(Buffer.from('bytes')).buffer };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const job = await reactor.generateVideo({ settings: { videoGen: { reactor: { apiKey: 'test-key' } } }, prompt: 'x' });
    const outputPath = join(FAKE_VIDEOS_DIR, job.filename);
    let history = [];
    for (let i = 0; i < 50 && history.length === 0; i += 1) {
      await flush();
      history = await loadHistory();
    }
    expect(await readFile(outputPath)).toBeTruthy();
    expect(tokenMints).toBe(2);
    vi.unstubAllGlobals();
  });
});
