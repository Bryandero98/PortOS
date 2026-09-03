/** Canonical joints deliberately shared by the two declared avatar conventions. */
const JOINTS = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];

export const SKELETON_BONE_MAPPINGS = {
  cc3: {
    hips: 'CC_Base_Hip', spine: 'CC_Base_Spine', chest: 'CC_Base_Spine02', neck: 'CC_Base_NeckTwist01', head: 'CC_Base_Head',
    leftUpperArm: 'CC_Base_L_Upperarm', leftLowerArm: 'CC_Base_L_Forearm', leftHand: 'CC_Base_L_Hand',
    rightUpperArm: 'CC_Base_R_Upperarm', rightLowerArm: 'CC_Base_R_Forearm', rightHand: 'CC_Base_R_Hand',
    leftUpperLeg: 'CC_Base_L_Thigh', leftLowerLeg: 'CC_Base_L_Calf', leftFoot: 'CC_Base_L_Foot',
    rightUpperLeg: 'CC_Base_R_Thigh', rightLowerLeg: 'CC_Base_R_Calf', rightFoot: 'CC_Base_R_Foot',
  },
  mixamo: {
    hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', chest: 'mixamorig:Spine2', neck: 'mixamorig:Neck', head: 'mixamorig:Head',
    leftUpperArm: 'mixamorig:LeftArm', leftLowerArm: 'mixamorig:LeftForeArm', leftHand: 'mixamorig:LeftHand',
    rightUpperArm: 'mixamorig:RightArm', rightLowerArm: 'mixamorig:RightForeArm', rightHand: 'mixamorig:RightHand',
    leftUpperLeg: 'mixamorig:LeftUpLeg', leftLowerLeg: 'mixamorig:LeftLeg', leftFoot: 'mixamorig:LeftFoot',
    rightUpperLeg: 'mixamorig:RightUpLeg', rightLowerLeg: 'mixamorig:RightLeg', rightFoot: 'mixamorig:RightFoot',
  },
};

const normalizeBoneName = (name) => String(name || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const semanticByNormalizedName = new Map([
  ...JOINTS.map((joint) => [normalizeBoneName(joint), joint]),
  ...Object.values(SKELETON_BONE_MAPPINGS).flatMap((mapping) => Object.entries(mapping)
    .map(([joint, bone]) => [normalizeBoneName(bone), joint])),
]);

export function knownSkeletonHint(hint) {
  return Object.hasOwn(SKELETON_BONE_MAPPINGS, hint) ? hint : 'unknown';
}

/**
 * Builds an all-or-nothing mapping. Every source bone must be understood and
 * represented by the declared target convention; otherwise callers get a
 * deterministic unmapped list and must refuse the retarget.
 */
export function reduceBoneMapping({ sourceBones, targetBones, skeletonHint } = {}) {
  const sources = [...new Set((Array.isArray(sourceBones) ? sourceBones : []).filter((bone) => typeof bone === 'string' && bone))];
  const targetHint = knownSkeletonHint(skeletonHint);
  const targetSet = new Set(Array.isArray(targetBones) ? targetBones : []);
  if (targetHint === 'unknown') return { ok: false, reason: 'unrecognized-skeleton', mappings: [], unmappedBones: sources };

  const mapping = SKELETON_BONE_MAPPINGS[targetHint];
  const mappings = [];
  const unmappedBones = [];
  for (const sourceBone of sources) {
    const joint = semanticByNormalizedName.get(normalizeBoneName(sourceBone));
    const targetBone = joint && mapping[joint];
    if (!targetBone || !targetSet.has(targetBone)) {
      unmappedBones.push(sourceBone);
      continue;
    }
    mappings.push({ sourceBone, targetBone, joint });
  }
  return unmappedBones.length
    ? { ok: false, reason: 'partial-match', mappings: [], unmappedBones }
    : { ok: true, skeletonHint: targetHint, mappings, unmappedBones: [] };
}

export const REQUIRED_RETARGET_JOINTS = JOINTS;
