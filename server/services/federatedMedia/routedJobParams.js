/**
 * The persisted params shape for a media job that renders on a federated peer.
 *
 * `enqueueJob` applies this to EVERY job carrying a `remoteMedia` marker — no
 * route calls it directly. The contract below only holds if it is unbypassable:
 * a helper each routed enqueue site had to remember would be one forgotten call
 * away from shipping a job a rolled-back build renders locally for real, with
 * no guard test to catch it. It normalizes the fields every kind shares; a kind
 * with its own conditioning input still blanks that itself (audio's `lyrics`,
 * `routes/music.js`).
 *
 * ## Downgrade contract (#4683)
 *
 * PortOS is distributed software — one machine of a federated pair can be
 * rolled back to a build that predates `remoteMedia` while the other keeps
 * queueing routed jobs. A legacy build ignores the unknown `remoteMedia` key
 * and dispatches the job to its LOCAL renderer, so the top-level params must be
 * unrenderable there:
 *
 * - `prompt: ''` — the conditioning text rides only inside the versioned
 *   marker. `generateVideo` refuses a blank prompt outright; `generateImage`
 *   deliberately allows one (img2img / regen), so it needs the guard below.
 * - `modelId: null` — NOT a deleted key. `generateImage` and `generateVideo`
 *   both declare `modelId` as a default parameter (`= 'dev'` /
 *   `= defaultVideoModelId()`), and a JS default fires on `undefined` only —
 *   dropping the key would silently select the local default and render for
 *   real wherever that model happens to be installed. An explicit `null`
 *   suppresses the default and lands on the `Unknown or unsupported model`
 *   guard every time, whatever is installed.
 * - `pythonPath: null` — belt and braces for the legacy mflux/imagine_win path,
 *   which refuses an unconfigured interpreter (`IMAGE_GEN_NOT_CONFIGURED`).
 *
 * A persisted `renderer: 'remote'` discriminator was considered and rejected:
 * an older build has no such check, so it would ignore the field entirely and
 * buy no protection. The remote/local distinction is surfaced for DISPLAY
 * instead, off the marker, in `mediaJobQueue/sanitizeJob.js`.
 *
 * Nothing a current build reads is lost — the remote adapters
 * (`imageGen/remote.js`, `videoGen/remote.js`) take the prompt and the model id
 * from `remoteMedia.request`, which is the same body that goes over the wire.
 *
 * @param {object} args
 * @param {object} [args.params] - Job params that survive routing (destination
 *   tags, dimensions, seed). Local-only routing/backend selectors are stripped
 *   by the caller before they get here.
 * @param {object} [args.remoteMedia] - The versioned marker from
 *   prepareRemoteMediaJob. Defaults to the one already on `params` — which is
 *   how enqueueJob calls it, having selected the job on that same marker.
 * @returns {object} Params to persist on the queued proxy job.
 */
export const routedJobParams = ({ params = {}, remoteMedia = params.remoteMedia }) => ({
  ...params,
  prompt: '',
  modelId: null,
  pythonPath: null,
  remoteMedia,
});
