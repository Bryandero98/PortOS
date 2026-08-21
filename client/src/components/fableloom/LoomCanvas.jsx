/**
 * FableLoom canvas — the visual editor for one episode's scene graph.
 *
 * Renders scene nodes as SVG cards (BFS-layered by `layoutLoomGraph`,
 * author-dragged positions win) with intent-labeled transition edges. Click
 * selects a scene (selection lives in the URL — the parent navigates); drag
 * repositions it and persists `pos` on release. The wrapper owns scrolling in
 * both axes so a wide graph pans instead of clipping.
 */

import { useMemo, useRef, useState } from 'react';
import { Play, Flag } from 'lucide-react';
import { layoutLoomGraph, loomEdgePath, LOOM_NODE_W, LOOM_NODE_H } from '../../lib/loomLayout';

const DRAG_THRESHOLD_PX = 4;

const truncate = (text, max) => {
  const s = typeof text === 'string' ? text : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

export default function LoomCanvas({ episode, selectedNodeId, onSelectNode, onMoveNode }) {
  // Live drag override: nodeId → { x, y } while a pointer drag is in flight,
  // so the node follows the cursor without a server round-trip per move.
  const [dragPos, setDragPos] = useState(null);
  const dragRef = useRef(null);

  const layout = useMemo(() => layoutLoomGraph(episode), [episode]);
  const positions = useMemo(() => {
    if (!dragPos) return layout.positions;
    return { ...layout.positions, [dragPos.id]: { x: dragPos.x, y: dragPos.y } };
  }, [layout.positions, dragPos]);

  const nodes = episode?.nodes || [];
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const handlePointerDown = (event, node) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = positions[node.id] || { x: 0, y: 0 };
    dragRef.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: start.x,
      originY: start.y,
      moved: false,
    };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    setDragPos({
      id: drag.id,
      x: Math.max(0, drag.originX + dx),
      y: Math.max(0, drag.originY + dy),
    });
  };

  const handlePointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved && dragPos && dragPos.id === drag.id) {
      onMoveNode?.(drag.id, { x: Math.round(dragPos.x), y: Math.round(dragPos.y) });
    } else {
      onSelectNode?.(drag.id);
    }
    setDragPos(null);
  };

  if (!nodes.length) return null;

  const width = Math.max(layout.width, dragPos ? dragPos.x + LOOM_NODE_W + 24 : 0);
  const height = Math.max(layout.height, dragPos ? dragPos.y + LOOM_NODE_H + 24 : 0);

  return (
    <div className="overflow-auto h-full w-full" data-testid="loom-canvas">
      <svg width={width} height={height} className="block select-none touch-none">
        <g>
          {nodes.flatMap((node) => (node.transitions || []).map((tr) => {
            const from = positions[node.id];
            const to = positions[tr.targetNodeId];
            if (!from || !to || !nodeById.has(tr.targetNodeId)) return null;
            const { d, labelX, labelY } = loomEdgePath(from, to);
            const active = node.id === selectedNodeId;
            return (
              <g key={tr.id} className={active ? 'opacity-100' : 'opacity-70'}>
                <path d={d} fill="none" strokeWidth={active ? 2 : 1.5}
                  className={active ? 'stroke-port-accent' : 'stroke-port-border'} />
                {tr.intent && (
                  <text x={labelX} y={labelY - 6} textAnchor="middle"
                    className="fill-port-text-muted text-[10px] pointer-events-none">
                    {truncate(tr.intent, 28)}
                  </text>
                )}
              </g>
            );
          }))}
        </g>
        <g>
          {nodes.map((node) => {
            const pos = positions[node.id];
            if (!pos) return null;
            const selected = node.id === selectedNodeId;
            const isStart = node.id === episode.startNodeId;
            return (
              <g
                key={node.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                className="cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`Scene: ${node.title || 'Untitled'}`}
                onPointerDown={(e) => handlePointerDown(e, node)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectNode?.(node.id);
                  }
                }}
              >
                <rect
                  width={LOOM_NODE_W}
                  height={LOOM_NODE_H}
                  rx={10}
                  strokeWidth={selected ? 2 : 1}
                  className={`${node.isEnding ? 'fill-port-success/10' : 'fill-port-card'} ${
                    selected ? 'stroke-port-accent' : 'stroke-port-border'
                  }`}
                />
                {node.image && (
                  <image
                    href={`/data/images/${node.image}`}
                    x={8} y={26} width={54} height={LOOM_NODE_H - 34}
                    preserveAspectRatio="xMidYMid slice"
                  />
                )}
                <text x={10} y={17} className="fill-port-text text-[11px] font-semibold pointer-events-none">
                  {truncate(node.title || 'Untitled scene', 26)}
                </text>
                <foreignObject x={node.image ? 68 : 10} y={24} width={LOOM_NODE_W - (node.image ? 78 : 20)} height={LOOM_NODE_H - 48}>
                  <div className="text-[10px] leading-snug text-port-text-muted overflow-hidden h-full pointer-events-none">
                    {truncate(node.prose, 110)}
                  </div>
                </foreignObject>
                <g transform={`translate(10, ${LOOM_NODE_H - 16})`} className="pointer-events-none">
                  {isStart && (
                    <g>
                      <Play size={10} className="text-port-accent" x={0} y={-8} />
                      <text x={14} y={1} className="fill-port-accent text-[9px] font-medium">Opening</text>
                    </g>
                  )}
                  {node.isEnding && (
                    <g transform={isStart ? 'translate(64, 0)' : ''}>
                      <Flag size={10} className="text-port-success" x={0} y={-8} />
                      <text x={14} y={1} className="fill-port-success text-[9px] font-medium">
                        {truncate(node.endingLabel || 'Ending', 20)}
                      </text>
                    </g>
                  )}
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
