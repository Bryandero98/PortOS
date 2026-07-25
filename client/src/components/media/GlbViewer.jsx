import { Suspense, useEffect, useId, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  Bounds,
  Environment,
  Lightformer,
  OrbitControls,
  useGLTF,
} from '@react-three/drei';
import { Download, Rotate3d } from 'lucide-react';

const DEFAULT_BACKGROUND = '#050505';

// Reusable viewer for a generated `.glb` mesh: drei `useGLTF` loads the model,
// `Bounds fit` frames it regardless of the source's scale, `OrbitControls` lets
// the user rotate/zoom, and a Download button saves the raw `.glb`. Deliberately
// backend-agnostic — it takes a plain `src` URL, so the image→3D generate flow
// (#2952) and any future detail route can mount it by pointing at the landed
// asset. Renders nothing without a `src`.

// Derive a friendly download filename from the asset URL when the caller doesn't
// supply one (`/data/models3d/robot-a1b2.glb` → `robot-a1b2.glb`).
function filenameFromSrc(src) {
  const tail = String(src || '').split('?')[0].split('#')[0].split('/').pop();
  return tail && tail.toLowerCase().endsWith('.glb') ? tail : 'model.glb';
}

const opaqueMaterial = (material) => {
  if (!material?.clone) return material;
  const clone = material.clone();
  clone.transparent = false;
  clone.opacity = 1;
  clone.alphaTest = 0;
  clone.depthWrite = true;
  clone.needsUpdate = true;
  return clone;
};

// GLBs generated before the server-side opaque-export fix remain in users'
// libraries. Clone before overriding their materials so drei's URL-keyed cache
// stays pristine for any other consumer that intentionally wants alpha.
export function cloneGlbSceneWithOpaqueMaterials(scene) {
  const clone = scene.clone(true);
  clone.traverse((object) => {
    if (!object?.isMesh || !object.material) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(opaqueMaterial)
      : opaqueMaterial(object.material);
  });
  return clone;
}

function GlbModel({ src, forceOpaque }) {
  // `useGLTF` keys drei's global cache on the URL, so a new generation (a new
  // `src`) parses fresh while revisiting the same mesh reuses the cache — no
  // manual cache-clear needed (clearing on unmount would force a full multi-MB
  // re-fetch every time the viewer remounts for the same URL).
  const { scene } = useGLTF(src);
  const renderedScene = useMemo(
    () => (forceOpaque ? cloneGlbSceneWithOpaqueMaterials(scene) : scene),
    [forceOpaque, scene],
  );
  useEffect(() => {
    if (!forceOpaque) return undefined;
    return () => {
      renderedScene.traverse((object) => {
        if (!object?.isMesh || !object.material) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose?.());
      });
    };
  }, [forceOpaque, renderedScene]);
  return <primitive object={renderedScene} />;
}

// `downloadHref` (optional) overrides where the Download button points — pass a
// dedicated asset endpoint that sets its own `Content-Disposition` filename, so
// the server owns the name instead of the client re-deriving it. Falls back to
// `src` with a filename inferred from the URL.
export default function GlbViewer({
  src,
  downloadHref,
  downloadName,
  className = '',
  forceOpaque = false,
  initialBackground = DEFAULT_BACKGROUND,
}) {
  const backgroundInputId = useId();
  const [background, setBackground] = useState(initialBackground);
  if (!src) return null;
  const href = downloadHref || src;
  // With an explicit download endpoint the server's Content-Disposition wins, so
  // a bare `download` attribute is enough; otherwise infer a name from the URL.
  const download = downloadHref ? '' : (downloadName || filenameFromSrc(src));
  return (
    <div className={`overflow-hidden rounded-xl border border-port-border bg-port-bg ${className}`}>
      <div
        data-testid="glb-preview-surface"
        className="relative aspect-square w-full"
        style={{ backgroundColor: background }}
      >
        <div className="absolute right-2 top-2 z-10 flex items-center gap-2 rounded-lg border border-white/20 bg-black/70 px-2 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm">
          <label htmlFor={backgroundInputId}>Background</label>
          <input
            id={backgroundInputId}
            type="color"
            value={background}
            onChange={(event) => setBackground(event.target.value)}
            aria-label="Mesh preview background"
            className="h-7 w-9 cursor-pointer rounded border border-white/30 bg-transparent p-0.5"
          />
        </div>
        <Canvas camera={{ position: [0, 0, 3], fov: 45 }} dpr={[1, 2]}>
          <color attach="background" args={[background]} />
          <ambientLight intensity={0.9} />
          <directionalLight position={[4, 6, 5]} intensity={1.1} />
          <directionalLight position={[-4, -2, -5]} intensity={0.4} />
          {/* A procedural environment keeps metallic PBR textures readable without
              downloading an HDR preset — PortOS installs can be fully offline. */}
          <Environment resolution={128}>
            <Lightformer
              form="rect"
              intensity={3}
              position={[0, 4, 4]}
              rotation-x={Math.PI / 2}
              scale={[5, 5, 1]}
            />
            <Lightformer
              form="rect"
              intensity={1.5}
              position={[-4, 1, 2]}
              rotation-y={Math.PI / 2}
              scale={[3, 5, 1]}
            />
            <Lightformer
              form="rect"
              intensity={1}
              position={[4, -1, -2]}
              rotation-y={-Math.PI / 2}
              scale={[3, 5, 1]}
            />
          </Environment>
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.2}>
              <GlbModel src={src} forceOpaque={forceOpaque} />
            </Bounds>
          </Suspense>
          <OrbitControls makeDefault enablePan enableZoom enableRotate />
        </Canvas>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-port-border px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          <Rotate3d className="h-3.5 w-3.5" /> Drag to orbit · scroll to zoom
        </span>
        <a
          href={href}
          download={download}
          className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
        >
          <Download className="h-3.5 w-3.5" /> Download .glb
        </a>
      </div>
    </div>
  );
}
