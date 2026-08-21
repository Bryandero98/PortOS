/**
 * Models page — tab routing only.
 *
 * Each tab's panel owns its own fetches (and has its own suite), so all of them
 * are stubbed here. What this file is about is the contract that makes them
 * reachable: `?tab` is a route param, so every panel is deep-linkable, and an
 * unknown slug lands somewhere real instead of rendering blank.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { TABS } from '../components/models/ModelsTabsHeader';

vi.mock('../components/settings/MemoryManagement.jsx', () => ({ default: () => <div>memory panel</div> }));
vi.mock('../components/settings/LocalModelAssessments.jsx', () => ({ default: () => <div>assessments panel</div> }));
vi.mock('../components/settings/LocalLlmTab', () => ({ LocalLlmTab: () => <div>llms panel</div> }));
vi.mock('../components/settings/EmbeddingsTab', () => ({ default: () => <div>embeddings panel</div> }));
vi.mock('../components/models/Image3dRuntimes', () => ({ default: () => <div>3d runtimes panel</div> }));
vi.mock('../components/models/ModelStatusTab', () => ({ default: () => <div>status panel</div> }));
vi.mock('./Loras', () => ({ default: () => <div>loras panel</div> }));
vi.mock('./LoraTraining', () => ({ default: () => <div>training panel</div> }));
vi.mock('./MediaModels', () => ({ default: () => <div>media models panel</div> }));

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
    ['/models/3d', '3d runtimes panel'],
    ['/models/embeddings', 'embeddings panel'],
    ['/models/llms', 'llms panel'],
    ['/models/loras', 'loras panel'],
    ['/models/media', 'media models panel'],
    ['/models/performance', 'assessments panel'],
    ['/models/status', 'status panel'],
    ['/models/training', 'training panel'],
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
    for (const { label } of TABS) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  // The tab bar collapses to a `<select>` under `sm`, so every destination has to
  // be reachable there too — nine tabs no longer fit a phone-width pill row.
  it('mirrors every destination into the mobile select', () => {
    renderAt('/models/performance');
    const select = screen.getByRole('combobox', { name: 'Models sections' });
    expect([...select.options].map((o) => o.textContent)).toEqual(TABS.map((t) => t.label));
  });

  // The header is the section's own map, so it must stay in sync with what the
  // page can actually render. A tab listed but missing from TAB_CONTENT falls
  // through to the unknown-slug redirect and silently lands on Performance —
  // which the per-path cases above cannot see, because they enumerate the paths
  // by hand. Selection state is what distinguishes "rendered this tab" from
  // "bounced to Performance". Playground is the one deliberate exception: it
  // predates the section and keeps its own `/local-llm/playground` path.
  it('serves every /models tab the header advertises, without bouncing to Performance', () => {
    const own = TABS.filter((t) => t.to.startsWith('/models/'));
    expect(own.length).toBe(TABS.length - 1);
    for (const tab of own) {
      const { unmount } = renderAt(tab.to);
      expect(screen.getByRole('tab', { name: tab.label })).toHaveAttribute('aria-selected', 'true');
      unmount();
    }
  });
});
