import { useEffect, useRef } from 'react';
import CoSAvatarFrame from './CoSAvatarFrame';
import { AGENT_STATES } from './constants';
import { drawWireframeCore } from '../../lib/wireframeCore.js';
import { parseColor } from '../../lib/chipContrast.js';

// Core Assembly — the Kestrel Neon concept's rotating wireframe icosahedron,
// drawn on a plain 2D canvas. No WebGL, so it skips CoSCanvasGuard and works
// on displays where the three.js avatars fall back to the failure panel.
//
// Colors: edges take the agent-state color (the intentional 7-way enum in
// `AGENT_STATES`, so every state stays distinguishable), while the rings and
// vertices follow the active theme's secondary accent — magenta under Kestrel
// Neon, whatever `--port-accent-2` is elsewhere.

// Per-state motion: radians/second of spin and how hard the glow breathes.
const STATE_MOTION = {
  sleeping: { spin: 0.25, breathe: 0.15 },
  thinking: { spin: 0.7, breathe: 0.5 },
  coding: { spin: 1.1, breathe: 0.8 },
  investigating: { spin: 0.9, breathe: 0.7 },
  reviewing: { spin: 0.6, breathe: 0.45 },
  planning: { spin: 0.5, breathe: 0.35 },
  ideating: { spin: 1.3, breathe: 1 },
};

const FALLBACK_NODE_RGB = [255, 43, 214];
const FALLBACK_DIM_RGB = [107, 115, 144];
const TILT = 0.5;

const readTriple = (styles, prop, fallback) => {
  const parts = styles.getPropertyValue(prop).trim().split(/\s+/).map(Number);
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts.slice(0, 3) : fallback;
};

// Canvas fillStyle can't read CSS custom properties, so resolve the theme
// tokens once per theme switch (mirrors `rollPalette` / `useChartColors`).
const resolvePalette = () => {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return { nodeRgb: FALLBACK_NODE_RGB, dimRgb: FALLBACK_DIM_RGB, font: 'monospace' };
  }
  const styles = getComputedStyle(document.documentElement);
  return {
    nodeRgb: readTriple(styles, '--port-accent-2', FALLBACK_NODE_RGB),
    dimRgb: readTriple(styles, '--port-text-subtle', FALLBACK_DIM_RGB),
    font: styles.getPropertyValue('--port-font-mono').trim() || 'monospace',
  };
};

const stateEdgeRgb = (state) => {
  const parsed = parseColor((AGENT_STATES[state] || AGENT_STATES.sleeping).color);
  return parsed ? [parsed.r, parsed.g, parsed.b] : [0, 240, 255];
};

export default function CoreCoSAvatar({ state = 'sleeping', speaking = false, background = false }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  // Latest props for the animation loop — the loop is bound once so a state
  // change never restarts the spin from zero.
  const propsRef = useRef({ state, speaking });
  propsRef.current = { state, speaking };

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!wrap || !ctx) return undefined;

    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let reduce = media?.matches ?? false;
    let palette = resolvePalette();
    let width = 0;
    let height = 0;
    let spin = 0.8;
    let phase = 0;
    let lastTs = null;
    let raf = 0;
    // Drag offsets so "Drag to rotate" on the frame is true for this avatar too.
    const drag = { pointerId: null, x: 0, y: 0, ax: 0, ay: 0 };

    const draw = (ts) => {
      const { state: currentState, speaking: isSpeaking } = propsRef.current;
      const motion = STATE_MOTION[currentState] || STATE_MOTION.sleeping;
      const dt = lastTs === null || reduce ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      spin += dt * motion.spin * (isSpeaking ? 1.8 : 1);
      phase += dt * (0.4 + (isSpeaking ? 1.2 : 0));
      const breathe = reduce ? 0 : motion.breathe * (0.5 + 0.5 * Math.sin(ts / 700));
      drawWireframeCore(ctx, {
        width,
        height,
        ax: TILT + drag.ax,
        ay: spin + drag.ay,
        phase,
        pulse: Math.min(1, breathe + (isSpeaking ? 0.5 : 0)),
        edgeRgb: stateEdgeRgb(currentState),
        ...palette,
      });
    };

    const loop = (ts) => {
      draw(ts);
      if (!reduce) raf = requestAnimationFrame(loop);
    };

    const restart = () => {
      cancelAnimationFrame(raf);
      lastTs = null;
      raf = requestAnimationFrame(loop);
    };

    const resize = () => {
      width = Math.max(1, Math.floor(wrap.clientWidth));
      height = Math.max(1, Math.floor(wrap.clientHeight));
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(performance.now());
    };

    const onMotionPreference = () => {
      reduce = media.matches;
      restart();
    };
    const onPointerDown = (event) => {
      drag.pointerId = event.pointerId;
      drag.x = event.clientX;
      drag.y = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event) => {
      if (drag.pointerId !== event.pointerId) return;
      drag.ay += (event.clientX - drag.x) * 0.01;
      drag.ax += (event.clientY - drag.y) * 0.01;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (reduce) draw(performance.now());
    };
    const onPointerUp = (event) => {
      if (drag.pointerId === event.pointerId) drag.pointerId = null;
    };

    resize();
    restart();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(wrap);
    // Re-resolve the ring/readout colors when the theme switches (same signal
    // useCanvasRollPalette watches).
    const themeObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { palette = resolvePalette(); if (reduce) draw(performance.now()); })
      : null;
    themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-port-theme'] });
    media?.addEventListener?.('change', onMotionPreference);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      themeObserver?.disconnect();
      media?.removeEventListener?.('change', onMotionPreference);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, []);

  return (
    <CoSAvatarFrame label="Core assembly avatar. Drag to rotate." background={background}>
      <div ref={wrapRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          data-testid="core-avatar-canvas"
          data-state={state}
          className="block w-full h-full"
        />
      </div>
    </CoSAvatarFrame>
  );
}
