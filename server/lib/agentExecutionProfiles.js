/**
 * Named execution postures shared by the agent spawners and their environment
 * builders. Keep this leaf free of provider/runtime imports so adding a
 * restricted profile cannot pull the full provider graph into schedule reads.
 */

export const PUBLIC_REVIEW_EXECUTION_PROFILE = 'public-review';

// The public-review pipeline has three deliberately different trust postures:
// the security scan is a server-side classifier, the eligibility gate is a
// tool-free reasoner, and the final review is a direct Codex CLI inside a
// disposable workspace-write sandbox. Keep the profile names here so every
// spawn path agrees on which posture is enforced instead of comparing stage
// names or task types.
export const PUBLIC_REVIEW_GATE_EXECUTION_PROFILE = 'public-review-gate';
export const PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE = 'public-review-actions';

export function isPublicReviewNoToolProfile(profile) {
  return profile === PUBLIC_REVIEW_EXECUTION_PROFILE
    || profile === PUBLIC_REVIEW_GATE_EXECUTION_PROFILE;
}

export function isPublicReviewRestrictedProfile(profile) {
  return isPublicReviewNoToolProfile(profile)
    || profile === PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE;
}
