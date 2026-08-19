import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

vi.mock('../services/api', () => new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }));

const Settings = (await import('./Settings')).default;

function Landed() {
  const { pathname, search } = useLocation();
  return <div data-testid="landed">{`${pathname}${search}`}</div>;
}

// Two former Settings tabs now live as drawers over the page they configure.
// Their old /settings/<tab> URLs stay live as redirects so bookmarks, stale ⌘K
// history, and older docs keep working — and land with the drawer already open.
describe('Settings — retired tabs redirect to their drawer', () => {
  it.each([
    ['/settings/image-gen', '/media/image?settings=1'],
    ['/settings/imessage', '/messages/imessage?settings=1'],
  ])('%s → %s', (from, to) => {
    render(
      <MemoryRouter initialEntries={[from]}>
        <Routes>
          <Route path="/settings/:tab" element={<Settings />} />
          <Route path="*" element={<Landed />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('landed').textContent).toBe(to);
  });
});
