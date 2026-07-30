import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import GameBindings from './GameBindings.jsx';

const noop = vi.fn();

const renderBindings = () => render(
  <MemoryRouter>
    <GameBindings
      game={{
        spriteBindings: [{ spriteId: 'deleted-sprite' }],
        musicBindings: [{ id: 'binding-1', trackId: 'theme/one' }],
      }}
      sprites={[]}
      tracks={[{
        id: 'theme/one',
        title: 'Example Theme',
        audioFilename: 'example-theme.ogg',
      }]}
      integrity={{
        issues: [
          {
            assetType: 'sprite',
            assetId: 'deleted-sprite',
            code: 'SPRITE_MISSING',
            message: 'Bound sprite no longer exists: deleted-sprite',
          },
          {
            assetType: 'music',
            assetId: 'theme/one',
            code: 'TRACK_AUDIO_INTEGRITY_FAILED',
            message: 'The rendered audio path for "Example Theme" is invalid',
          },
        ],
        assets: {
          sprites: [{
            assetId: 'deleted-sprite',
            status: 'blocked',
            message: 'Bound sprite no longer exists',
          }],
          music: [{
            bindingId: 'binding-1',
            status: 'blocked',
            message: 'Audio path invalid',
          }],
        },
      }}
      busy={false}
      onBindSprite={noop}
      onUnbindSprite={noop}
      onBindMusic={noop}
      onUnbindMusic={noop}
    />
  </MemoryRouter>,
);

describe('GameBindings', () => {
  it('explains a missing source without linking to its deleted record', () => {
    renderBindings();

    expect(screen.getByText(
      'This Sprite Manager record was deleted. Unbind it from this game to clear the blocker.',
    )).toBeInTheDocument();
    const spriteSection = screen.getByRole('heading', { name: 'Sprite assets' }).closest('section');
    expect(within(spriteSection).queryByRole('link')).not.toBeInTheDocument();
  });

  it('falls back to the server message and links when the source record exists', () => {
    renderBindings();

    expect(screen.getByText(
      'The rendered audio path for "Example Theme" is invalid',
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Music' }))
      .toHaveAttribute('href', '/music/tracks/theme%2Fone');
  });
});
