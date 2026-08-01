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
    expect(stackerNewsOperations).toEqual(['me', 'territory']);
  });
});
