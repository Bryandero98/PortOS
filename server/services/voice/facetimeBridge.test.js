import { describe, expect, it } from 'vitest';
import { checkSetup, facetimeControlResultSchema } from './facetimeBridge.js';

describe('FaceTime Audio control protocol', () => {
  it('accepts only the strict helper result contract', () => {
    const result = facetimeControlResultSchema.safeParse({
      ok: true, command: 'probe', state: 'idle', authorized: true,
      action: 'probe', message: 'ready', errorCode: null,
    });
    expect(result.success).toBe(true);
    expect(facetimeControlResultSchema.safeParse({ ...result.data, identity: 'private@example.com' }).success).toBe(false);
  });

  it('reports an unset identity without exposing an identity value', async () => {
    const setup = await checkSetup({ facetime: { targetHandle: '', targetName: '' } });
    expect(setup.identity.ok).toBe('missing');
    expect(JSON.stringify(setup)).not.toContain('targetHandle');
  });

  it('refuses to run when identity is not configured', async () => {
    const { run } = await import('./facetimeBridge.js');
    await expect(run('probe', { facetime: { targetHandle: '', targetName: '' } }))
      .rejects.toThrow();
  });
});

