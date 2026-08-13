/**
 * The managed-apps registry's baseline identity — PortOS itself. Mirrors
 * `server/lib/appIdentity.js`.
 *
 * Split out of `services/apiCore.js` for the same reason the server split it out
 * of `services/apps.js`: a module that only needs to SAY "this record is PortOS"
 * shouldn't have to import the API client — which pulls in `ui/Toast` and
 * therefore React. `client/src/components/apps/constants.js` is imported by a
 * node-env SERVER test (`server/services/streamingDetect.test.js`, the
 * DESKTOP_TYPES parity check), where that React import fails to resolve.
 * `apiCore.js` re-exports the constant, so every existing
 * `import { PORTOS_APP_ID } from '../services/api'` is unchanged.
 *
 * Data only, no dependencies — keep it that way.
 */

/** Stable id of the baseline PortOS app — always present, never deletable. */
export const PORTOS_APP_ID = 'portos-default';
