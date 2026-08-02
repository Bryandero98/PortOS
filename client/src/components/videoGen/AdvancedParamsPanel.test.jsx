import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdvancedParamsPanel from './AdvancedParamsPanel';

const baseProps = {
  mode: 'text',
  currentModel: { steps: 30, guidance: 3.0 },
  numFrames: 121, onNumFramesChange: vi.fn(),
  chunks: 1, onChunksChange: vi.fn(), keyframesActive: false,
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
const toggle = () => screen.getByRole('button', { name: /Advanced/i });

describe('AdvancedParamsPanel', () => {
  it('starts collapsed so the Generate button stays above the fold', () => {
    renderPanel();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Frames')).toBeNull();
    expect(screen.queryByLabelText('FPS')).toBeNull();
    expect(screen.queryByLabelText('Seed')).toBeNull();
    expect(screen.queryByLabelText('Tiling')).toBeNull();
  });

  it('summarizes the hidden values while collapsed', () => {
    renderPanel({ numFrames: 121, fps: 24, seed: '42' });
    expect(screen.getByText(/121f @ 24fps/)).toBeTruthy();
    expect(screen.getByText(/5\.0s/)).toBeTruthy();
    expect(screen.getByText(/seed 42/)).toBeTruthy();
  });

  it('reads "random" in the summary when no seed is pinned', () => {
    renderPanel({ seed: '' });
    expect(screen.getByText(/seed random/)).toBeTruthy();
  });

  it('reveals every sampler knob when expanded', () => {
    renderPanel();
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
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

  it('collapses again on a second click', () => {
    renderPanel();
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Frames')).toBeNull();
  });

  it('propagates edits to the page handlers', () => {
    const onFpsChange = vi.fn();
    const onStepsChange = vi.fn();
    const onTilingChange = vi.fn();
    renderPanel({ onFpsChange, onStepsChange, onTilingChange });
    fireEvent.click(toggle());
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
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTitle('Randomize seed'));
    expect(onRandomSeed).toHaveBeenCalled();
  });

  it('hides chunks + the audio flags in a2v mode', () => {
    renderPanel({ mode: 'a2v' });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Chunks')).toBeNull();
    expect(screen.queryByText(/Disable audio/)).toBeNull();
    expect(screen.queryByText(/No music/)).toBeNull();
    // The rest of the knobs still apply.
    expect(screen.getByLabelText('Frames')).toBeTruthy();
  });

  it('locks chunks to 1 while multi-keyframe mode is active', () => {
    renderPanel({ chunks: 4, keyframesActive: true });
    fireEvent.click(toggle());
    const select = screen.getByLabelText('Chunks');
    expect(select.value).toBe('1');
    expect(select.disabled).toBe(true);
  });

  it('shows image strength only where it applies', () => {
    const { unmount } = renderPanel({ mode: 'text' });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Image Strength')).toBeNull();
    unmount();

    renderPanel({ mode: 'image' });
    fireEvent.click(toggle());
    expect(screen.getByLabelText('Image Strength')).toBeTruthy();
  });

  it('hides image strength for an ltx2 extend render', () => {
    const { unmount } = renderPanel({ mode: 'extend', currentModel: { runtime: 'ltx2' } });
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Image Strength')).toBeNull();
    unmount();

    renderPanel({ mode: 'extend', currentModel: { runtime: 'mlx_video' } });
    fireEvent.click(toggle());
    expect(screen.getByLabelText('Image Strength')).toBeTruthy();
  });

  it('disables the no-music flag when audio is off entirely', () => {
    renderPanel({ disableAudio: true });
    fireEvent.click(toggle());
    expect(screen.getByLabelText(/No music/).disabled).toBe(true);
  });
});
