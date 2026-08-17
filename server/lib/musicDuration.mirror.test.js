/**
 * Cross-package parity for the MiniMax Music 3 duration recommendation.
 *
 * The server recomputes the recommendation so requests cannot bypass the
 * client ceiling, while the client uses the same analyzer for immediate UI
 * feedback. Import both copies here so a change to one side cannot silently
 * change the suggested duration or structure warnings on the other.
 */

import { describe, expect, it } from 'vitest';
import * as serverDuration from './musicDuration.js';
import * as clientDuration from '../../client/src/lib/musicDuration.js';

const MIRRORED_CONSTANTS = [
  'MINIMAX_AUTO_MIN_DURATION_SEC',
  'MINIMAX_AUTO_MAX_DURATION_SEC',
  'MINIMAX_AUTO_DURATION_STEP_SEC',
];

const FIXTURES = [
  ['[verse]\nrain on the window\n[chorus]\nsing it loud\n[outro]', {}],
  ['[verse] keep inline text\nplain words\n[outro] last line', {}],
  ['one two three', { minDurationSec: 12, maxDurationSec: 30 }],
  ['', {}],
];

describe('music duration server↔client mirror parity', () => {
  it('keeps the shared constants identical', () => {
    for (const name of MIRRORED_CONSTANTS) {
      expect(clientDuration[name], `${name} drifted between client and server`).toBe(serverDuration[name]);
    }
  });

  it('produces identical lyric analysis and recommendations', () => {
    for (const [lyrics, options] of FIXTURES) {
      expect(clientDuration.analyzeMusicLyrics(lyrics, options)).toEqual(
        serverDuration.analyzeMusicLyrics(lyrics, options),
      );
      expect(clientDuration.recommendMinimaxDurationSec(lyrics, options)).toBe(
        serverDuration.recommendMinimaxDurationSec(lyrics, options),
      );
    }
  });
});
