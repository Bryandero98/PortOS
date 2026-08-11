import { Component, useState } from 'react';
import { isWebGLAvailable } from '../../lib/webglSupport';
import CoSAvatarFrame from './CoSAvatarFrame';

/**
 * Gate CoS 3D avatar canvases on WebGL availability and catch render-time
 * failures so a missing GPU never leaves an unhandled promise rejection or a
 * blank panel. Callers pass the r3f `<Canvas>…</Canvas>` as children.
 */

class AvatarErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    console.warn(`⚠️ CoS avatar failed: ${err?.message || err}`);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function WebGLUnavailableHint({ background = false }) {
  return (
    <div
      className={`${background ? 'relative w-full h-full min-h-full' : 'relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6]'} flex flex-col items-center justify-center rounded-lg border border-port-border bg-port-card/60 text-center p-3`}
    >
      <div className="text-2xl mb-2" aria-hidden="true">🖥️</div>
      <div className="text-xs font-semibold text-gray-200 mb-1">3D unavailable</div>
      <div className="text-[10px] text-gray-400 leading-snug">
        This display has no WebGL. Pick the SVG or ASCII avatar in CoS Config.
      </div>
    </div>
  );
}

export default function CoSCanvasGuard({
  label = 'Interactive 3D avatar. Drag to rotate.',
  background = false,
  fallback = null,
  children,
}) {
  // Probe once on mount — availability doesn't flip mid-session.
  const [supported] = useState(() => isWebGLAvailable());
  const resolvedFallback = fallback || <WebGLUnavailableHint background={background} />;

  if (!supported) return resolvedFallback;

  return (
    <CoSAvatarFrame label={label} background={background}>
      <AvatarErrorBoundary fallback={resolvedFallback}>
        {children}
      </AvatarErrorBoundary>
    </CoSAvatarFrame>
  );
}

export { WebGLUnavailableHint };
