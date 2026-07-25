// Shared URL builder for sprite record assets served by the /data/sprites
// static mount — one place for the per-segment encoding rules.
//
// `version` is an optional content token (a sha256 from the run manifest) that
// makes the URL change whenever the bytes behind it change (#3020). The packer
// rewrites a strip IN PLACE at a stable path, so without a token the browser
// keeps painting the image it already decoded — no request is issued, so no
// ETag revalidation happens either. Reprocessing 8f → 12f then applies the new
// stepped geometry to the OLD strip and the sprite reads as a jumpy, mis-
// centered toggle until a manual reload. A CONTENT hash (not `Date.now()`)
// is what's wanted: it changes if and only if the pixels did, so caching still
// works for the unchanged case — important over Tailscale, where these are
// multi-MB PNGs.
//
// The token is used VERBATIM — this builder deliberately does not shorten it.
// Truncating here silently corrupted a composite token: an `mtimeMs-size`
// stamp is 22 chars, so a 12-char clamp cut mid-mtime and dropped the size
// component entirely, which is the half that catches a rewrite too fast for
// mtime resolution. Shortening is the caller's call, because only the caller
// knows whether the token is a hash (safe to truncate) or a composite (not) —
// see `stripVersionToken`.
export const spriteAssetUrl = (recordId, relPath, version) => {
  const path = `/data/sprites/${encodeURIComponent(recordId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  // Only a non-empty STRING versions the URL — a stray number/object would
  // stringify into nonsense, and `?v=undefined` on a record that predates the
  // field would be a cache-buster that never changes (worse than no token).
  return typeof version === 'string' && version ? `${path}?v=${encodeURIComponent(version)}` : path;
};

// There is deliberately no client-side "which token field wins" resolver. The
// server normalizes every run's strip token into a single `stripPreview
// .stripVersion` (see normalizeStripPreview in services/sprites/walk.js), so a
// strip consumer just passes that field through and cannot paint a stale image
// by forgetting a precedence rule.

/**
 * Cache-busting token for an asset row from `listSpriteAssets` (#3020).
 *
 * The packed strip is not the only thing a reprocess rewrites in place: the
 * same run also rewrites its packaged phase frames
 * (`runs/<id>/generated/frames/NN-<phase>.png`) and its contrast review sheet,
 * both of which `listSpriteAssets` deliberately keeps in the asset browser
 * because they exist FOR human review (see paths.js). Those are exactly the
 * surfaces a user opens to confirm the strip really was repacked — so without a
 * token they show the pre-reprocess art, which is worse than the strip bug it
 * would be "confirming."
 *
 * No new server work is needed: every asset row already carries `mtime` and
 * `size`. Same composite shape as the redraw strip token, and likewise never
 * truncated — size is what catches a rewrite too fast for mtime resolution.
 */
export const assetVersionToken = (asset) => (
  asset?.mtime > 0 && asset?.size >= 0 ? `${Math.round(asset.mtime)}-${asset.size}` : undefined
);

// Every sprite asset is a transparent-capable PNG/GIF, and PortOS's dark
// surfaces are near-black — so alpha regions are indistinguishable from black
// pixels on a plain background. Every surface that can show one paints this
// checkerboard behind it instead (#2930). Read through CSS custom properties
// so a light theme can re-map them in index.css; the literals are the dark
// defaults, since a theme that sets neither still needs a working checker.
const CHECKER_DARK = 'var(--sprite-checker-dark, #191919)';
const CHECKER_LIGHT = 'var(--sprite-checker-light, #2e2e2e)';

/**
 * Inline style for a transparency checkerboard. `cell` is the square size in
 * px — thumbnails want a smaller cell so the pattern stays legible, the
 * inspector a larger one. Inline rather than a CSS class because the cell size
 * varies per surface. Returns a fresh object each call (React style props must
 * not be shared and mutated), and only sets background-* properties so it
 * composes with any caller-supplied sizing/border classes.
 */
export function checkerboardStyle(cell = 6) {
  const tile = cell * 2;
  return {
    backgroundColor: CHECKER_DARK,
    backgroundImage: [
      `linear-gradient(45deg, ${CHECKER_LIGHT} 25%, transparent 25%)`,
      `linear-gradient(-45deg, ${CHECKER_LIGHT} 25%, transparent 25%)`,
      `linear-gradient(45deg, transparent 75%, ${CHECKER_LIGHT} 75%)`,
      `linear-gradient(-45deg, transparent 75%, ${CHECKER_LIGHT} 75%)`,
    ].join(', '),
    backgroundSize: `${tile}px ${tile}px`,
    backgroundPosition: `0 0, 0 ${cell}px, ${cell}px -${cell}px, -${cell}px 0`,
  };
}

// Pixel art must never be smoothed on upscale. Frozen and shared — it's a
// constant, and every consumer treats React style props as read-only.
export const PIXELATED = Object.freeze({ imageRendering: 'pixelated' });

// There is deliberately no canvas-painted checkerboard variant. The Loop
// Trimmer briefly had one (#2933) so its <canvas> frames could show a checker,
// but painting the pattern INTO a backing store ties the check-square size to
// the canvas's scale factor — at source resolution (#2977) the squares shrink
// to noise. Every surface, canvas or <img>, now puts `checkerboardStyle` on the
// wrapping box instead, which is the same rule SpritePreview documents.

// sharp can probe more formats than a browser can paint — a TIFF yields clean
// metadata but renders as a broken-image icon in Chrome/Firefox. So the server
// probe list (for metadata) and this list (for "can I put it in an <img>") are
// deliberately different sets, not duplicates of each other.
const RENDERABLE_FORMATS = new Set(['png', 'gif', 'webp', 'jpeg', 'jpg', 'svg']);

/**
 * Can this asset row be previewed inline as an image? Driven by the SERVER's
 * probe result (`listSpriteAssets` sets `format`/`width`/`height` only for
 * images it read successfully) rather than by a client-side copy of the
 * extension regex — that copy would silently drift, and a truncated PNG passes
 * any extension test while rendering as a broken <img>. The extra
 * RENDERABLE_FORMATS gate covers the opposite case: probed fine, but the
 * browser still can't paint it.
 */
export const hasSpritePreview = (asset) => Boolean(
  asset?.width && asset?.height && RENDERABLE_FORMATS.has(asset.format),
);

// Walk runs keep their grok i2v source clip (`generated/source-video.mp4`) in
// the listing, so the inspector plays it inline rather than making the user
// download it just to review a render.
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

export const isVideoAsset = (asset) => VIDEO_EXT.test(asset?.path || '');
