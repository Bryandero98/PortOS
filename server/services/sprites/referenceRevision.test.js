import { describe, expect, it, vi } from 'vitest';

const unlockReferenceAnchor = vi.fn(async () => ({
  manifest: { status: 'in-progress' },
  candidates: [{ path: 'reference/candidates/example.png' }],
}));
const assertReferenceAnchorUnlockable = vi.fn(async () => {});
const invalidateWalkDirectionForAnchorRevision = vi.fn(async () => true);

vi.mock('./reference.js', () => ({ assertReferenceAnchorUnlockable, unlockReferenceAnchor }));
vi.mock('./walk.js', () => ({ invalidateWalkDirectionForAnchorRevision }));

const { unlockDirectionalAnchor } = await import('./referenceRevision.js');

describe('unlockDirectionalAnchor', () => {
  it('preflights the anchor, invalidates the dependent walk, then unlocks the reference', async () => {
    const result = await unlockDirectionalAnchor('example-pioneer', { direction: 'east' });

    expect(assertReferenceAnchorUnlockable).toHaveBeenCalledWith('example-pioneer', { direction: 'east' });
    expect(unlockReferenceAnchor).toHaveBeenCalledWith('example-pioneer', { direction: 'east' });
    expect(invalidateWalkDirectionForAnchorRevision).toHaveBeenCalledWith(
      'example-pioneer',
      { direction: 'east' },
    );
    expect(assertReferenceAnchorUnlockable.mock.invocationCallOrder[0])
      .toBeLessThan(invalidateWalkDirectionForAnchorRevision.mock.invocationCallOrder[0]);
    expect(invalidateWalkDirectionForAnchorRevision.mock.invocationCallOrder[0])
      .toBeLessThan(unlockReferenceAnchor.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      manifest: { status: 'in-progress' },
      walkInvalidated: true,
    });
  });
});
