import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const MODEL = { id: 'dev', name: 'FLUX.1 Dev', runner: 'mflux', steps: 20, guidance: 3.5 };

// The backend probe is held open on purpose: an unconfigured `external` SD API
// URL times out, and that window used to grey out the whole form.
const state = vi.hoisted(() => ({ resolveStatus: null, statusPromise: null, generateImage: vi.fn() }));

vi.mock('../services/api', () => ({
  getInstances: vi.fn(async () => ({ peers: [] })),
  getImageGenStatus: vi.fn(() => state.statusPromise),
  generateImage: (...args) => state.generateImage(...args),
  generateImageMultipart: vi.fn(async () => ({})),
  listImageModels: vi.fn(async () => [MODEL]),
  listLorasFull: vi.fn(async () => []),
  listImageGallery: vi.fn(async () => []),
  cancelImageGen: vi.fn(async () => ({})),
  deleteImage: vi.fn(async () => ({})),
  setImageHidden: vi.fn(async () => ({})),
  cleanGalleryImage: vi.fn(async () => ({})),
  getActiveImageJob: vi.fn(async () => ({ activeJob: null })),
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } })),
  buildFormData: vi.fn(() => new FormData()),
  listMediaJobs: vi.fn(async () => ({ jobs: [] })),
  regenerateGalleryImage: vi.fn(async () => ({})),
  getRegenAvailability: vi.fn(async () => ({ available: false })),
  removeImageWatermark: vi.fn(async () => ({})),
  getFlux2Status: vi.fn(async () => ({ installed: true, ready: true })),
}));

vi.mock('../hooks/useImageGenProgress', () => ({
  useImageGenProgress: () => ({ progress: null, begin: vi.fn(), end: vi.fn(), resume: vi.fn() }),
}));
vi.mock('../hooks/useMediaJobSse', () => ({
  useMediaJobSse: () => ({ attach: vi.fn(), eventSourceRef: { current: null } }),
}));
vi.mock('../hooks/useModelDownloadStatus', () => ({
  useModelDownloadStatus: () => ({
    getStatus: () => ({ cached: true }), start: vi.fn(), cancel: vi.fn(), repair: vi.fn(), refresh: vi.fn(),
    downloading: false, repairing: false, progress: null, lastError: null, activeModelId: null, extra: {}, loading: false, statusError: null,
  }),
}));
vi.mock('../hooks/useHfTokenStatus', () => ({ useHfTokenStatus: () => ({ present: true, refresh: vi.fn() }) }));
vi.mock('../hooks/useAgyModels', () => ({ useAgyModels: () => ({ models: [], error: null }) }));
vi.mock('../hooks/useMediaCompletionRefresh', () => ({ useMediaCompletionRefresh: vi.fn() }));
vi.mock('../hooks/useMediaAnnotations', () => ({
  useMediaAnnotations: () => ({ annotations: {}, updateAnnotation: vi.fn(), getCardProps: vi.fn(() => ({})) }),
}));
vi.mock('../hooks/useAutoRefetch', () => ({ useAutoRefetch: vi.fn() }));
vi.mock('../hooks/usePreviewRoute', () => ({ default: () => [null, vi.fn()] }));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), loading: vi.fn() }),
}));
vi.mock('../components/media/PromptEnhancer', () => ({ default: () => null }));
vi.mock('../components/media/PromptFromMedia', () => ({ default: () => null }));
vi.mock('../components/media/UniverseStylePicker', () => ({ default: () => null }));
vi.mock('../components/media/StylePresetPicker', () => ({ default: () => null }));
vi.mock('../components/media/MediaPreview', () => ({ default: () => null }));
vi.mock('../components/media/MediaJobsQueue', () => ({ default: () => null }));
vi.mock('../components/media/ResolutionField', () => ({ default: () => null }));
vi.mock('../components/Drawer', () => ({ default: () => null }));
vi.mock('../components/settings/ImageGenTab', () => ({ ImageGenTab: () => null }));
vi.mock('../components/imageGen/Flux2InstallModal', () => ({ default: () => null }));
vi.mock('../components/imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/InitImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/ReferenceImagePicker', () => ({ default: () => null }));
vi.mock('../components/imageGen/LoraPicker', () => ({ default: () => null }));

const { default: ImageGen } = await import('./ImageGen.jsx');

const mount = async () => {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/media/image']}>
        <ImageGen />
      </MemoryRouter>,
    );
  });
};

describe('ImageGen backend-probe gating', () => {
  beforeEach(() => {
    state.generateImage.mockReset().mockResolvedValue({ jobId: 'job-1' });
    state.statusPromise = new Promise((resolve) => { state.resolveStatus = resolve; });
  });

  // The probe decides which backend can RUN, not what the user may TYPE. While
  // it is in flight the whole above-the-fold form must stay usable.
  it('leaves the prompt fields editable while the status probe is still in flight', async () => {
    await mount();

    expect(await screen.findByLabelText('Prompt')).not.toBeDisabled();
    expect(screen.getByLabelText('Negative Prompt')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Checking…/ })).toBeDisabled();
  });

  // A probe that comes back unusable must still not take the form hostage —
  // only submit stays blocked, so the user can compose while they fix settings.
  it('keeps the prompt editable and submit blocked when the probe reports not connected', async () => {
    await mount();
    await act(async () => {
      state.resolveStatus({ connected: false, mode: 'local', reason: 'Not configured' });
      await state.statusPromise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled());
    expect(screen.getByLabelText('Prompt')).not.toBeDisabled();
    expect(screen.getByLabelText('Negative Prompt')).not.toBeDisabled();
  });

  // A live form has a live implicit submit: Enter inside a number input fires
  // onSubmit even when the default button is disabled, so the handler carries
  // the same probe gate the button does.
  it('refuses an implicit submit fired while the probe is still in flight', async () => {
    await mount();

    const prompt = await screen.findByLabelText('Prompt');
    fireEvent.change(prompt, { target: { value: 'a lighthouse at dusk' } });
    await act(async () => { fireEvent.submit(prompt.closest('form')); });

    expect(state.generateImage).not.toHaveBeenCalled();
  });
});
