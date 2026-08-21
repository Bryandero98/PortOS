import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MtplxServerCard from './MtplxServerCard.jsx';

const renderCard = (status, props = {}) => {
  const handlers = { onRefresh: vi.fn(), onStart: vi.fn(), onStop: vi.fn(), onInstall: vi.fn() };
  render(
    <MemoryRouter>
      <MtplxServerCard status={status} loading={false} busy={false} actionInProgress={null} {...handlers} {...props} />
    </MemoryRouter>,
  );
  return handlers;
};

describe('MtplxServerCard', () => {
  it('starts on the cached checkpoint and port the user picked', () => {
    const handlers = renderCard({
      installed: true,
      running: false,
      supported: true,
      port: 8000,
      cachedModels: ['Example/Qwen-MTP', 'Example/Other-MTP'],
    });

    fireEvent.change(screen.getByLabelText('Checkpoint'), { target: { value: 'Example/Other-MTP' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '8010' } });
    fireEvent.click(screen.getByRole('button', { name: /Start MTPLX/ }));

    expect(handlers.onStart).toHaveBeenCalledWith({ model: 'Example/Other-MTP', port: 8010 });
  });

  it('omits an untouched field so PortOS picks the cache default and the shipped port', () => {
    const handlers = renderCard({ installed: true, running: false, supported: true, cachedModels: ['Example/Qwen-MTP'] });
    fireEvent.click(screen.getByRole('button', { name: /Start MTPLX/ }));
    expect(handlers.onStart).toHaveBeenCalledWith({});
  });

  it('names the pull command instead of offering a start that cannot bind', () => {
    // PortOS never downloads MTPLX weights, and `mtplx serve` exits before it
    // binds a port on an empty cache.
    renderCard({ installed: true, running: false, supported: true, cachedModels: [], cacheError: null });
    expect(screen.getByText(/model cache is empty/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start MTPLX/ })).toBeDisabled();
  });

  it('still offers a start when the cache could not be READ — unreadable is not empty', () => {
    const handlers = renderCard({ installed: true, running: false, supported: true, cachedModels: [], cacheError: '`mtplx models` timed out' });
    const start = screen.getByRole('button', { name: /Start MTPLX/ });
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    expect(handlers.onStart).toHaveBeenCalled();
  });

  it('will not offer to stop a server started outside PortOS', () => {
    renderCard({ installed: true, running: true, managed: false, supported: true, endpoint: 'http://127.0.0.1:8000/v1' });
    expect(screen.getByText(/Started outside PortOS/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop MTPLX/ })).toBeNull();
  });

  it('offers the install when the binary is missing', () => {
    const handlers = renderCard({ installed: false, running: false, supported: true });
    fireEvent.click(screen.getByRole('button', { name: /Install MTPLX/ }));
    expect(handlers.onInstall).toHaveBeenCalled();
  });

  it('says why, and offers nothing, on a host that cannot run MLX', () => {
    renderCard({ installed: false, running: false, supported: false, unsupportedReason: 'MTPLX runs only on macOS with Apple Silicon.' });
    expect(screen.getByText('MTPLX runs only on macOS with Apple Silicon.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install MTPLX/ })).toBeNull();
  });
});
