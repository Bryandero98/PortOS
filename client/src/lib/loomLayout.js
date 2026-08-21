/**
 * FableLoom graph layout — pure helpers that place an episode's scene nodes on
 * the editor canvas and route its transition edges.
 *
 * Default positions come from BFS layering (columns = depth from the opening
 * scene, rows = order within a layer; unreachable nodes trail in extra
 * columns). A node the author dragged carries a persisted `pos` override that
 * always wins. Mirrors the layering rule in `server/lib/fableLoomGraph.js`
 * `computeGraphLayers` — keep the two BFS orders in step.
 */

export const LOOM_NODE_W = 200;
export const LOOM_NODE_H = 112;
const COL_GAP = 96;
const ROW_GAP = 40;
const MARGIN = 24;

const asArray = (v) => (Array.isArray(v) ? v : []);

/** BFS layers from the start node (client mirror of computeGraphLayers). */
export function loomGraphLayers(episode) {
  const nodes = asArray(episode?.nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers = [];
  const seen = new Set();
  if (byId.has(episode?.startNodeId)) {
    let frontier = [episode.startNodeId];
    seen.add(episode.startNodeId);
    while (frontier.length) {
      layers.push(frontier);
      const next = [];
      for (const id of frontier) {
        for (const tr of asArray(byId.get(id)?.transitions)) {
          if (byId.has(tr?.targetNodeId) && !seen.has(tr.targetNodeId)) {
            seen.add(tr.targetNodeId);
            next.push(tr.targetNodeId);
          }
        }
      }
      frontier = next;
    }
  }
  // Unreachable nodes trail in chunked extra columns so they stay visible.
  const orphans = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
  for (let i = 0; i < orphans.length; i += 4) {
    layers.push(orphans.slice(i, i + 4));
  }
  return layers;
}

/**
 * Position every node. Returns `{ positions, width, height }` where
 * `positions` maps nodeId → `{ x, y }` (top-left corners). Persisted
 * `node.pos` overrides the computed slot; the canvas size covers both.
 */
export function layoutLoomGraph(episode) {
  const nodes = asArray(episode?.nodes);
  const posById = new Map(nodes.map((n) => [n.id, n.pos]));
  const layers = loomGraphLayers(episode);
  const positions = {};
  layers.forEach((layer, col) => {
    layer.forEach((id, row) => {
      const custom = posById.get(id);
      positions[id] = custom && Number.isFinite(custom.x) && Number.isFinite(custom.y)
        ? { x: custom.x, y: custom.y }
        : { x: MARGIN + col * (LOOM_NODE_W + COL_GAP), y: MARGIN + row * (LOOM_NODE_H + ROW_GAP) };
    });
  });
  let width = 0;
  let height = 0;
  for (const { x, y } of Object.values(positions)) {
    width = Math.max(width, x + LOOM_NODE_W + MARGIN);
    height = Math.max(height, y + LOOM_NODE_H + MARGIN);
  }
  return { positions, width: Math.max(width, 400), height: Math.max(height, 240) };
}

/**
 * Cubic path from a source node's right edge to a target node's left edge,
 * with the label midpoint. A self-or-backward edge bows harder so it stays
 * readable when the target sits left of (or on top of) the source.
 */
export function loomEdgePath(from, to) {
  const x1 = from.x + LOOM_NODE_W;
  const y1 = from.y + LOOM_NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + LOOM_NODE_H / 2;
  const dx = Math.max(48, Math.abs(x2 - x1) / 2);
  return {
    d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2,
  };
}
