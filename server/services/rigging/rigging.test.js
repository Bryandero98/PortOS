import { describe, expect, it } from 'vitest';
import { buildClipCoverage } from './clipCapabilities.js';
import { reduceBoneMapping, SKELETON_BONE_MAPPINGS } from './skeletonMapping.js';

describe('rigging skeleton compatibility', () => {
  const cc3Bones = Object.values(SKELETON_BONE_MAPPINGS.cc3);

  it('maps a recognized Mixamo source onto a complete CC3 target', () => {
    const sourceBones = Object.values(SKELETON_BONE_MAPPINGS.mixamo);
    const result = reduceBoneMapping({ sourceBones, targetBones: cc3Bones, skeletonHint: 'cc3' });
    expect(result).toMatchObject({ ok: true, skeletonHint: 'cc3', unmappedBones: [] });
    expect(result.mappings).toHaveLength(sourceBones.length);
    expect(result.mappings[0]).toMatchObject({ sourceBone: 'mixamorig:Hips', targetBone: 'CC_Base_Hip', joint: 'hips' });
  });

  it('refuses an unknown target convention and names every source bone', () => {
    expect(reduceBoneMapping({ sourceBones: ['Hips', 'MysteryJoint'], targetBones: cc3Bones, skeletonHint: 'unknown' }))
      .toEqual({ ok: false, reason: 'unrecognized-skeleton', mappings: [], unmappedBones: ['Hips', 'MysteryJoint'] });
  });

  it('refuses a partial match rather than retargeting only the compatible bones', () => {
    const result = reduceBoneMapping({ sourceBones: ['mixamorig:Hips', 'mixamorig:Head'], targetBones: ['CC_Base_Hip'], skeletonHint: 'cc3' });
    expect(result).toEqual({ ok: false, reason: 'partial-match', mappings: [], unmappedBones: ['mixamorig:Head'] });
  });
});

describe('clip capability report', () => {
  it('reports covered and missing states without treating a partial roster as complete', () => {
    const result = buildClipCoverage(['Idle', 'Wave', 'Dance']);
    expect(result.coverageByState.thinking).toEqual({ covered: true, clip: 'Idle' });
    expect(result.coverageByState.speaking).toEqual({ covered: true, clip: 'Wave' });
    expect(result.coverageByState.coding).toEqual({ covered: false, clip: null });
    expect(result).toMatchObject({ complete: false, missingStates: expect.arrayContaining(['coding']) });
  });
});
