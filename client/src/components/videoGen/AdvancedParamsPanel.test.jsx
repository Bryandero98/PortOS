import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdvancedParamsPanel from './AdvancedParamsPanel';

// Every model reaching the client carries a server-resolved `supportedModes`
// (server/lib/videoModeProfiles.js, #3737) — fixtures carry it as payloads do.
const MLX_MODES = ['text', 'image', 'fflf', 'extend'];

const baseProps = {
  mode: 'text',
  currentModel: { steps: 30, guidance: 3.0, runtime: 'mlx_video', supportedModes: MLX_MODES },
  numFrames: 121, onNumFramesChange: vi.fn(),
  chunks: 1, onChunksChange: vi.fn(), keyframesActive: false,
  chunkPrompts: [], onChunkPromptChange: vi.fn(), chainingActive: false,
  contextFrames: 22, onContextFramesChange: vi.fn(),
  fps: 24, onFpsChange: vi.fn(),
  seed: '', onSeedChange: vi.fn(), onRandomSeed: vi.fn(),
  steps: '', onStepsChange: vi.fn(),
  guidanceScale: '', onGuidanceScaleChange: vi.fn(),
  imageStrength: '', onImageStrengthChange: vi.fn(),
  tiling: 'auto', onTilingChange: vi.fn(),
  disableAudio: false, onDisableAudioChange: vi.fn(),
  noMusic: false, onNoMusicChange: vi.fn(),
};

const renderPanel = (props = {}) => render(<AdvancedParamsPanel {...baseProps} {...props} />);

describe('AdvancedParamsPanel', () => {
  it('shows every sampler knob without a disclosure', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: /Advanced/i })).toBeTruthy();
    expect(screen.getByLabelText('Frames')).toBeTruthy();
    expect(screen.getByLabelText('Chunks')).toBeTruthy();
    expect(screen.getByLabelText('FPS')).toBeTruthy();
    expect(screen.getByLabelText('Seed')).toBeTruthy();
    expect(screen.getByLabelText(/Steps/)).toBeTruthy();
    expect(screen.getByLabelText(/CFG Scale/)).toBeTruthy();
    expect(screen.getByLabelText('Tiling')).toBeTruthy();
    expect(screen.getByText(/Disable audio/)).toBeTruthy();
    expect(screen.getByText(/No music/)).toBeTruthy();
  });

  it('propagates edits to the page handlers', () => {
    const onFpsChange = vi.fn();
    const onStepsChange = vi.fn();
    const onTilingChange = vi.fn();
    renderPanel({ onFpsChange, onStepsChange, onTilingChange });
    fireEvent.change(screen.getByLabelText('FPS'), { target: { value: '30' } });
    expect(onFpsChange).toHaveBeenCalledWith(30);
    fireEvent.change(screen.getByLabelText(/Steps/), { target: { value: '40' } });
    expect(onStepsChange).toHaveBeenCalledWith('40');
    fireEvent.change(screen.getByLabelText('Tiling'), { target: { value: 'none' } });
    expect(onTilingChange).toHaveBeenCalledWith('none');
  });

  it('fires onRandomSeed from the dice button', () => {
    const onRandomSeed = vi.fn();
    renderPanel({ onRandomSeed });
    fireEvent.click(screen.getByTitle('Randomize seed'));
    expect(onRandomSeed).toHaveBeenCalled();
  });

  it('hides chunks + the audio flags in a2v mode', () => {
    renderPanel({ mode: 'a2v' });
    expect(screen.queryByLabelText('Chunks')).toBeNull();
    expect(screen.queryByText(/Disable audio/)).toBeNull();
    expect(screen.queryByText(/No music/)).toBeNull();
    // The rest of the knobs still apply.
    expect(screen.getByLabelText('Frames')).toBeTruthy();
  });

  it('hides chunks for a Wan profile that cannot continue via image mode', () => {
    renderPanel({
      currentModel: { runtime: 'wan22', supportedModes: ['text'], frameStride: 4 },
    });
    expect(screen.queryByLabelText('Chunks')).toBeNull();
  });

  it('locks chunks to 1 while multi-keyframe mode is active', () => {
    renderPanel({ chunks: 4, keyframesActive: true });
    const select = screen.getByLabelText('Chunks');
    expect(select.value).toBe('1');
    expect(select.disabled).toBe(true);
  });

  it('shows image strength only where it applies', () => {
    const { unmount } = renderPanel({ mode: 'text' });
    expect(screen.queryByLabelText('Image Strength')).toBeNull();
    unmount();

    renderPanel({ mode: 'image' });
    expect(screen.getByLabelText('Image Strength')).toBeTruthy();
  });

  it('hides image strength for an ltx2 extend render', () => {
    const { unmount } = renderPanel({ mode: 'extend', currentModel: { runtime: 'ltx2', supportedModes: MLX_MODES } });
    expect(screen.queryByLabelText('Image Strength')).toBeNull();
    unmount();

    renderPanel({ mode: 'extend', currentModel: { runtime: 'mlx_video', supportedModes: MLX_MODES } });
    expect(screen.getByLabelText('Image Strength')).toBeTruthy();
  });

  it('disables the no-music flag when audio is off entirely', () => {
    renderPanel({ disableAudio: true });
    expect(screen.getByLabelText(/No music/).disabled).toBe(true);
  });

  it('keeps prompt-audio steering but hides muting and Extend advice for H3', () => {
    renderPanel({
      numFrames: 362,
      currentModel: {
        runtime: 'minimax_h3',
        supportedModes: ['text'],
        frameOptions: [124, 243, 362],
        supportsDisableAudio: false,
      },
    });
    expect(screen.queryByText(/Disable audio/)).toBeNull();
    expect(screen.getByLabelText(/No music/)).not.toBeDisabled();
    expect(screen.queryByText(/use Extend/i)).toBeNull();
  });

  it('keeps the long-render Extend guidance for models that support Extend', () => {
    renderPanel({ numFrames: 313, currentModel: { runtime: 'ltx2', supportedModes: MLX_MODES } });
    expect(screen.getByText(/Past 241 frames/i)).toBeInTheDocument();
  });

  describe('per-chunk prompt beats (#3695)', () => {
    it('hides the beat editor when the request does not chain', () => {
      renderPanel({ chunks: 4, chainingActive: false });
      expect(screen.queryByLabelText('Chunk 1')).toBeNull();
    });

    it('renders one beat row per live chunk, prefilled from the parent', () => {
      renderPanel({ chunks: 3, chainingActive: true, chunkPrompts: ['first', '', 'third'] });
      expect(screen.getByLabelText('Chunk 1').value).toBe('first');
      expect(screen.getByLabelText('Chunk 2').value).toBe('');
      expect(screen.getByLabelText('Chunk 3').value).toBe('third');
      expect(screen.queryByLabelText('Chunk 4')).toBeNull();
    });

    it('shows only the live chunks even when the parent holds text for more', () => {
      // The parent never truncates its array (so raising the count restores the
      // text) — the editor is what scopes the view to the current chunk count.
      renderPanel({ chunks: 2, chainingActive: true, chunkPrompts: ['a', 'b', 'c'] });
      expect(screen.getByLabelText('Chunk 2').value).toBe('b');
      expect(screen.queryByLabelText('Chunk 3')).toBeNull();
    });

    it('reports edits by chunk index', () => {
      const onChunkPromptChange = vi.fn();
      renderPanel({ chunks: 2, chainingActive: true, onChunkPromptChange });
      fireEvent.change(screen.getByLabelText('Chunk 2'), { target: { value: 'the storm breaks' } });
      expect(onChunkPromptChange).toHaveBeenCalledWith(1, 'the storm breaks');
    });
  });

  describe('continuation context window', () => {
    // ltx2 is the only runtime with an extend pipeline to feed a window to.
    const LTX2 = { steps: 30, guidance: 3.0, runtime: 'ltx2' };

    it('stays hidden while the request is not chaining', () => {
      renderPanel({ currentModel: LTX2, chunks: 1, chainingActive: false });
      expect(screen.queryByLabelText('Continuity')).toBeNull();
    });

    it('stays hidden on a runtime that ignores the window', () => {
      // Offering the control where the server discards the value would be a
      // knob that silently does nothing.
      renderPanel({ currentModel: { runtime: 'minimax_h3' }, chunks: 3, chainingActive: true });
      expect(screen.queryByLabelText('Continuity')).toBeNull();
    });

    it('shows the selected window on a chaining ltx2 render', () => {
      renderPanel({ currentModel: LTX2, chunks: 3, chainingActive: true, contextFrames: 45 });
      expect(screen.getByLabelText('Continuity').value).toBe('45');
    });

    it('offers last-frame chaining as an explicit choice', () => {
      renderPanel({ currentModel: LTX2, chunks: 3, chainingActive: true });
      expect(screen.getByRole('option', { name: /Last frame only/ })).toBeTruthy();
    });

    it('reports the choice as a number, so a selected 0 is not sent as a string', () => {
      const onContextFramesChange = vi.fn();
      renderPanel({ currentModel: LTX2, chunks: 3, chainingActive: true, onContextFramesChange });
      fireEvent.change(screen.getByLabelText('Continuity'), { target: { value: '0' } });
      expect(onContextFramesChange).toHaveBeenCalledWith(0);
    });
  });
});

// What the source image PROMISES (#4874). The panel is the surface that states
// the promise, so a wrong option list here is a lie the user acts on.
describe('AdvancedParamsPanel — i2v reference mode (#4874)', () => {
  const LTX25 = { runtime: 'ltx25', name: 'LTX-2.5 MLX Q8', supportedModes: MLX_MODES };
  const withReference = (props = {}) => renderPanel({
    mode: 'image',
    currentModel: LTX25,
    i2vReferenceMode: 'anchor',
    onI2vReferenceModeChange: vi.fn(),
    ...props,
  });

  it('offers both promises on a runtime that can keep them, and prints the active one', () => {
    withReference();
    const select = screen.getByLabelText('Reference mode');
    expect([...select.options].map((o) => o.value)).toEqual(['anchor', 'inspire']);
    expect(select.disabled).toBe(false);
    expect(screen.getByText(/reference is frame one/i)).toBeTruthy();
  });

  it('states the Inspire promise when Inspire is selected', () => {
    withReference({ i2vReferenceMode: 'inspire' });
    expect(screen.getByText(/without reproducing it/i)).toBeTruthy();
  });

  it('offers only Anchor — locked, and explains why — on a runtime that pins frame one', () => {
    withReference({ currentModel: { runtime: 'ltx2', name: 'LTX-2 Unified', supportedModes: MLX_MODES } });
    const select = screen.getByLabelText('Reference mode');
    expect([...select.options].map((o) => o.value)).toEqual(['anchor']);
    expect(select.disabled).toBe(true);
    expect(screen.getByText(/Pick an LTX-2\.5 model to loosen it/i)).toBeTruthy();
  });

  it.each(['text', 'fflf', 'extend', 'a2v'])('hides the picker in %s mode', (mode) => {
    withReference({ mode });
    expect(screen.queryByLabelText('Reference mode')).toBeNull();
  });

  it('hides the picker when no handler is wired, rather than rendering a dead control', () => {
    renderPanel({ mode: 'image', currentModel: LTX25 });
    expect(screen.queryByLabelText('Reference mode')).toBeNull();
  });

  it('reports the change up', () => {
    const onI2vReferenceModeChange = vi.fn();
    withReference({ onI2vReferenceModeChange });
    fireEvent.change(screen.getByLabelText('Reference mode'), { target: { value: 'inspire' } });
    expect(onI2vReferenceModeChange).toHaveBeenCalledWith('inspire');
  });

  it('shows the strength the render will ACTUALLY use, not the pipeline default', () => {
    // An untouched slider under Inspire resolves to the contract's low default;
    // printing "1.0" there would describe an anchored render.
    withReference({ i2vReferenceMode: 'inspire', imageStrength: '', effectiveImageStrength: 0.35 });
    expect(screen.getByText('0.35')).toBeTruthy();
  });
});

// `0` is a legal image strength ("ignore the source entirely"), and the Render
// Queue's retry editor hands it over as a NUMBER. A truthiness fallback rendered
// the control at 1 while the form still submitted 0 — the control lying about
// the render it would produce.
describe('AdvancedParamsPanel — image strength presence vs zero', () => {
  const inImageMode = (props) => renderPanel({ mode: 'image', ...props });

  it.each([
    ['a numeric 0 from the retry editor', 0],
    ['a string "0"', '0'],
  ])('shows %s as 0, not the 1.0 default', (_label, imageStrength) => {
    inImageMode({ imageStrength });
    expect(screen.getByLabelText('Image Strength').value).toBe('0');
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('falls back to the pipeline default only when nothing was set', () => {
    inImageMode({ imageStrength: '' });
    expect(screen.getByLabelText('Image Strength').value).toBe('1');
    expect(screen.getByText('1.0')).toBeTruthy();
  });

  it('prefers an explicit value over the resolved loose default', () => {
    inImageMode({ imageStrength: 0, effectiveImageStrength: 0.35 });
    expect(screen.getByLabelText('Image Strength').value).toBe('0');
  });
});

// The picker must not contradict the state it renders. The form's snap-back
// deliberately defers clearing an Inspire pick until the model catalog resolves,
// so a picker that reads an unresolved model as "anchor only" would disable
// itself, drop the selected option, and claim something about a model nobody has
// seen yet — on exactly the resume/retry path this feature hardened.
describe('AdvancedParamsPanel — reference mode before the model catalog loads', () => {
  const beforeLoad = (props) => renderPanel({
    mode: 'image',
    currentModel: undefined,
    i2vReferenceMode: 'inspire',
    onI2vReferenceModeChange: vi.fn(),
    ...props,
  });

  it('keeps the selected promise listed and the control usable', () => {
    beforeLoad();
    const select = screen.getByLabelText('Reference mode');
    expect(select.value).toBe('inspire');
    expect([...select.options].map((o) => o.value)).toEqual(['anchor', 'inspire']);
    expect(select.disabled).toBe(false);
  });

  it('makes no claim about a model it has not seen', () => {
    beforeLoad();
    expect(screen.queryByText(/can only anchor a reference/i)).toBeNull();
  });

  it('never renders a controlled value with no matching option, even mid-switch', () => {
    // The render between "model switched to one that pins frame one" and "the
    // snap-back effect ran" still holds `inspire`; it stays listed so the select
    // is not silently blank, while the option list is already narrowed.
    renderPanel({
      mode: 'image',
      currentModel: { runtime: 'ltx2', name: 'LTX-2 Unified', supportedModes: MLX_MODES },
      i2vReferenceMode: 'inspire',
      onI2vReferenceModeChange: vi.fn(),
    });
    const select = screen.getByLabelText('Reference mode');
    expect(select.value).toBe('inspire');
    expect([...select.options].map((o) => o.value)).toContain('inspire');
    // The model genuinely cannot loosen a reference, so the control still locks
    // and still says why.
    expect(select.disabled).toBe(true);
    expect(screen.getByText(/can only anchor a reference/i)).toBeTruthy();
  });
});
