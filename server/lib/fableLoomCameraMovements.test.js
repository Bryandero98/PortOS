import { describe, expect, it } from 'vitest';

import {
  FABLELOOM_CAMERA_MOVEMENTS,
  FABLELOOM_CAMERA_MOVEMENT_VALUES,
  fableLoomCameraMovementCatalogForPrompt,
} from './fableLoomCameraMovements.js';

describe('FableLoom camera movements', () => {
  it('provides unique stable ids and usable prompt direction', () => {
    expect(FABLELOOM_CAMERA_MOVEMENTS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(FABLELOOM_CAMERA_MOVEMENT_VALUES).size).toBe(FABLELOOM_CAMERA_MOVEMENTS.length);
    expect(FABLELOOM_CAMERA_MOVEMENTS.every(({ value, label, prompt }) => value && label && prompt)).toBe(true);
    expect(fableLoomCameraMovementCatalogForPrompt()).toContain('slider-parallax (Slider parallax)');
  });
});
