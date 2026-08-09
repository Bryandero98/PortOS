import { describe, it, expect } from 'vitest';
import {
  IMAGE_GEN_MODE,
  I2I_CAPABLE_MODES,
  MAX_INPUT_IMAGES,
  cloudPromptRequired,
  isI2iCapableMode,
  pickI2iMode,
  referenceSlotsFor,
  supportsReferenceStrength,
  deriveAvailableBackends,
} from './imageGenBackends';

describe('I2I_CAPABLE_MODES / isI2iCapableMode', () => {
  it('treats every generation backend as i2i-capable, but not external', () => {
    expect(I2I_CAPABLE_MODES).toEqual([
      IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY,
    ]);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.LOCAL)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.CODEX)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.GROK)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.AGY)).toBe(true);
    expect(isI2iCapableMode(IMAGE_GEN_MODE.EXTERNAL)).toBe(false);
    expect(isI2iCapableMode(undefined)).toBe(false);
  });
});

describe('input-image capability helpers', () => {
  it('caps agy at the 3 images its generate_image tool accepts', () => {
    expect(MAX_INPUT_IMAGES[IMAGE_GEN_MODE.AGY]).toBe(3);
    // The other two declare no maximum, so PortOS's own ceiling applies:
    // 1 init image + 4 reference slots.
    expect(MAX_INPUT_IMAGES[IMAGE_GEN_MODE.CODEX]).toBe(5);
    expect(MAX_INPUT_IMAGES[IMAGE_GEN_MODE.GROK]).toBe(5);
  });

  it('lets codex/grok render image-only but always demands a prompt for agy', () => {
    expect(cloudPromptRequired(IMAGE_GEN_MODE.CODEX, true)).toBe(false);
    expect(cloudPromptRequired(IMAGE_GEN_MODE.GROK, true)).toBe(false);
    expect(cloudPromptRequired(IMAGE_GEN_MODE.AGY, true)).toBe(true);
    for (const mode of [IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY]) {
      expect(cloudPromptRequired(mode, false)).toBe(true);
    }
  });

  it('leaves room for the init image when capping a cloud backend\'s reference slots', () => {
    // agy's tool takes 3 images TOTAL, so an init image leaves 2 ref slots.
    expect(referenceSlotsFor(IMAGE_GEN_MODE.AGY, { hasInitImage: false })).toBe(3);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.AGY, { hasInitImage: true })).toBe(2);
    // codex/grok declare no cap, so the form's own 4 slots are the ceiling and
    // an init image doesn't eat into them.
    expect(referenceSlotsFor(IMAGE_GEN_MODE.CODEX, { hasInitImage: true })).toBe(4);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.GROK, { hasInitImage: false })).toBe(4);
  });

  it('offers local reference slots only when the model supports them, and none for external', () => {
    expect(referenceSlotsFor(IMAGE_GEN_MODE.LOCAL, { localSupportsReferences: true })).toBe(4);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.LOCAL, { localSupportsReferences: false })).toBe(0);
    expect(referenceSlotsFor(IMAGE_GEN_MODE.EXTERNAL, { localSupportsReferences: true })).toBe(0);
    expect(referenceSlotsFor(undefined)).toBe(0);
  });

  it('offers numeric per-reference strength only on the local runner', () => {
    expect(supportsReferenceStrength(IMAGE_GEN_MODE.LOCAL)).toBe(true);
    for (const mode of [IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.GROK, IMAGE_GEN_MODE.AGY]) {
      expect(supportsReferenceStrength(mode)).toBe(false);
    }
  });
});

describe('pickI2iMode', () => {
  const backend = (id) => ({ id });

  it('prefers local when both local and codex are available', () => {
    expect(pickI2iMode([backend('external'), backend('codex'), backend('local')]))
      .toBe(IMAGE_GEN_MODE.LOCAL);
  });

  it('falls back to codex when local is absent', () => {
    expect(pickI2iMode([backend('external'), backend('codex')])).toBe(IMAGE_GEN_MODE.CODEX);
  });

  it('returns null when neither i2i backend is installed', () => {
    expect(pickI2iMode([backend('external')])).toBeNull();
    expect(pickI2iMode([])).toBeNull();
  });
});

describe('deriveAvailableBackends', () => {
  it('includes only configured backends and respects excludeExternal', () => {
    const settings = {
      imageGen: {
        local: { pythonPath: '/usr/bin/python3' },
        codex: { enabled: true },
        agy: { enabled: true },
        external: { sdapiUrl: 'http://localhost:7860' },
      },
    };
    expect(deriveAvailableBackends(settings).map((b) => b.id))
      .toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.AGY, IMAGE_GEN_MODE.EXTERNAL]);
    expect(deriveAvailableBackends(settings, { excludeExternal: true }).map((b) => b.id))
      .toEqual([IMAGE_GEN_MODE.LOCAL, IMAGE_GEN_MODE.CODEX, IMAGE_GEN_MODE.AGY]);
    expect(deriveAvailableBackends(undefined)).toEqual([]);
  });
});
