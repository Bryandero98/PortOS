import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let voiceProfilesRoot = '';
const queryMock = vi.fn();

vi.mock('../../lib/db.js', () => ({ query: (...args) => queryMock(...args) }));
vi.mock('../../lib/paths.js', async () => {
  const actual = await vi.importActual('../../lib/paths.js');
  return { ...actual, PATHS: { ...actual.PATHS, get voiceProfiles() { return voiceProfilesRoot; } } };
});

const {
  parsePresetVoiceId,
  sanitizeVoiceProfile,
  promotePresetProfile,
  resolveCharacterVoice,
  getProfileForSynthesis,
  profileArtifactDirectory,
} = await import('./profiles.js');

const PROFILE = {
  id: 'voice-profile-1',
  version: 2,
  binding: { universeId: 'universe-1', characterId: 'character-1' },
  label: 'Example Character',
  kind: 'preset',
  engine: 'kokoro',
  voiceId: 'kokoro:af_heart',
  modelRevision: 'kokoro-test:q8',
  routes: { studio: { enabled: true }, interactive: { enabled: false } },
  delivery: { rate: 0.9, pitchSemitones: null, formantSemitones: null },
  mastering: { chain: ['preset-output:unprocessed'] },
  approval: { status: 'approved', approvedAt: '2026-08-29T00:00:00.000Z', benchmarkRevision: 2 },
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

beforeEach(async () => {
  voiceProfilesRoot = await mkdtemp(join(tmpdir(), 'portos-voice-profiles-'));
  queryMock.mockReset();
});

afterEach(async () => {
  await rm(voiceProfilesRoot, { recursive: true, force: true });
});

describe('voice profile contract', () => {
  it('only accepts the initially supported namespaced preset engines', () => {
    expect(parsePresetVoiceId('kokoro:af_heart')).toEqual({
      engine: 'kokoro', voice: 'af_heart', voiceId: 'kokoro:af_heart',
    });
    expect(parsePresetVoiceId('piper:en_GB-jenny_dioco-medium')).toMatchObject({ engine: 'piper' });
    expect(parsePresetVoiceId('qwen3:designed')).toBeNull();
    expect(parsePresetVoiceId('af_heart')).toBeNull();
  });

  it('keeps local binding data valid while rejecting path-like profile ids', () => {
    expect(sanitizeVoiceProfile(PROFILE)).toMatchObject({
      id: 'voice-profile-1',
      binding: { universeId: 'universe-1', characterId: 'character-1' },
      routes: { studio: { enabled: true }, interactive: { enabled: false } },
      delivery: { rate: 0.9, pitchSemitones: null, formantSemitones: null },
    });
    expect(sanitizeVoiceProfile({ ...PROFILE, id: '../outside' })).toBeNull();
    expect(sanitizeVoiceProfile({
      ...PROFILE,
      sourceAssets: [
        { filename: 'approved-reference.wav', sha256: 'A'.repeat(64) },
        { filename: '../outside.wav', sha256: 'b'.repeat(64) },
      ],
    }).sourceAssets).toEqual([{
      filename: 'approved-reference.wav', sha256: 'a'.repeat(64), transcript: null, rightsConfirmedAt: null,
    }]);
    expect(() => profileArtifactDirectory('../outside')).toThrow(/invalid voice profile/i);
  });

  it('promotes a preset into a DB-primary local profile and creates its managed directory', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const profile = await promotePresetProfile({
      universeId: 'universe-1',
      characterId: 'character-1',
      characterName: 'Example Character',
      voiceId: 'kokoro:af_heart',
      modelRevision: 'kokoro-test:q8',
    });
    expect(profile).toMatchObject({
      version: 1,
      voiceId: 'kokoro:af_heart',
      approval: { status: 'approved', benchmarkRevision: 1 },
      routes: { studio: { enabled: true }, interactive: { enabled: true } },
      delivery: { rate: 1, pitchSemitones: null, formantSemitones: null },
    });
    const { stat } = await import('node:fs/promises');
    expect((await stat(profileArtifactDirectory(profile.id))).isDirectory()).toBe(true);
    expect(queryMock.mock.calls.at(-1)[0]).toContain('INSERT INTO voice_profiles');
  });

  it('prefers an approved local profile and visibly degrades to a character preset or project default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await expect(resolveCharacterVoice({
      universeId: 'universe-1', characterId: 'character-1', characterVoiceId: 'piper:en_GB-jenny_dioco-medium',
    })).resolves.toMatchObject({ source: 'profile', profileId: PROFILE.id, degraded: false });

    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(resolveCharacterVoice({
      universeId: 'universe-1', characterId: 'character-1', characterVoiceId: 'piper:en_GB-jenny_dioco-medium',
    })).resolves.toMatchObject({ source: 'character-preset', degraded: false });

    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(resolveCharacterVoice({ universeId: 'universe-1', characterId: 'character-1' }))
      .resolves.toMatchObject({ source: 'project-default', degraded: true });
  });

  it('reports a route-disabled approved profile as unavailable before using the portable fallback', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await expect(resolveCharacterVoice({
      universeId: 'universe-1', characterId: 'character-1',
      characterVoiceId: 'piper:en_GB-jenny_dioco-medium', route: 'interactive',
    })).resolves.toMatchObject({
      source: 'character-preset', degraded: true, warning: expect.stringMatching(/unavailable for interactive/i),
    });
  });

  it('rejects a profile on a disabled route instead of silently synthesizing it', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ data: PROFILE }] });
    await expect(getProfileForSynthesis(PROFILE.id, 'interactive'))
      .rejects.toMatchObject({ code: 'VOICE_PROFILE_ROUTE_DISABLED' });
  });
});
