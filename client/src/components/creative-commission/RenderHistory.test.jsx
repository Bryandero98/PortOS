import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import RenderHistory from './RenderHistory.jsx';

vi.mock('../creative-director/ProjectPreview.jsx', () => ({ default: () => <div>project preview</div> }));

const recipe = {
  version: 1,
  source: 'digital-twin',
  window: 'month',
  explorationPercent: 35,
  sourceVersion: 'music-taste-v1:example',
  sourceHash: 'example-hash',
  anchors: [{ kind: 'artist', name: 'Example Artist' }],
};

describe('RenderHistory taste-aware runs', () => {
  it('shows bounded recipe/render provenance and submits structured steering tags', async () => {
    const onRate = vi.fn(async () => {});
    render(
      <MemoryRouter>
        <RenderHistory
          runs={[{
            id: 'run-example', ranAt: new Date().toISOString(), status: 'started', projectId: 'cd-example',
            tasteRecipe: recipe,
          }]}
          feedback={[]}
          projectsById={new Map([['cd-example', { id: 'cd-example', musicBed: { engine: 'musicgen', modelId: 'example-model' } }]])}
          projectsLoading={false}
          onRate={onRate}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Example Artist')).toBeInTheDocument();
    expect(screen.getByText(/35% exploration/)).toBeInTheDocument();
    expect(screen.getByText(/rendered with musicgen · example-model/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More familiar' }));
    fireEvent.click(screen.getByRole('button', { name: 'More experimental' }));
    expect(screen.getByRole('button', { name: 'More familiar' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Like this result' }));
    await waitFor(() => expect(onRate).toHaveBeenCalledWith('run-example', 'up', '', ['more-experimental']));
  });
});
