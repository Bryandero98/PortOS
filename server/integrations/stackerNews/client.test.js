import { describe, expect, it, vi, afterEach } from 'vitest';
import { executeStackerNewsOperation, stackerNewsOperations } from './client.js';

afterEach(() => vi.unstubAllGlobals());

describe('Stacker News GraphQL adapter', () => {
  it('rejects operations outside the closed registry before network use', async () => {
    await expect(executeStackerNewsOperation('mutation { arbitrary }', {}, 'secret')).rejects.toThrow('Unsupported');
  });

  it('uses the fixed public endpoint and API-key header for a named operation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { me: { name: 'example' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(executeStackerNewsOperation('me', {}, 'secret')).resolves.toEqual({ me: { name: 'example' } });
    expect(fetch.mock.calls[0][0]).toBe('https://stacker.news/api/graphql');
    expect(fetch.mock.calls[0][1].headers['x-api-key']).toBe('secret');
    expect(stackerNewsOperations).toEqual(['me', 'sub', 'items', 'createDiscussion', 'createComment']);
  });

  it('sanitizes operation variables and never accepts a caller query or endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { sub: { name: 'art' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await executeStackerNewsOperation('sub', { name: 'art', query: 'mutation Evil', endpoint: 'https://example.com' }, 'secret');
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://stacker.news/api/graphql');
    expect(JSON.parse(options.body).variables).toEqual({ name: 'art' });
    expect(options.body).not.toContain('mutation Evil');
  });

  it('does not retry writes that could duplicate a post', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'busy' }] }), { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(executeStackerNewsOperation('createComment', { parentId: '42', body: 'hello' }, 'secret')).rejects.toThrow('busy');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
