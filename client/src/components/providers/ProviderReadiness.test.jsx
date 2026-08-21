import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProviderReadiness from './ProviderReadiness';

const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

const readiness = (overrides = {}) => ({
  kind: 'llama',
  label: 'llama.cpp',
  endpoint: 'http://127.0.0.1:5568/v1',
  manageUrl: '/models/llms',
  docsUrl: 'https://example.com/llama-docs',
  ready: false,
  setup: null,
  checks: [
    { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: '`llama-server` is on PortOS\'s PATH.', fixHint: null },
    { id: 'server', label: 'llama.cpp server responding', ok: false, detail: 'Nothing answered at http://127.0.0.1:5568/v1 (connection refused).', fixHint: 'Start llama.cpp — it serves GGUF weights you download yourself.' },
    { id: 'model', label: 'Model `dflash` available', ok: null, detail: 'Cannot be checked until the server responds.', fixHint: null },
  ],
  ...overrides,
});

describe('ProviderReadiness', () => {
  it.each([
    ['no report yet (the card paints before the fetch lands)', null],
    ['a report with no checks', readiness({ checks: [] })],
  ])('renders nothing for %s', (_label, value) => {
    const { container } = renderWithRouter(<ProviderReadiness readiness={value} />);
    expect(container.textContent).toBe('');
  });

  it('collapses to a single pill once every requirement is met', () => {
    const met = readiness({
      ready: true,
      checks: readiness().checks.map((check) => ({ ...check, ok: true, fixHint: null })),
    });
    renderWithRouter(<ProviderReadiness readiness={met} />);
    expect(screen.getByText('llama.cpp ready')).toBeTruthy();
    expect(screen.queryByText(/setup incomplete/)).toBeNull();
  });

  it('counts only the unmet requirements, and shows each fix', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    // The `server` failure plus the `model` check that could not be evaluated —
    // an unknown is not a pass.
    expect(screen.getByText(/2 requirements unmet/)).toBeTruthy();
    expect(screen.getByText(/Start llama\.cpp/)).toBeTruthy();

    // …and reads correctly when only one is outstanding.
    renderWithRouter(<ProviderReadiness readiness={readiness({ checks: readiness().checks.slice(0, 2) })} />);
    expect(screen.getByText(/1 requirement unmet/)).toBeTruthy();
  });

  it('links to the Models → LLMs page as an in-app action — never to vendor setup docs', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    expect(screen.getByText('Open the LLMs page').closest('a').getAttribute('href')).toBe('/models/llms');
    expect(screen.queryByText(/setup docs/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /llama\.cpp setup docs/i })).toBeNull();
  });

  it('omits the manage link for a runtime PortOS does not install, and still never points at docs', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness({ label: 'MTPLX', manageUrl: null })} />);
    expect(screen.queryByText('Open the LLMs page')).toBeNull();
    expect(screen.queryByText(/setup docs/i)).toBeNull();
  });

  it('offers the one-click setup instead of leaving a docs link as the only way forward', () => {
    const onAutoSetup = vi.fn();
    const setup = { runtime: 'mtplx', label: 'MTPLX', action: 'install-start', actionLabel: 'Install & start MTPLX', blockedReason: null };
    renderWithRouter(
      <ProviderReadiness readiness={readiness({ label: 'MTPLX', manageUrl: null, setup })} onAutoSetup={onAutoSetup} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Install & start MTPLX/ }));
    expect(onAutoSetup).toHaveBeenCalledWith(setup);
    expect(screen.queryByText(/setup docs/i)).toBeNull();
  });

  it('offers a one-click default-model match when the daemon is serving a different id', () => {
    const onUseServedModel = vi.fn();
    const mismatch = readiness({
      checks: [
        { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: 'on PATH', fixHint: null },
        { id: 'server', label: 'llama.cpp server responding', ok: true, detail: 'answered', fixHint: null },
        {
          id: 'model',
          label: 'Model `qwen3.8-27b-dflash2` available',
          ok: false,
          detail: 'llama.cpp is serving `dflash`.',
          fixHint: 'This provider will send `qwen3.8-27b-dflash2`, but the running server only accepts `dflash`.',
          servedModels: ['dflash'],
        },
      ],
    });
    renderWithRouter(<ProviderReadiness readiness={mismatch} onUseServedModel={onUseServedModel} />);

    fireEvent.click(screen.getByRole('button', { name: /Use dflash as default/ }));
    expect(onUseServedModel).toHaveBeenCalledWith('dflash');
    expect(screen.queryByText(/setup docs/i)).toBeNull();
  });

  it('does not invent a use-as-default button when nothing is loaded', () => {
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({
          checks: [
            { id: 'model', label: 'Model `dflash` available', ok: false, detail: 'no model loaded', fixHint: 'Start a preset from Models → LLMs.', servedModels: [] },
          ],
        })}
        onUseServedModel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /as default/ })).toBeNull();
  });

  it('shows no setup button when the host cannot run the runtime', () => {
    renderWithRouter(
      <ProviderReadiness
        readiness={readiness({ setup: { runtime: 'mtplx', label: 'MTPLX', action: null, actionLabel: null, blockedReason: 'MTPLX runs only on macOS with Apple Silicon.' } })}
        onAutoSetup={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows no setup button when the card has no handler wired', () => {
    // The banner is also rendered read-only in places with nothing to click.
    renderWithRouter(
      <ProviderReadiness readiness={readiness({ setup: { runtime: 'llama', label: 'llama.cpp', action: 'install', actionLabel: 'Install llama.cpp', blockedReason: null } })} />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders backtick-quoted spans as code rather than literal backticks', () => {
    const { container } = renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    expect(container.textContent).not.toContain('`');
    expect([...container.querySelectorAll('code')].map((el) => el.textContent)).toContain('dflash');
  });
});
