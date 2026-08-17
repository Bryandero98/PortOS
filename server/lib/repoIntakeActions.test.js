import { describe, it, expect } from 'vitest';
import { REPO_INTAKE_KEYS, normalizeRepoIntake } from './repoIntakeActions.js';

describe('normalizeRepoIntake', () => {
  it('returns null when nothing was ticked, so no-intake is never persisted', () => {
    expect(normalizeRepoIntake(undefined)).toBeNull();
    expect(normalizeRepoIntake(null)).toBeNull();
    expect(normalizeRepoIntake({})).toBeNull();
    expect(normalizeRepoIntake({ malwareScan: false, learn: false })).toBeNull();
  });

  it('fills every key so a partial payload cannot leave an action undefined', () => {
    expect(normalizeRepoIntake({ learn: true })).toEqual({ malwareScan: false, learn: true });
  });

  it('only accepts a literal true — a truthy string does not opt an agent in', () => {
    expect(normalizeRepoIntake({ malwareScan: 'yes' })).toBeNull();
    expect(normalizeRepoIntake({ malwareScan: 1 })).toBeNull();
  });

  it('ignores unknown keys rather than passing them through', () => {
    expect(normalizeRepoIntake({ learn: true, rmRf: true })).toEqual({ malwareScan: false, learn: true });
  });

  it('keeps a selected target app only for repo study', () => {
    expect(normalizeRepoIntake({ learn: true, targetAppId: ' app-2 ' })).toEqual({
      malwareScan: false,
      learn: true,
      targetAppId: 'app-2',
    });
    expect(normalizeRepoIntake({ malwareScan: true, targetAppId: 'app-2' })).toEqual({
      malwareScan: true,
      learn: false,
    });
  });

  it('rejects non-objects, including arrays', () => {
    expect(normalizeRepoIntake([true])).toBeNull();
    expect(normalizeRepoIntake('malwareScan')).toBeNull();
    expect(normalizeRepoIntake(true)).toBeNull();
  });

  it('covers exactly the two documented actions', () => {
    expect(REPO_INTAKE_KEYS).toEqual(['malwareScan', 'learn']);
  });
});
