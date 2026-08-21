import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import RuntimeServersCard from './RuntimeServersCard.jsx';

// Every row renders the same status/action vocabulary, so a text query alone
// would match the wrong runtime. Scope to the row that names it.
const row = (label) => screen.getByText(label).closest('div.flex.flex-col');

const renderCard = (props = {}) => {
  const handlers = {
    onRefresh: vi.fn(),
    onControlOllama: vi.fn(),
    onControlLmStudio: vi.fn(),
    onInstallBackend: vi.fn(),
    onInstallLlama: vi.fn(),
    onStopLlama: vi.fn(),
    onConfigureLlama: vi.fn(),
    onConfigureMtplx: vi.fn(),
    onInstallMtplx: vi.fn(),
    onStartMtplx: vi.fn(),
    onStopMtplx: vi.fn(),
    onSaveStartup: vi.fn(),
  };
  render(
    <MemoryRouter>
      <RuntimeServersCard
        status={{ ollama: { canAutoInstall: true }, lmstudio: {} }}
        llamaStatus={null}
        mtplxStatus={null}
        loading={false}
        busy={false}
        actionInProgress={null}
        {...handlers}
        {...props}
      />
    </MemoryRouter>,
  );
  return handlers;
};

describe('RuntimeServersCard', () => {
  it('lists every local runtime PortOS can run, not just the two catalog backends', () => {
    renderCard();
    for (const label of ['Ollama', 'LM Studio', 'llama.cpp', 'MTPLX']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('offers Start for an installed-but-stopped backend and Stop for a running one', () => {
    const handlers = renderCard({
      status: {
        ollama: { installed: true, available: false, modelCount: 2, baseUrl: 'http://localhost:11434' },
        lmstudio: { installed: true, available: true, modelCount: 1, baseUrl: 'http://localhost:1234' },
      },
    });

    fireEvent.click(within(row('Ollama')).getByRole('button', { name: /Start/ }));
    expect(handlers.onControlOllama).toHaveBeenCalledWith('start');

    fireEvent.click(within(row('LM Studio')).getByRole('button', { name: /Stop/ }));
    expect(handlers.onControlLmStudio).toHaveBeenCalledWith('stop');
  });

  it('will not offer to stop a PM2 runtime PortOS did not start', () => {
    renderCard({
      llamaStatus: { installed: true, running: true, managed: false, endpoint: 'http://127.0.0.1:5568/v1' },
    });
    const llama = row('llama.cpp');
    expect(within(llama).getByText('Running (external)')).toBeInTheDocument();
    expect(within(llama).queryByRole('button', { name: /Stop/ })).toBeNull();
  });

  it('sends llama.cpp to its launcher instead of offering a Start it cannot honour', () => {
    // llama-server takes a REQUIRED model path — a one-click Start here would
    // have to guess which multi-gigabyte GGUF the user meant.
    const handlers = renderCard({ llamaStatus: { installed: true, running: false } });
    const llama = row('llama.cpp');
    expect(within(llama).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(llama).getByText(/Pick a model in Speculative Decoding/)).toBeInTheDocument();

    fireEvent.click(within(llama).getByRole('button', { name: /Configure/ }));
    expect(handlers.onConfigureLlama).toHaveBeenCalled();
  });

  it('starts MTPLX in place once a checkpoint is cached', () => {
    const handlers = renderCard({
      mtplxStatus: { installed: true, running: false, supported: true, cachedModels: ['Example/Qwen-MTP'], endpoint: 'http://127.0.0.1:8000/v1' },
    });
    fireEvent.click(within(row('MTPLX')).getByRole('button', { name: /^Start/ }));
    expect(handlers.onStartMtplx).toHaveBeenCalled();
  });

  it('invokes a row action with NO arguments — never React\'s click event', () => {
    // MTPLX's start handler takes a launch config and the client JSON.stringify's
    // it into the request body. Binding it straight to `onClick` handed it the
    // SyntheticEvent instead, which throws on its circular DOM refs.
    const handlers = renderCard({
      mtplxStatus: { installed: true, running: false, supported: true, cachedModels: ['Example/Qwen-MTP'] },
    });
    const mtplx = row('MTPLX');
    fireEvent.click(within(mtplx).getByRole('button', { name: /^Start/ }));
    expect(handlers.onStartMtplx).toHaveBeenCalledWith();

    fireEvent.click(within(row('Ollama')).getByRole('button', { name: /Install/ }));
    expect(handlers.onInstallBackend).toHaveBeenCalledWith('ollama');
  });

  it('blocks the MTPLX Start with the pull command when its cache is empty', () => {
    // PortOS never downloads MTPLX weights, and `mtplx serve` exits before it
    // binds on an empty cache — so offering Start would only produce a failure.
    renderCard({
      mtplxStatus: { installed: true, running: false, supported: true, cachedModels: [], cacheError: null },
    });
    const mtplx = row('MTPLX');
    expect(within(mtplx).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(mtplx).getByText(/mtplx pull/)).toBeInTheDocument();
  });

  it('reports a runtime this host cannot run without offering to install it', () => {
    renderCard({ mtplxStatus: { installed: false, running: false, supported: false, unsupportedReason: 'MTPLX runs only on macOS with Apple Silicon.' } });
    const mtplx = row('MTPLX');
    expect(within(mtplx).getByText('Unavailable on this platform')).toBeInTheDocument();
    expect(within(mtplx).queryByRole('button', { name: /Install/ })).toBeNull();
  });

  it('flags a PM2 runtime that is in the saved boot list', () => {
    renderCard({
      llamaStatus: { installed: true, running: true, managed: true, pid: 321, runAtStartup: true, endpoint: 'http://127.0.0.1:5568/v1' },
      mtplxStatus: { installed: true, running: true, managed: true, pid: 654, runAtStartup: false, supported: true, endpoint: 'http://127.0.0.1:8000/v1' },
    });
    expect(within(row('llama.cpp')).getByText('starts at boot')).toBeInTheDocument();
    expect(within(row('MTPLX')).queryByText('starts at boot')).toBeNull();
  });

  it('saves the PM2 process list so the running daemons survive a reboot', () => {
    const handlers = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /Save PM2 list for reboot/ }));
    expect(handlers.onSaveStartup).toHaveBeenCalled();
  });

  it('links out to the vendor when PortOS cannot install a backend on this platform', () => {
    renderCard({
      status: {
        ollama: { installed: false, canAutoInstall: false, downloadUrl: 'https://ollama.com/download' },
        lmstudio: {},
      },
    });
    const ollama = row('Ollama');
    expect(within(ollama).queryByRole('button', { name: /Install/ })).toBeNull();
    expect(within(ollama).getByRole('link', { name: /Download/ })).toHaveAttribute('href', 'https://ollama.com/download');
  });
});
