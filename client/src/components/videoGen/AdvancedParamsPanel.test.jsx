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
