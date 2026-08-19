import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TABS } from '../components/settings/SettingsTabsHeader';

// Same stub as Settings.redirects.test.jsx — Settings.jsx imports every tab
// component, and those pull in the API client at import time.
vi.mock('../services/api', () => new Proxy({}, {
  get: (_target, key) => (key === 'then' || key === '__esModule' ? undefined : vi.fn().mockResolvedValue({})),
}));

// The two tabs this test distinguishes between. A slug with no `case` in
// Settings.jsx falls through to the GeneralTab default, so the guard is
// "code-reviewers renders the Code Reviewers panel, not General".
vi.mock('../components/settings/CodeReviewersTab', () => ({
  default: () => <div data-testid="code-reviewers-tab" />,
}));
vi.mock('../components/settings/GeneralTab', () => ({
  GeneralTab: () => <div data-testid="general-tab" />,
}));

const Settings = (await import('./Settings')).default;

const renderTab = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/settings/:tab" element={<Settings />} />
    </Routes>
  </MemoryRouter>,
);

describe('Settings — Code Reviewers tab', () => {
  it('is listed in the settings sub-nav', () => {
    const tab = TABS.find(t => t.id === 'code-reviewers');
    expect(tab?.to).toBe('/settings/code-reviewers');
  });

  it('routes /settings/code-reviewers to the Code Reviewers panel', () => {
    renderTab('/settings/code-reviewers');
    expect(screen.getByTestId('code-reviewers-tab')).toBeTruthy();
    expect(screen.queryByTestId('general-tab')).toBeNull();
  });
});
