import { request } from './apiCore.js';

// Character rigging: the read-only readiness answer for this install's Blender
// runtime. `refresh` forces a re-probe past the server's short-lived memo — use it
// only for an explicit recheck, never on mount.

export const getRiggingReadiness = ({ refresh = false, ...options } = {}) =>
  request(`/rigging/readiness${refresh ? '?refresh=1' : ''}`, options);
