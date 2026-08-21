/**
 * Models page — tab routing only.
 *
 * Each tab's panel owns its own fetches (and has its own suite), so all three
 * are stubbed here. What this file is about is the contract that makes them
 * reachable: `?tab` is a route param, so every panel is deep-linkable, and an
 * unknown slug lands somewhere real instead of rendering blank.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('../components/settings/MemoryManagement.jsx', () => ({ default: () => <div>memory panel</div> }));
vi.mock('../components/settings/LocalModelAssessments.jsx', () => ({ default: () => <div>assessments panel</div> }));
vi.mock('../components/settings/LocalLlmTab', () => ({ LocalLlmTab: () => <div>llms panel</div> }));

import Models from './Models';

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/models/:tab" element={<Models />} />
    </Routes>
  </MemoryRouter>
);

describe('Models', () => {
  it.each([
    ['/models/performance', 'assessments panel'],
    ['/models/status', 'memory panel'],
    ['/models/llms', 'llms panel'],
  ])('renders %s from the route param, not from local state', (path, expected) => {
    renderAt(path);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // A stale ⌘K entry or a typo must not produce a blank page — Performance is
  // the tab that answers "which model should I use?", which is why people land
  // here at all.
  it('redirects an unknown tab slug to Performance', () => {
    renderAt('/models/not-a-tab');
    expect(screen.getByText('assessments panel')).toBeInTheDocument();
  });

  it('offers every Models destination in the sub-nav', () => {
    renderAt('/models/performance');
    for (const label of ['LLMs', 'Performance', 'Playground', 'Status']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });
});
