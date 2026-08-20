/**
 * The server's static asset mounts, as data, plus the terminator that stops a
 * server-owned path from being answered with the SPA index.
 *
 * `server/index.js` used to spell each `app.use('/data/…', express.static(…))`
 * out inline, so nothing could enumerate what was served without regexing the
 * source. This is the `server/lib/navManifest.js` pattern the root CLAUDE.md
 * recommends for exactly that drift problem: one table, iterated by the thing
 * that mounts and read as data by the guards. The route strings themselves live
 * one level down in `assetRoutePrefixes.js`, an import-free leaf that
 * `client/vite.config.js` also reads — that is what keeps the dev proxy from
 * falling behind the mounts.
 *
 * `dir` is a thunk, not a string: `wrWorksDir()` derives its path at call time,
 * and a test that re-roots `PATHS.data` at a temp tree needs every entry to
 * resolve after the mock, not at import.
 */
import express from 'express';
import { PATHS } from './fileUtils.js';
import { ServerError, sendErrorResponse } from './errorHandler.js';
import { ASSET_ROUTE_PREFIXES, SERVER_OWNED_PREFIXES } from './assetRoutePrefixes.js';
import { wrWorksDir } from '../services/writersRoom/_shared.js';

// `acceptRanges: true` is the serve-static default already, but we set it
// explicitly because the federated peer-sync receiver
// (services/sharing/peerSync.js) background-pulls missing assets from these
// URLs and relies on HTTP Range to resume partial downloads over flaky
// Tailnet links — losing range support here would silently force every
// retry to restart from byte 0 on a multi-MB PNG / video.
const ASSET_STATIC_OPTS = { acceptRanges: true };

// Only `<workId>/drafts/<draftId>.md` is needed for federation body pulls.
// Without this gate the static root would also serve adjacent work-metadata
// JSON (manifest.json / manifest.imported.json on file-backend/migrated
// installs) to any client that knows a work id.
const writersRoomDraftBodiesOnly = (req, res, next) => {
  if (!/^\/[^/]+\/drafts\/[^/]+\.md$/.test(req.path)) return res.status(404).end();
  next();
};

// Keyed by route so the mount order stays owned by `ASSET_ROUTE_PREFIXES` — the
// list `client/vite.config.js` reads — rather than being restated here.
const ASSET_DIRS = {
  '/data/images': () => PATHS.images,
  // Reference images (multi-ref upload inputs + generated character reference
  // sheets) — served read-only so the UI can render thumbnails by URL.
  '/data/image-refs': () => PATHS.imageRefs,
  // LoRA training dataset images (lora-datasets/<id>/images/*.png).
  '/data/lora-datasets': () => PATHS.loraDatasets,
  // Generated videos + thumbnails, so the Media UI and tailnet clients can pull
  // them by URL without going through an explicit download route.
  '/data/videos': () => PATHS.videos,
  '/data/video-thumbnails': () => PATHS.videoThumbnails,
  // Sprite Manager library previews (anchors, strips, atlases) render inline
  // via <img src="/data/sprites/<id>/<rel>"> (#2895).
  '/data/sprites': () => PATHS.sprites,
  // Image-to-3D GLB meshes (#2952) — the /3d R3F viewer loads them inline
  // via drei useGLTF from <model.assetPath> (/data/image-to-3d/<id>/model.glb).
  '/data/image-to-3d': () => PATHS.imageTo3d,
  // Voice-over WAVs rendered by the pipeline audio stage — the AudioStage UI
  // pulls them inline via <audio src="/data/audio/<filename>">.
  '/data/audio': () => PATHS.audio,
  // Background-music tracks (uploaded today, generated locally tomorrow). The
  // AudioStage music picker plays them inline via <audio src="/data/music/...">.
  '/data/music': () => PATHS.music,
  // Extracted third-party import assets (ChatGPT export images/audio/PDFs). The
  // Brain Memory conversation viewer renders these inline (`![](/data/brain-
  // imports/...)`) and as asset links. Read-only; range support for large PDFs.
  '/data/brain-imports': () => PATHS.brainImportAssets,
  // Writers Room file-primary draft prose bodies (works/<workId>/drafts/<draftId>.md).
  // Federation (#1565) pulls them peer→peer from this mount: a receiver that merged
  // a work record GETs each missing body's bytes by its nested path. Read-only;
  // range support for large drafts. (Tailnet-only per the project's threat model.)
  '/data/writers-room/works': wrWorksDir,
};

const ASSET_GATES = { '/data/writers-room/works': writersRoomDraftBodiesOnly };

/** Every asset mount as `{ route, dir, gate? }`, in mount order. */
export const ASSET_MOUNTS = ASSET_ROUTE_PREFIXES.map((route) => ({
  route,
  dir: ASSET_DIRS[route],
  gate: ASSET_GATES[route],
}));

/**
 * Mount every asset route, then close each server-owned namespace with a 404.
 *
 * The terminators are the point. The SPA fallback skips a request only when its
 * path carries a file extension (`/\.\w+$/`), so an EXTENSIONLESS server path —
 * `/data/image-to-3d/<id>/model`, or a mistyped `/api/…` — used to fall through
 * to the stamped index.html with a 200. A binary loader then parses HTML and
 * dies on a JSON syntax error naming a `<` token, nowhere near the real cause
 * (#4688); an API client gets HTML where it expects JSON, with a success
 * status. The envelope comes from `sendErrorResponse` so this 404 is the same
 * shape as every other one PortOS emits.
 */
export function mountAssetRoutes(app) {
  ASSET_MOUNTS.forEach(({ route, dir, gate }) => {
    app.use(route, ...(gate ? [gate] : []), express.static(dir(), ASSET_STATIC_OPTS));
  });
  SERVER_OWNED_PREFIXES.forEach(({ prefix, spaPaths }) => {
    app.use(prefix, (req, res, next) => (
      // `app.use('/data', …)` reduces the page's own request to `req.path === '/'`.
      spaPaths.includes(prefix + (req.path === '/' ? '' : req.path))
        ? next()
        : sendErrorResponse(res, new ServerError('Not found', { status: 404 }))
    ));
  });
}
