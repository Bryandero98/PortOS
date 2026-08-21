import { describe, it, expect } from 'vitest';
import { weaveLoraTriggers, promptHasTriggerWord, firstTriggerWord } from './loraTriggers.js';

describe('firstTriggerWord', () => {
  it('picks the first usable token and trims it', () => {
    expect(firstTriggerWord(['  aria_tok ', 'portrait'])).toBe('aria_tok');
  });

  it('skips blank leading entries rather than returning an empty token', () => {
    expect(firstTriggerWord(['', '   ', 'rstgrm'])).toBe('rstgrm');
  });

  it('returns null for a missing / empty / non-array list', () => {
    expect(firstTriggerWord([])).toBeNull();
    expect(firstTriggerWord(null)).toBeNull();
    expect(firstTriggerWord('aria_tok')).toBeNull();
    expect(firstTriggerWord([null, 42])).toBeNull();
  });
});

describe('promptHasTriggerWord', () => {
  it('matches whole tokens case-insensitively, anywhere in the prompt', () => {
    expect(promptHasTriggerWord('a portrait of Aria_Tok on a rooftop', 'aria_tok')).toBe(true);
  });

  it('does NOT match inside a longer token', () => {
    // The exact regression the issue names: underscore is a word character,
    // so `aria_tok` must not be considered present in `aria_token`.
    expect(promptHasTriggerWord('a portrait of aria_token', 'aria_tok')).toBe(false);
    expect(promptHasTriggerWord('concatenate the frames', 'cat')).toBe(false);
  });

  it('matches a multi-word Civitai trigger phrase', () => {
    expect(promptHasTriggerWord('an audio reactive visualizer', 'audio reactive')).toBe(true);
  });

  it('applies the word boundary to non-ASCII letters too', () => {
    // An ASCII-only word class would read 'aria' as present inside 'ariaé'
    // (the trailing char is not in [A-Za-z0-9_]), silently skipping the
    // activation token — the failure mode is a LoRA that stays inert.
    expect(promptHasTriggerWord('a portrait of ariaé', 'aria')).toBe(false);
    expect(promptHasTriggerWord('a portrait of éclairs', 'éclair')).toBe(false);
    expect(promptHasTriggerWord('a portrait of éclair', 'éclair')).toBe(true);
  });

  it('treats regex metacharacters in the trigger literally', () => {
    expect(promptHasTriggerWord('style: c.a.t art', 'c.a.t')).toBe(true);
    expect(promptHasTriggerWord('style: cXaYt art', 'c.a.t')).toBe(false);
  });

  it('is false for empty inputs', () => {
    expect(promptHasTriggerWord('', 'aria_tok')).toBe(false);
    expect(promptHasTriggerWord('a prompt', '')).toBe(false);
    expect(promptHasTriggerWord(null, 'aria_tok')).toBe(false);
  });
});

describe('weaveLoraTriggers', () => {
  it('appends a missing trigger word as a trailing clause', () => {
    const { prompt, added } = weaveLoraTriggers('a rooftop at dusk', [['aria_tok']]);
    expect(prompt).toBe('a rooftop at dusk, aria_tok');
    expect(added).toEqual(['aria_tok']);
  });

  it('uses only the FIRST trigger word of each LoRA', () => {
    // Civitai `trainedWords` routinely carries a dozen loosely-related tags;
    // appending all of them would rewrite the render.
    const { prompt, added } = weaveLoraTriggers('a rooftop', [
      ['rstgrm', 'film grain', 'analog', 'vintage'],
    ]);
    expect(prompt).toBe('a rooftop, rstgrm');
    expect(added).toEqual(['rstgrm']);
  });

  it('preserves the user prompt position and weight (append, never prepend)', () => {
    const { prompt } = weaveLoraTriggers('(masterpiece:1.4), a rooftop', [['aria_tok']]);
    expect(prompt.startsWith('(masterpiece:1.4), a rooftop')).toBe(true);
  });

  it('never duplicates a word already present in the prompt', () => {
    const { prompt, added } = weaveLoraTriggers('aria_tok on a rooftop', [['aria_tok']]);
    expect(prompt).toBe('aria_tok on a rooftop');
    expect(added).toEqual([]);
  });

  it('is idempotent — weaving the result again adds nothing', () => {
    const once = weaveLoraTriggers('a rooftop', [['aria_tok'], ['rstgrm']]);
    const twice = weaveLoraTriggers(once.prompt, [['aria_tok'], ['rstgrm']]);
    expect(twice.prompt).toBe(once.prompt);
    expect(twice.added).toEqual([]);
  });

  it('appends multiple LoRAs in selection order', () => {
    const { prompt, added } = weaveLoraTriggers('a rooftop', [['aria_tok'], ['rstgrm']]);
    expect(prompt).toBe('a rooftop, aria_tok, rstgrm');
    expect(added).toEqual(['aria_tok', 'rstgrm']);
  });

  it('dedupes a token shared by two selected LoRAs', () => {
    const { prompt, added } = weaveLoraTriggers('a rooftop', [['aria_tok'], ['ARIA_TOK']]);
    expect(prompt).toBe('a rooftop, aria_tok');
    expect(added).toEqual(['aria_tok']);
  });

  it('skips LoRAs with no trigger words', () => {
    const { prompt, added } = weaveLoraTriggers('a rooftop', [[], null, ['aria_tok'], undefined]);
    expect(prompt).toBe('a rooftop, aria_tok');
    expect(added).toEqual(['aria_tok']);
  });

  it('is a no-op when no LoRAs are selected', () => {
    expect(weaveLoraTriggers('a rooftop', [])).toEqual({ prompt: 'a rooftop', added: [] });
    expect(weaveLoraTriggers('a rooftop', null)).toEqual({ prompt: 'a rooftop', added: [] });
  });

  it('renders triggers alone when the prompt is empty (img2img / unconditional)', () => {
    expect(weaveLoraTriggers('', [['aria_tok']])).toEqual({ prompt: 'aria_tok', added: ['aria_tok'] });
    expect(weaveLoraTriggers('   ', [['aria_tok']])).toEqual({ prompt: 'aria_tok', added: ['aria_tok'] });
  });

  it('leaves an empty prompt untouched when there is nothing to add', () => {
    // Whitespace is only trimmed when something is actually appended, so an
    // empty-prompt render with no LoRAs keeps its exact original value.
    expect(weaveLoraTriggers('  ', [])).toEqual({ prompt: '  ', added: [] });
  });

  it('does not double the separator after a trailing comma', () => {
    expect(weaveLoraTriggers('a rooftop,', [['aria_tok']]).prompt).toBe('a rooftop, aria_tok');
  });

  it('coerces a non-string prompt to empty rather than stringifying it', () => {
    expect(weaveLoraTriggers(null, [['aria_tok']])).toEqual({ prompt: 'aria_tok', added: ['aria_tok'] });
    expect(weaveLoraTriggers(undefined, [])).toEqual({ prompt: '', added: [] });
  });

  it('accepts a bare string entry as a single-word list', () => {
    expect(weaveLoraTriggers('a rooftop', ['aria_tok']).added).toEqual(['aria_tok']);
  });
});
