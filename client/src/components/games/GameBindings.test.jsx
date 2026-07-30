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
        artworkBindings: [{
          id: 'artwork-1',
          imageFilename: 'title.png',
          label: 'Title Key Art',
          role: 'title-key-art',
          destinationPath: 'game/assets/art/title.png',
          publication: null,
        }],
      }}
      sprites={[{
        id: 'deleted-sprite',
        name: 'Stale Deleted Sprite',
        kind: 'character',
        status: 'ready',
      }]}
      tracks={[{
        id: 'theme/one',
        title: 'Example Theme',
        audioFilename: 'example-theme.ogg',
      }]}
      gallery={[{
        filename: 'title.png',
        path: '/data/images/title.png',
        prompt: 'Cinematic alien valley',
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
          artwork: [{
            bindingId: 'artwork-1',
            status: 'ready',
            publicationStatus: 'pending',
            message: 'Gallery source verified · publish pending',
          }],
        },
      }}
      busy={false}
      onBindSprite={noop}
      onUnbindSprite={noop}
      onBindMusic={noop}
      onUnbindMusic={noop}
      onBindArtwork={noop}
      onUpdateArtwork={noop}
      onPublishArtwork={noop}
      onUnbindArtwork={noop}
    />
  </MemoryRouter>,
);

describe('GameBindings', () => {
  it('explains a missing source without trusting a stale catalog entry enough to link it', () => {
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

  it('previews role-specific artwork and keeps publishing behind saved details', () => {
    renderBindings();
    expect(screen.getByRole('heading', { name: 'World & interface artwork' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Title Key Art preview' })).toHaveAttribute('src', '/data/images/title.png');
    expect(screen.getByText('Publish pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish to game' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Generate for this role' }))
      .toHaveAttribute('href', expect.stringContaining('/media/image?prompt='));
  });
});
