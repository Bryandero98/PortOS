import { describe, it, expect } from 'vitest';
import { stripMarkdownEmphasis } from './markdownText.js';

describe('stripMarkdownEmphasis', () => {
  it('unwraps the common inline markers, keeping the words', () => {
    expect(stripMarkdownEmphasis('a **bold** claim')).toBe('a bold claim');
    expect(stripMarkdownEmphasis('a ~~struck~~ claim')).toBe('a struck claim');
    expect(stripMarkdownEmphasis('a `code` claim')).toBe('a code claim');
    expect(stripMarkdownEmphasis('see [the docs](https://example.com)')).toBe('see the docs');
  });

  it('drops HTML comments entirely', () => {
    expect(stripMarkdownEmphasis('keep<!-- drop me -->this').trim()).toBe('keep this');
  });

  it('turns an unbalanced marker into a space so words cannot fuse', () => {
    // `a*b` must not become `ab` — that invents a word the author never wrote.
    expect(stripMarkdownEmphasis('a*b')).toBe('a b');
    expect(stripMarkdownEmphasis('snake_case_name')).toBe('snake case name');
  });

  it('leaves plain text and its whitespace untouched', () => {
    const prose = 'Genre: acoustic pop.\nBPM: 96.\n  Warm and intimate.';
    expect(stripMarkdownEmphasis(prose)).toBe(prose);
  });

  it('coerces non-strings instead of throwing', () => {
    for (const input of [undefined, null, 0, false]) {
      expect(() => stripMarkdownEmphasis(input)).not.toThrow();
    }
    expect(stripMarkdownEmphasis(undefined)).toBe('');
    expect(stripMarkdownEmphasis(null)).toBe('');
    expect(stripMarkdownEmphasis(42)).toBe('42');
  });
});
