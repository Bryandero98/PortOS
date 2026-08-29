/**
 * Machine-local character voice profiles (#5380).
 *
 * Universe characters retain only portable voice direction and their legacy
 * namespaced preset id. This module owns the local, DB-primary binding that
 * can be promoted independently on each install, plus the managed directory
 * that holds benchmark renders and future engine artifacts.
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';

export const VOICE_PROFILE_ENGINES = new Set(['kokoro', 'piper']);
export const VOICE_PROFILE_ROUTES = new Set(['studio', 'interactive']);

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_ID = 160;
const MAX_LABEL = 160;
const MAX_REVISION = 240;
const MAX_BENCHMARK_LINES = 12;
const DEFAULT_DELIVERY = Object.freeze({ rate: 1, pitchSemitones: null, formantSemitones: null });
// This initial preset wrapper deliberately makes no opaque DSP changes. Naming
// the no-op is still useful provenance: an old render can be distinguished
// from a later profile revision that does add a supported mastering step.
const DEFAULT_MASTERING = Object.freeze({ chain: ['preset-output:unprocessed'] });
const SAFE_ASSET_BASENAME = /^[a-z0-9][a-z0-9._-]{0,159}$/i;

const trim = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const timestamp = () => new Date().toISOString();
const positiveInteger = (value, fallback = 1) =>
  Number.isInteger(value) && value > 0 ? value : fallback;

export function parsePresetVoiceId(voiceId) {
  const value = trim(voiceId, MAX_ID);
  const match = /^([a-z][a-z0-9-]*):([^:\s]+)$/i.exec(value);
  if (!match) return null;
  const engine = match[1].toLowerCase();
  if (!VOICE_PROFILE_ENGINES.has(engine)) return null;
  return { engine, voice: match[2], voiceId: `${engine}:${match[2]}` };
}

const sanitizeRoutes = (raw) => Object.fromEntries(
  [...VOICE_PROFILE_ROUTES].map((route) => [route, {
    enabled: raw?.[route]?.enabled === true,
  }]),
);

const boundedNumber = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const sanitizeDelivery = (raw) => ({
  // Rate is implemented by both preset engines. Pitch/formant are intentionally
  // represented as null rather than zero: zero would claim that an unavailable
  // transform was applied, while null makes the disabled state explicit.
  rate: boundedNumber(raw?.rate, 0.25, 4, DEFAULT_DELIVERY.rate),
  pitchSemitones: null,
  formantSemitones: null,
});

const sanitizeMastering = (raw) => ({
  // An explicit empty chain means the initial preset wrapper applies no hidden
  // mastering. That is distinct from an absent profile and keeps provenance
  // honest until a capability-probed mastering adapter is added.
  chain: Array.isArray(raw?.chain)
    ? raw.chain.map((step) => trim(step, 80)).filter(Boolean).slice(0, 12)
    : [...DEFAULT_MASTERING.chain],
});

const sanitizeBenchmark = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const renderedAt = trim(raw.renderedAt, 64);
  const lines = Array.isArray(raw.lines) ? raw.lines.map((line) => {
    const filename = trim(line?.filename, 200);
    if (!filename) return null;
    return {
      key: trim(line.key, 64),
      text: trim(line.text, 1000),
      filename,
      latencyMs: Number.isFinite(line.latencyMs) ? Math.max(0, Math.round(line.latencyMs)) : null,
      engine: VOICE_PROFILE_ENGINES.has(line.engine) ? line.engine : null,
      modelRevision: trim(line.modelRevision, MAX_REVISION) || null,
      effectiveControls: {
        rate: Number.isFinite(line?.effectiveControls?.rate) ? line.effectiveControls.rate : null,
      },
    };
  }).filter(Boolean).slice(0, MAX_BENCHMARK_LINES) : [];
  if (!renderedAt || lines.length === 0) return null;
  return {
    profileRevision: positiveInteger(raw.profileRevision),
    renderedAt,
    lines,
    mastering: sanitizeMastering(raw.mastering),
  };
};

const sanitizeSourceAssets = (raw) => Array.isArray(raw)
  ? raw.map((asset) => {
    const filename = trim(asset?.filename, 160);
    if (!SAFE_ASSET_BASENAME.test(filename)) return null;
    return {
      filename,
      sha256: /^[a-f0-9]{64}$/i.test(trim(asset?.sha256, 64)) ? trim(asset.sha256, 64).toLowerCase() : null,
      transcript: trim(asset?.transcript, 4000) || null,
      rightsConfirmedAt: trim(asset?.rightsConfirmedAt, 64) || null,
    };
  }).filter(Boolean).slice(0, 24)
  : [];

/** Turn a raw DB JSON payload into the durable public profile shape. */
export function sanitizeVoiceProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = trim(raw.id, 80);
  const universeId = trim(raw?.binding?.universeId, MAX_ID);
  const characterId = trim(raw?.binding?.characterId, MAX_ID);
  const preset = parsePresetVoiceId(raw.voiceId);
  if (!PROFILE_ID_RE.test(id) || !universeId || !characterId || !preset) return null;

  const approvalStatus = raw?.approval?.status === 'approved'
    ? 'approved'
    : raw?.approval?.status === 'retired' ? 'retired' : 'draft';
  const createdAt = trim(raw.createdAt, 64) || timestamp();
  const updatedAt = trim(raw.updatedAt, 64) || createdAt;
  return {
    id,
    version: positiveInteger(raw.version),
    binding: { universeId, characterId },
    label: trim(raw.label, MAX_LABEL) || null,
    kind: 'preset',
    engine: preset.engine,
    voiceId: preset.voiceId,
    modelRevision: trim(raw.modelRevision, MAX_REVISION) || 'configured-preset',
    // Preset profiles start empty. The same shape is ready for future,
    // user-supplied source recordings without ever accepting a path string.
    sourceAssets: sanitizeSourceAssets(raw.sourceAssets),
    routes: sanitizeRoutes(raw.routes),
    delivery: sanitizeDelivery(raw.delivery),
    mastering: sanitizeMastering(raw.mastering),
    approval: {
      status: approvalStatus,
      approvedAt: approvalStatus === 'approved' ? trim(raw?.approval?.approvedAt, 64) || updatedAt : null,
      benchmarkRevision: positiveInteger(raw?.approval?.benchmarkRevision),
    },
    benchmark: sanitizeBenchmark(raw.benchmark),
    createdAt,
    updatedAt,
  };
}

const profileDirectory = (id) => join(PATHS.voiceProfiles, id);

export function profileArtifactDirectory(id) {
  if (!PROFILE_ID_RE.test(id || '')) {
    throw new ServerError('invalid voice profile id', { status: 400, code: 'VOICE_PROFILE_INVALID_ID' });
  }
  return profileDirectory(id);
}

const persist = async (profile) => {
  await query(
    `INSERT INTO voice_profiles (id, universe_id, character_id, approval_status, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       universe_id = EXCLUDED.universe_id,
       character_id = EXCLUDED.character_id,
       approval_status = EXCLUDED.approval_status,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      profile.id,
      profile.binding.universeId,
      profile.binding.characterId,
      profile.approval.status,
      JSON.stringify(profile),
      profile.createdAt,
      profile.updatedAt,
    ],
  );
  return profile;
};

export async function getVoiceProfile(id) {
  const profileId = trim(id, 80);
  if (!PROFILE_ID_RE.test(profileId)) return null;
  const { rows } = await query('SELECT data FROM voice_profiles WHERE id = $1', [profileId]);
  return sanitizeVoiceProfile(rows[0]?.data);
}

export async function getVoiceProfileRequired(id) {
  const profile = await getVoiceProfile(id);
  if (!profile) {
    throw new ServerError('Voice profile not found', { status: 404, code: 'VOICE_PROFILE_NOT_FOUND' });
  }
  return profile;
}

export async function listVoiceProfiles({ universeId, characterId } = {}) {
  const clauses = [];
  const params = [];
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  if (universe) { params.push(universe); clauses.push(`universe_id = $${params.length}`); }
  if (character) { params.push(character); clauses.push(`character_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT data FROM voice_profiles ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY updated_at DESC, id DESC`,
    params,
  );
  return rows.map((row) => sanitizeVoiceProfile(row.data)).filter(Boolean);
}

async function getBoundProfile(universeId, characterId) {
  const { rows } = await query(
    `SELECT data FROM voice_profiles
     WHERE universe_id = $1 AND character_id = $2
     ORDER BY (approval_status = 'approved') DESC, updated_at DESC, id DESC LIMIT 1`,
    [universeId, characterId],
  );
  return sanitizeVoiceProfile(rows[0]?.data);
}

/**
 * Explicitly promote a selected Kokoro/Piper preset to the local character
 * binding. Re-promoting a different preset increments its reproducible
 * revision; the universe record itself remains untouched and federatable.
 */
export async function promotePresetProfile({
  universeId,
  characterId,
  characterName = '',
  voiceId,
  modelRevision = 'configured-preset',
  delivery = DEFAULT_DELIVERY,
} = {}) {
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  const preset = parsePresetVoiceId(voiceId);
  if (!universe || !character || !preset) {
    throw new ServerError('A universe, character, and Kokoro/Piper preset are required', {
      status: 400,
      code: 'VOICE_PROFILE_INVALID_PRESET',
    });
  }
  const current = await getBoundProfile(universe, character);
  const samePreset = current?.voiceId === preset.voiceId;
  const now = timestamp();
  const next = sanitizeVoiceProfile({
    ...current,
    id: current?.id || randomUUID(),
    version: current ? (samePreset ? current.version : current.version + 1) : 1,
    binding: { universeId: universe, characterId: character },
    label: trim(characterName, MAX_LABEL) || current?.label || null,
    kind: 'preset',
    engine: preset.engine,
    voiceId: preset.voiceId,
    modelRevision: trim(modelRevision, MAX_REVISION) || 'configured-preset',
    routes: current?.routes || { studio: { enabled: true }, interactive: { enabled: true } },
    delivery: current?.delivery || delivery,
    mastering: current?.mastering || DEFAULT_MASTERING,
    approval: {
      status: 'approved',
      approvedAt: now,
      benchmarkRevision: current ? (samePreset ? current.approval.benchmarkRevision : current.approval.benchmarkRevision + 1) : 1,
    },
    benchmark: samePreset ? current?.benchmark : null,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  });
  await mkdir(profileDirectory(next.id), { recursive: true });
  return persist(next);
}

export async function saveProfileBenchmark(profile, benchmark) {
  const current = await getVoiceProfileRequired(profile?.id);
  const next = sanitizeVoiceProfile({
    ...current,
    benchmark,
    updatedAt: timestamp(),
  });
  return persist(next);
}

const assertRoute = (route) => {
  if (!VOICE_PROFILE_ROUTES.has(route)) {
    throw new ServerError('Unsupported voice profile route', { status: 400, code: 'VOICE_PROFILE_INVALID_ROUTE' });
  }
};

export async function getProfileForSynthesis(id, route = 'studio') {
  assertRoute(route);
  const profile = await getVoiceProfileRequired(id);
  if (profile.approval.status !== 'approved') {
    throw new ServerError('Voice profile is not approved', { status: 409, code: 'VOICE_PROFILE_UNAPPROVED' });
  }
  if (profile.routes[route]?.enabled !== true) {
    throw new ServerError(`Voice profile is not enabled for ${route}`, {
      status: 409,
      code: 'VOICE_PROFILE_ROUTE_DISABLED',
    });
  }
  return profile;
}

/**
 * Resolve a local profile before portable character/default voice fallbacks.
 * `degraded` is explicit so a peer without the local profile never looks like
 * it has silently honoured a character's approved local voice.
 */
export async function resolveCharacterVoice({
  universeId,
  characterId,
  characterVoiceId = null,
  route = 'studio',
} = {}) {
  assertRoute(route);
  const universe = trim(universeId, MAX_ID);
  const character = trim(characterId, MAX_ID);
  let unavailableProfile = null;
  if (universe && character) {
    const profiles = await listVoiceProfiles({ universeId: universe, characterId: character });
    const profile = profiles.find((item) =>
      item.approval.status === 'approved' && item.routes[route]?.enabled === true,
    );
    if (profile) {
      return {
        source: 'profile',
        profileId: profile.id,
        profileRevision: profile.version,
        voiceId: profile.voiceId,
        degraded: false,
        warning: null,
      };
    }
    unavailableProfile = profiles.find((item) => item.approval.status === 'approved') || null;
  }
  const preset = parsePresetVoiceId(characterVoiceId);
  if (preset) {
    return {
      source: 'character-preset',
      profileId: null,
      profileRevision: null,
      voiceId: preset.voiceId,
      degraded: Boolean(unavailableProfile),
      warning: unavailableProfile
        ? `The approved local voice profile is unavailable for ${route}; using the portable character preset.`
        : null,
    };
  }
  return {
    source: 'project-default',
    profileId: null,
    profileRevision: null,
    voiceId: null,
    degraded: true,
    warning: unavailableProfile
      ? `The approved local voice profile is unavailable for ${route} and has no portable character preset; using the project default.`
      : 'No approved local voice profile or character preset is available; using the project default.',
  };
}
