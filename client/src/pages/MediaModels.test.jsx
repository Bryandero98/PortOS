/**
 * Media Models — the catalog row owns BOTH of a model's deletes.
 *
 * The page used to render the catalog (with a read-only lock on built-ins) and
 * the on-disk HF cache as two disconnected lists, so freeing a built-in model's
 * weights meant scrolling past the whole catalog to find the same model again.
 * These tests pin the join: a catalog row whose repo is cached shows its size
 * and deletes its own weights (built-in included), and the cache section below
 * only lists downloads the catalog doesn't cover.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import MediaModels from './MediaModels';
import {
  listCachedModels,
  listMediaModelRegistry,
  deleteCachedModel,
  removeCustomMediaModel,
} from '../services/api';

vi.mock('../services/api', () => ({
  listCachedModels: vi.fn(),
  listMediaModelRegistry: vi.fn(),
  deleteCachedModel: vi.fn(),
  deleteLora: vi.fn(),
  addMediaModelFromHf: vi.fn(),
  patchCustomMediaModel: vi.fn(),
  removeCustomMediaModel: vi.fn(),
}));

vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const BUILT_IN = {
  id: 'example-video',
  name: 'Example Video Model',
  repo: 'example-org/example-video',
  kind: 'video',
  runtime: 'mlx',
  builtIn: true,
};
const CUSTOM = {
  id: 'hf-mine',
  name: 'My Model',
  repo: 'example-org/mine',
  kind: 'image',
  runner: 'mflux',
  builtIn: false,
};
const CACHED_BUILT_IN = {
  id: 'models--example-org--example-video',
  repo: 'example-org/example-video',
  label: 'Example Video Model (Video)',
  size: 12e9,
  sizeHuman: '12 GB',
};
const ORPHAN = {
  id: 'models--example-org--text-encoder',
  repo: 'example-org/text-encoder',
  label: 'Text Encoder',
  size: 9e9,
  sizeHuman: '9 GB',
};

const CACHE_RESPONSE = {
  models: [CACHED_BUILT_IN, ORPHAN],
  loras: [],
  hubDir: '/example/hub',
  diskUsage: {},
};

describe('MediaModels catalog/cache join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCachedModels.mockResolvedValue(CACHE_RESPONSE);
    listMediaModelRegistry.mockResolvedValue({ video: [BUILT_IN], image: [CUSTOM] });
    deleteCachedModel.mockResolvedValue({});
    removeCustomMediaModel.mockResolvedValue({});
  });

  it('shows the cached size on the catalog row and "not downloaded" when it is absent', async () => {
    render(<MediaModels />);
    await screen.findByText('Example Video Model');
    expect(screen.getByText('12 GB')).toBeInTheDocument();
    expect(screen.getByText(/weights not downloaded/)).toBeInTheDocument();
  });

  it('deletes a BUILT-IN model\'s weights from its own row, behind a confirm', async () => {
    render(<MediaModels />);
    fireEvent.click(await screen.findByRole('button', { name: /Delete weights/ }));
    expect(deleteCachedModel).not.toHaveBeenCalled();

    const confirmPair = screen.getByRole('group', {
      name: 'Confirm deleting cached weights for Example Video Model',
    });
    fireEvent.click(within(confirmPair).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteCachedModel).toHaveBeenCalledWith(
      CACHED_BUILT_IN.id,
      { silent: true },
    ));
    // The row drops back to "not downloaded" without a refetch.
    await waitFor(() => expect(listCachedModels).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('12 GB')).not.toBeInTheDocument();
  });

  it('lists only cache dirs with no catalog entry under "Other cached weights"', async () => {
    render(<MediaModels />);
    await screen.findByText('Text Encoder');
    expect(screen.getByText(/Other cached weights \(1\)/)).toBeInTheDocument();
    // The built-in's cache dir is represented by its catalog row, not repeated.
    expect(screen.queryByText('Example Video Model (Video)')).not.toBeInTheDocument();
  });

  it('arms a separate confirm for removing a custom catalog entry', async () => {
    render(<MediaModels />);
    fireEvent.click(await screen.findByRole('button', { name: /^Remove$/ }));
    expect(removeCustomMediaModel).not.toHaveBeenCalled();
    expect(screen.getByText('Remove from catalog?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(removeCustomMediaModel).toHaveBeenCalledWith(
      CUSTOM.id,
      { silent: true },
    ));
  });
});
