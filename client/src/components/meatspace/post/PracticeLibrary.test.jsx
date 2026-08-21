import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PracticeLibrary from './PracticeLibrary';
import { otherPostSections, PRACTICE_ENTRIES } from './practiceCatalog';

// A config with math switched on and everything else off, so the "In your plan"
// badge has something to be right AND something to be wrong about.
const config = {
  mentalMath: { enabled: true, drillTypes: { multiplication: { enabled: true }, powers: { enabled: false } } },
  llmDrills: { enabled: false, drillTypes: {} },
  cognitive: { enabled: false, drillTypes: {} },
  memory: { enabled: false, drillTypes: {} },
};

const renderLibrary = (props = {}) => render(
  <MemoryRouter>
    <PracticeLibrary config={config} onBack={() => {}} {...props} />
  </MemoryRouter>,
);

// `getByRole('link')` walks every anchor on a ~60-link page and times out under
// jsdom, so links are asserted by href instead — which is what actually matters.
const hrefs = (container) => [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));

describe('PracticeLibrary', () => {
  it('renders every catalogued practice entry', () => {
    const { container } = renderLibrary();
    // Session-only drills render as plain cards; standalone ones render as
    // links. Both must be on the page.
    expect(screen.getByText('Multiplication')).toBeInTheDocument();
    expect(screen.getByText('Schulte Table')).toBeInTheDocument();
    expect(screen.getByText('Iambic Pentameter')).toBeInTheDocument();

    const linked = new Set(hrefs(container));
    const missing = PRACTICE_ENTRIES.map(e => e.to).filter(to => to && !linked.has(to));
    expect([...new Set(missing)]).toEqual([]);
  });

  it('states how many practice surfaces exist', () => {
    renderLibrary();
    expect(screen.getByText(new RegExp(`${PRACTICE_ENTRIES.length} in total`))).toBeInTheDocument();
  });

  it('links to the rest of the POST section, and never at itself', () => {
    renderLibrary();
    // Derived: a POST page added to the shared registry must appear here.
    expect(hrefs(screen.getByLabelText('POST sections')))
      .toEqual(otherPostSections('explore').map(s => s.to));
    expect(hrefs(screen.getByLabelText('POST sections'))).not.toContain('/post/explore');
  });

  it('filters to matching entries as the user searches', () => {
    renderLibrary();
    fireEvent.change(screen.getByLabelText('Search practice'), { target: { value: 'iambic' } });
    expect(screen.getByText('Iambic Pentameter')).toBeInTheDocument();
    expect(screen.queryByText('Multiplication')).not.toBeInTheDocument();
    expect(screen.queryByText('Schulte Table')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', () => {
    renderLibrary();
    fireEvent.change(screen.getByLabelText('Search practice'), { target: { value: 'zzzznotathing' } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('badges only the drills the saved plan would actually run', () => {
    renderLibrary();
    const mathSection = screen.getByText('Mental Math').closest('section');
    const card = (label) => within(mathSection).getByText(label).closest('.rounded-lg');
    expect(within(card('Multiplication')).getByText('In your plan')).toBeInTheDocument();
    // `powers` is enabled: false in the config, so it must NOT be badged.
    expect(within(card('Powers')).queryByText('In your plan')).toBeNull();
  });

  it('renders without a config (cold load) and badges nothing', () => {
    renderLibrary({ config: null });
    expect(screen.getByText('Multiplication')).toBeInTheDocument();
    expect(screen.queryByText('In your plan')).toBeNull();
  });
});
