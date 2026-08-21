import { describe, it, expect } from 'vitest';
import {
  layoutLoomGraph, loomEdgePath, loomGraphLayers, LOOM_NODE_W,
} from './loomLayout.js';

const tr = (id, targetNodeId) => ({ id, targetNodeId, intent: 'go' });

const episode = () => ({
  id: 'ep-1',
  startNodeId: 'n1',
  nodes: [
    { id: 'n1', transitions: [tr('t1', 'n2'), tr('t2', 'n3')] },
    { id: 'n2', transitions: [tr('t3', 'n4')] },
    { id: 'n3', isEnding: true, transitions: [] },
    { id: 'n4', isEnding: true, transitions: [] },
  ],
});

describe('loomGraphLayers', () => {
  it('layers by BFS depth and trails unreachable nodes', () => {
    const ep = episode();
    ep.nodes.push({ id: 'orphan', transitions: [] });
    const layers = loomGraphLayers(ep);
    expect(layers[0]).toEqual(['n1']);
    expect(layers[1]).toEqual(['n2', 'n3']);
    expect(layers[2]).toEqual(['n4']);
    expect(layers[3]).toEqual(['orphan']);
  });

  it('returns only orphan chunks when there is no valid start', () => {
    const layers = loomGraphLayers({ startNodeId: 'gone', nodes: [{ id: 'a' }, { id: 'b' }] });
    expect(layers).toEqual([['a', 'b']]);
  });
});

describe('layoutLoomGraph', () => {
  it('assigns columns by depth and lets persisted pos win', () => {
    const ep = episode();
    ep.nodes[3].pos = { x: 999, y: 5 };
    const { positions, width, height } = layoutLoomGraph(ep);
    expect(positions.n1.x).toBeLessThan(positions.n2.x);
    expect(positions.n2.x).toBe(positions.n3.x);
    expect(positions.n4).toEqual({ x: 999, y: 5 });
    expect(width).toBeGreaterThanOrEqual(999 + LOOM_NODE_W);
    expect(height).toBeGreaterThan(0);
  });

  it('handles an empty episode without NaN extents', () => {
    const { positions, width, height } = layoutLoomGraph({ nodes: [] });
    expect(positions).toEqual({});
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});

describe('loomEdgePath', () => {
  it('produces a cubic path from right edge to left edge with a label midpoint', () => {
    const { d, labelX, labelY } = loomEdgePath({ x: 0, y: 0 }, { x: 300, y: 100 });
    expect(d.startsWith(`M ${LOOM_NODE_W} `)).toBe(true);
    expect(d).toContain('C ');
    expect(labelX).toBe((LOOM_NODE_W + 300) / 2);
    expect(labelY).toBeGreaterThan(0);
  });
});
