/**
 * Tests for the per-entry Remove (X) affordance on UniverseCanonSection.
 *
 * The contract mirrors the X button that already exists on category
 * variations + composite sheets: one click drops the entry from THIS
 * universe's canon bucket and nothing else. In particular it must go through
 * the dedicated DELETE endpoint (never a wholesale `updateUniverse` PATCH of
 * the array, which would clobber a concurrent render-completion imageRefs[]
 * append on a sibling) and it must not touch the gallery or the Catalog.
 *
 * The harness below owns the universe in real state rather than passing a
 * frozen prop, because the revert path reads the LIVE draft (via the
 * component's `latestUniverseRef`) to decide whether the optimistic removal
 * still needs undoing. A vi.fn() that swallows the change would make the
 * revert look like a no-op for the wrong reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/apiCatalog', () => ({
  listCatalogIngredients: vi.fn(),
  linkCatalogIngredient: vi.fn(),
  unlinkCatalogIngredient: vi.fn(),
}));

vi.mock('../../services/apiUniverseBuilder', () => ({
  extractUniverseCanon: vi.fn(),
  refineUniverseCharacter: vi.fn(),
  differentiateUniverseCast: vi.fn(),
  updateUniverse: vi.fn(),
  getUniverseCanonUsage: vi.fn(),
  setUniverseCanonLock: vi.fn(),
  setUniverseCanonLockAll: vi.fn(),
  removeUniverseCanonEntry: vi.fn(),
  expandUniverseCharacter: vi.fn(),
}));

vi.mock('../../services/apiSystem', () => ({ generateImage: vi.fn() }));

vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import UniverseCanonSection from './UniverseCanonSection';
import {
  removeUniverseCanonEntry, updateUniverse, getUniverseCanonUsage,
} from '../../services/apiUniverseBuilder';
import { unlinkCatalogIngredient } from '../../services/apiCatalog';

const ALEX = {
  id: 'chr-1',
  name: 'Alex',
  physicalDescription: 'jacket',
  imageRefs: ['alex.png'],
  primaryImageRef: 'alex.png',
  ingredientId: 'ing-alex',
  locked: false,
};
const BLAIR = { id: 'chr-2', name: 'Blair', physicalDescription: 'scarf', locked: false };

const baseUniverse = (over = {}) => ({
  id: 'uni-1',
  name: 'Test World',
  characters: [],
  places: [],
  objects: [],
  ...over,
});

// Stateful host so `onUniverseChange` actually swaps the rendered draft.
function Harness({ initial, onChange, kindFilter }) {
  const [universe, setUniverse] = useState(baseUniverse(initial));
  return (
    <UniverseCanonSection
      universe={universe}
      universeId="uni-1"
      onUniverseChange={(next) => { onChange?.(next); setUniverse(next); }}
      imageCfg={{}}
      kindFilter={kindFilter || 'characters'}
    />
  );
}

const renderSection = async ({ universe, onChange, kindFilter } = {}) => {
  const result = render(
    <MemoryRouter>
      <Harness initial={universe} onChange={onChange} kindFilter={kindFilter} />
    </MemoryRouter>,
  );
  // Settle the mount-time canon-usage fetch before the test interacts.
  await act(async () => {});
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  getUniverseCanonUsage.mockResolvedValue({});
});

describe('UniverseCanonSection — remove entry', () => {
  it('calls the canon DELETE endpoint with the kind + entry id, touching nothing else', async () => {
    removeUniverseCanonEntry.mockResolvedValue({
      universe: baseUniverse({ characters: [BLAIR] }),
      entry: ALEX,
    });
    await renderSection({ universe: { characters: [ALEX, BLAIR] } });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    await waitFor(() => expect(removeUniverseCanonEntry).toHaveBeenCalled());
    expect(removeUniverseCanonEntry).toHaveBeenCalledWith(
      'uni-1', 'character', 'chr-1', expect.objectContaining({ silent: true }),
    );
    // Never the wholesale-array PATCH, and never a catalog mutation — the
    // entry's rendered image + catalog ingredient both survive.
    expect(updateUniverse).not.toHaveBeenCalled();
    expect(unlinkCatalogIngredient).not.toHaveBeenCalled();
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();
    expect(screen.getByText('Blair')).toBeInTheDocument();
  });

  it('drops the card optimistically, before the request resolves', async () => {
    let resolveRemove;
    removeUniverseCanonEntry.mockReturnValue(new Promise((res) => { resolveRemove = res; }));
    const onChange = vi.fn();
    await renderSection({ universe: { characters: [ALEX, BLAIR] }, onChange });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].characters.map((c) => c.id)).toEqual(['chr-2']);
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();

    await act(async () => {
      resolveRemove({ universe: baseUniverse({ characters: [BLAIR] }), entry: ALEX });
    });
    expect(screen.queryByText('Alex')).not.toBeInTheDocument();
  });

  it('restores the entry, whole and in place, when the request fails', async () => {
    removeUniverseCanonEntry.mockRejectedValue(new Error('nope'));
    const onChange = vi.fn();
    await renderSection({ universe: { characters: [ALEX, BLAIR] }, onChange });

    fireEvent.click(screen.getByRole('button', { name: /remove alex/i }));

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    const restored = onChange.mock.calls[1][0].characters;
    expect(restored.map((c) => c.id)).toEqual(['chr-1', 'chr-2']);
    // Restored whole — the image refs + catalog backlink round-trip intact.
    expect(restored[0]).toEqual(ALEX);
    expect(screen.getByText('Alex')).toBeInTheDocument();
  });

  it('offers Remove on locked entries — the lock guards AI rewrites, not removal', async () => {
    await renderSection({ universe: { characters: [{ ...ALEX, locked: true }] } });
    expect(screen.getByRole('button', { name: /remove alex/i })).toBeEnabled();
  });

  it.each([
    ['places', { id: 'plc-1', name: 'The Vault', description: 'a room' }],
    ['objects', { id: 'obj-1', name: 'The Key', description: 'brass' }],
  ])('renders a Remove button for %s too', async (kindKey, entry) => {
    await renderSection({ kindFilter: kindKey, universe: { [kindKey]: [entry] } });
    expect(screen.getByRole('button', { name: new RegExp(`remove ${entry.name}`, 'i') }))
      .toBeInTheDocument();
  });
});
