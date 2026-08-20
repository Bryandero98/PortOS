import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProviderReadiness from './ProviderReadiness';

const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

const readiness = (overrides = {}) => ({
  kind: 'llama',
  label: 'llama.cpp',
  endpoint: 'http://127.0.0.1:8080/v1',
  manageUrl: '/settings/local-llm',
  docsUrl: 'https://example.com/llama-docs',
  ready: false,
  checks: [
    { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: '`llama-server` is on PortOS\'s PATH.', fixHint: null },
    { id: 'server', label: 'llama.cpp server responding', ok: false, detail: 'Nothing answered at http://127.0.0.1:8080/v1 (connection refused).', fixHint: 'Start llama.cpp — it serves GGUF weights you download yourself.' },
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

  it('links to the Local LLM tab and the vendor docs when the setup is incomplete', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    expect(screen.getByText('Open Local LLM settings').closest('a').getAttribute('href')).toBe('/settings/local-llm');
    expect(screen.getByText('llama.cpp setup docs').closest('a').getAttribute('href')).toBe('https://example.com/llama-docs');
  });

  it('omits the manage link for a runtime PortOS does not install', () => {
    renderWithRouter(<ProviderReadiness readiness={readiness({ label: 'MTPLX', manageUrl: null })} />);
    expect(screen.queryByText('Open Local LLM settings')).toBeNull();
    expect(screen.getByText('MTPLX setup docs')).toBeTruthy();
  });

  it('renders backtick-quoted spans as code rather than literal backticks', () => {
    const { container } = renderWithRouter(<ProviderReadiness readiness={readiness()} />);
    expect(container.textContent).not.toContain('`');
    expect([...container.querySelectorAll('code')].map((el) => el.textContent)).toContain('dflash');
  });
});
