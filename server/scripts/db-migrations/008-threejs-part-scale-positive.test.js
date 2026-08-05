import { describe, it, expect, vi } from 'vitest';
import { up } from './008-threejs-part-scale-positive.js';
import { threejsSculptSpecSchema } from '../../lib/threejsModel.js';

const makeClient = (rows) => {
  const updates = [];
  const query = vi.fn(async (sql, params) => {
    if (sql.startsWith('SELECT')) return { rows };
    updates.push({ sql, params });
    return { rows: [] };
  });
  return { client: { query }, updates };
};

const modelRow = (id, parts) => ({ id, data: { spec: { parts } } });

describe('db-migration 008 — non-positive Three.js part scale', () => {
  it('takes the magnitude of a negative component and floors a zero, writing only the parts path', async () => {
    const { client, updates } = makeClient([
      modelRow('threejs-a', [{ id: 'body', scale: [2, -3, 1], children: [{ id: 'trim', scale: [1, 0, 1], children: [] }] }]),
    ]);

    await up(client);

    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain("jsonb_set(data, '{spec,parts}'");
    // Never bumps updated_at — a derived normalization must not reorder the models list.
    expect(updates[0].sql).not.toContain('updated_at');
    expect(updates[0].params[1]).toBe('threejs-a');
    const repaired = JSON.parse(updates[0].params[0]);
    expect(repaired[0].scale).toEqual([2, 3, 1]);
    expect(repaired[0].children[0].scale).toEqual([1, 1e-4, 1]);
  });

  it('writes nothing for specs whose scales are already positive (idempotent re-run)', async () => {
    const { client, updates } = makeClient([
      modelRow('threejs-b', [{ id: 'body', scale: [1, 1, 1], children: [{ id: 'trim', scale: [0.5, 2, 1e-4], children: [] }] }]),
    ]);

    await up(client);

    expect(updates).toEqual([]);
  });

  it('leaves a part with no scale key alone', async () => {
    const { client, updates } = makeClient([modelRow('threejs-c', [{ id: 'body', children: [] }])]);

    await up(client);

    expect(updates).toEqual([]);
  });

  it('skips a row whose spec parts are not an array', async () => {
    const { client, updates } = makeClient([
      { id: 'threejs-d', data: { spec: { parts: null } } },
      { id: 'threejs-e', data: { spec: null } },
      { id: 'threejs-f', data: {} },
    ]);

    await up(client);

    expect(updates).toEqual([]);
  });

  it('produces parts the tightened schema now accepts', async () => {
    const spec = {
      schemaVersion: 1,
      name: 'Example Beacon',
      summary: 'A two-part beacon stored before the scale bound existed.',
      subjectType: 'object',
      background: '#111827',
      camera: { position: [3, 2, 4], target: [0, 0, 0] },
      materials: { shell: { type: 'standard', color: '#8b5a2b' } },
      lights: [{ type: 'ambient', color: '#ffffff', intensity: 0.4 }],
      parts: [{
        id: 'shell',
        name: 'Shell',
        geometry: { type: 'box', width: 1, height: 1, depth: 1 },
        material: 'shell',
        scale: [1, -1, 0],
        children: [],
      }],
      detailInventory: [{
        feature: 'Ribbed shell',
        evidence: 'Vertical ribs run the visible face.',
        implementationPartIds: ['shell'],
      }],
    };
    expect(threejsSculptSpecSchema.safeParse(spec).success).toBe(false);

    const { client, updates } = makeClient([{ id: 'threejs-g', data: { spec } }]);
    await up(client);

    spec.parts = JSON.parse(updates[0].params[0]);
    const parsed = threejsSculptSpecSchema.parse(spec);
    expect(parsed.parts[0].scale).toEqual([1, 1, 1e-4]);
  });
});
