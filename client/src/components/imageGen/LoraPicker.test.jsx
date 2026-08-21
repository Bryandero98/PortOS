import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import LoraPicker from './LoraPicker';

const renderPicker = (props) =>
  render(
    <MemoryRouter>
      <LoraPicker onChange={vi.fn()} {...props} />
    </MemoryRouter>,
  );

const LORAS = [
  { filename: 'a.safetensors', name: 'Nine-B LoRA', loraCompatKey: 'flux2-9b', runnerFamily: 'flux2' },
  { filename: 'b.safetensors', name: 'Four-B LoRA', loraCompatKey: 'flux2-4b', runnerFamily: 'flux2' },
  { filename: 'c.safetensors', name: 'Unknown-size LoRA', loraCompatKey: 'flux2', runnerFamily: 'flux2' },
  { filename: 'd.safetensors', name: 'MFlux LoRA', loraCompatKey: 'mflux', runnerFamily: 'mflux' },
];

describe('LoraPicker compat filtering', () => {
  it('hides off-size FLUX.2 LoRAs but keeps the matching + unknown-size ones', () => {
    // The bug this fixes: a flux2-9b LoRA offered for a flux2-4b model.
    renderPicker({ availableLoras: LORAS, selected: [], currentCompatKey: 'flux2-4b', currentRunnerFamily: 'flux2' });
    expect(screen.queryByText('Nine-B LoRA')).toBeNull();      // 9b hidden on a 4b model
    expect(screen.getByText('Four-B LoRA')).toBeTruthy();      // exact match shown
    expect(screen.getByText('Unknown-size LoRA')).toBeTruthy();// size unknown → still shown
    expect(screen.queryByText('MFlux LoRA')).toBeNull();       // wrong family hidden
  });

  it('shows the 9B LoRA once the model switches to flux2-9b', () => {
    renderPicker({ availableLoras: LORAS, selected: [], currentCompatKey: 'flux2-9b', currentRunnerFamily: 'flux2' });
    expect(screen.getByText('Nine-B LoRA')).toBeTruthy();
    expect(screen.queryByText('Four-B LoRA')).toBeNull();
  });

  it('falls back to currentRunnerFamily when no compat key is provided (older callers)', () => {
    renderPicker({ availableLoras: LORAS, selected: [], currentRunnerFamily: 'mflux' });
    expect(screen.getByText('MFlux LoRA')).toBeTruthy();
    expect(screen.queryByText('Four-B LoRA')).toBeNull();
  });

  it('treats a LoRA with no compat key as compatible (surface error at run time)', () => {
    const loras = [{ filename: 'legacy.safetensors', name: 'Legacy LoRA', loraCompatKey: null, runnerFamily: null }];
    renderPicker({ availableLoras: loras, selected: [], currentCompatKey: 'flux2-4b', currentRunnerFamily: 'flux2' });
    expect(screen.getByText('Legacy LoRA')).toBeTruthy();
  });
});

describe('LoraPicker trigger-word hint (#4665)', () => {
  const TRIGGERED = [{
    filename: 't.safetensors',
    name: 'Aria LoRA',
    loraCompatKey: 'flux2-4b',
    runnerFamily: 'flux2',
    triggerWords: ['aria_tok', 'portrait'],
  }];
  const base = { availableLoras: TRIGGERED, currentCompatKey: 'flux2-4b', currentRunnerFamily: 'flux2' };
  const SELECTED = [{ filename: 't.safetensors', name: 'Aria LoRA', scale: 1.0 }];
  const hint = () => screen.queryByText(/will be added to your prompt/i);

  it('warns that the server will append the missing activation token', () => {
    renderPicker({ ...base, selected: SELECTED, prompt: 'a rooftop at dusk' });
    expect(hint()).toBeTruthy();
    // Names the FIRST trigger word — the only one the server weaves in.
    expect(screen.getByText('aria_tok')).toBeTruthy();
  });

  it('stays silent once the prompt already carries the token', () => {
    renderPicker({ ...base, selected: SELECTED, prompt: 'aria_tok on a rooftop' });
    expect(hint()).toBeNull();
  });

  it('is not fooled by the token appearing inside a longer word', () => {
    renderPicker({ ...base, selected: SELECTED, prompt: 'a portrait of aria_token' });
    expect(hint()).toBeTruthy();
  });

  it('stays silent for an unselected LoRA', () => {
    renderPicker({ ...base, selected: [], prompt: 'a rooftop at dusk' });
    expect(hint()).toBeNull();
  });

  it('stays silent when the host did not opt in by passing a prompt', () => {
    // e.g. the pipeline/queue drawers, which have no single prompt textarea to
    // judge against. Defaulting the hint ON there would flag every selected LoRA
    // unconditionally, since an empty prompt contains no trigger word.
    renderPicker({ ...base, selected: SELECTED });
    expect(hint()).toBeNull();
  });
});
