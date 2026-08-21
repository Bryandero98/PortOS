/**
 * Cross-package parity for the LoRA trigger-word predicates (#4665).
 *
 * `server/lib/loraTriggers.js` is the source of truth — it decides what the
 * runner actually renders. `client/src/lib/loraTriggers.js` mirrors the two
 * predicates the UI needs so the LoRA picker's "this token will be added" hint
 * and ImageGen's "+ trigger" dedupe agree with what the server will do. If the
 * two disagree, the picker tells the user one thing and the render does
 * another — this suite fails CI instead of letting that ship.
 *
 * It lives server-side because the server module is the authority; both copies
 * are pure and load fine under the node runner.
 */

import { describe, it, expect } from 'vitest';
import {
  firstTriggerWord as serverFirstTriggerWord,
  promptHasTriggerWord as serverPromptHasTriggerWord,
  separatorFor as serverSeparatorFor,
  weaveLoraTriggers,
} from './loraTriggers.js';
import {
  firstTriggerWord as clientFirstTriggerWord,
  promptHasTriggerWord as clientPromptHasTriggerWord,
  separatorFor as clientSeparatorFor,
  appendTriggerWords as clientAppendTriggerWords,
} from '../../client/src/lib/loraTriggers.js';

// Every shape the two implementations must agree on: the whole-token boundary
// (`aria_tok` vs `aria_token`), multi-word Civitai phrases, regex
// metacharacters, case-insensitivity, and the empty/absent inputs.
const PRESENCE_CASES = [
  ['a portrait of Aria_Tok on a rooftop', 'aria_tok'],
  ['a portrait of aria_token', 'aria_tok'],
  ['concatenate the frames', 'cat'],
  ['an audio reactive visualizer', 'audio reactive'],
  ['style: c.a.t art', 'c.a.t'],
  ['style: cXaYt art', 'c.a.t'],
  ['a portrait of ariaé', 'aria'],
  ['a portrait of éclairs', 'éclair'],
  ['a portrait of éclair', 'éclair'],
  ['aria_tok, rooftop', 'aria_tok'],
  ['rooftop', 'aria_tok'],
  ['', 'aria_tok'],
  ['a prompt', ''],
  [null, 'aria_tok'],
  ['a prompt', null],
];

const FIRST_WORD_CASES = [
  ['  aria_tok ', 'portrait'],
  ['', '   ', 'rstgrm'],
  [],
  null,
  'aria_tok',
  [null, 42],
];

describe('LoRA trigger words — server↔client parity', () => {
  it('agrees on whether a word is already present in a prompt', () => {
    for (const [prompt, word] of PRESENCE_CASES) {
      expect(
        clientPromptHasTriggerWord(prompt, word),
        `promptHasTriggerWord drifted for prompt=${JSON.stringify(prompt)} word=${JSON.stringify(word)}`,
      ).toBe(serverPromptHasTriggerWord(prompt, word));
    }
  });

  it('agrees on which word activates a LoRA', () => {
    for (const words of FIRST_WORD_CASES) {
      expect(
        clientFirstTriggerWord(words),
        `firstTriggerWord drifted for ${JSON.stringify(words)}`,
      ).toEqual(serverFirstTriggerWord(words));
    }
  });

  it('agrees on how a trigger clause attaches to the end of a prompt', () => {
    // The server weave and the client's '+ trigger' button both append. Whichever
    // lands the token first makes the other a no-op, so a separator that drifts
    // means one of them can bury the activation token in a trailing directive
    // with nothing downstream to repair it.
    const SEPARATOR_CASES = [
      'a rooftop at dusk',
      'a rooftop at dusk,',
      '',
      'cinematic. a rooftop\n\nno music, no soundtrack',
      'a rooftop\nsecond line',
    ];
    for (const trimmed of SEPARATOR_CASES) {
      expect(
        clientSeparatorFor(trimmed),
        `separatorFor drifted for ${JSON.stringify(trimmed)}`,
      ).toBe(serverSeparatorFor(trimmed));
    }
  });

  it('pins the multi-paragraph rule in BOTH the weave and the button', () => {
    // A mutual regression would slip past the equality check above, so pin the
    // behavior: a token must never join a trailing negation list.
    const multi = 'a rooftop at dusk\n\nno text, no watermark';
    expect(weaveLoraTriggers(multi, [['aria_tok']]).prompt)
      .toBe(`${multi}\n\naria_tok`);
    expect(clientAppendTriggerWords(multi, ['aria_tok']))
      .toBe(`${multi}\n\naria_tok`);
  });

  it('pins the boundary rule both copies encode (not just that they match)', () => {
    // A mutual regression — both copies losing the boundary together — would
    // slip past the equality assertions above, so pin the behavior itself.
    for (const has of [serverPromptHasTriggerWord, clientPromptHasTriggerWord]) {
      expect(has('a portrait of aria_token', 'aria_tok')).toBe(false);
      expect(has('a portrait of aria_tok', 'aria_tok')).toBe(true);
      expect(has('a portrait of ariaé', 'aria')).toBe(false);
    }
    for (const first of [serverFirstTriggerWord, clientFirstTriggerWord]) {
      expect(first(['rstgrm', 'film grain'])).toBe('rstgrm');
    }
  });
});
