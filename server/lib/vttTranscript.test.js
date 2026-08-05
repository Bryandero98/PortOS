import { describe, it, expect } from 'vitest';
import { cleanCaptionLine, vttToLines, vttToPlainText } from './vttTranscript.js';

describe('cleanCaptionLine', () => {
  it('strips inline karaoke timestamps and <c> spans', () => {
    expect(cleanCaptionLine('hello<00:00:00.500><c> there</c> world')).toBe('hello there world');
  });

  it('decodes the entities YouTube emits', () => {
    expect(cleanCaptionLine('R&amp;D &lt;tags&gt; &quot;quoted&quot; it&#39;s')).toBe('R&D <tags> "quoted" it\'s');
  });

  it('collapses runs of whitespace', () => {
    expect(cleanCaptionLine('  too    many   spaces  ')).toBe('too many spaces');
  });
});

describe('vttToLines', () => {
  it('drops the header, cue timings, and blank lines', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      '00:00:00.000 --> 00:00:02.000 align:start position:0%',
      'first line',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'second line',
      '',
    ].join('\n');
    expect(vttToLines(vtt)).toEqual(['first line', 'second line']);
  });

  it('handles SRT (numeric cue indices, comma decimals)', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'alpha',
      '',
      '2',
      '00:00:02,000 --> 00:00:04,000',
      'beta',
      '',
    ].join('\n');
    expect(vttToLines(srt)).toEqual(['alpha', 'beta']);
  });

  it('collapses the rolling repetition of auto-generated captions', () => {
    // The shape YouTube actually emits: each cue repeats the previous line and
    // appends the next fragment.
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'the quick brown',
      '',
      '00:00:02.000 --> 00:00:04.000',
      'the quick brown',
      'fox jumps over',
      '',
      '00:00:04.000 --> 00:00:06.000',
      'fox jumps over',
      'the lazy dog',
      '',
    ].join('\n');
    expect(vttToLines(vtt)).toEqual(['the quick brown', 'fox jumps over', 'the lazy dog']);
  });

  it('replaces a line that a later cue extends, keeping the longer phrasing once', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'we should',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'we should build a thing',
      '',
    ].join('\n');
    expect(vttToLines(vtt)).toEqual(['we should build a thing']);
  });

  it('keeps a genuine repeat that falls outside the dedupe window', () => {
    const vtt = [
      'WEBVTT',
      '',
      ...['no', 'a', 'b', 'c', 'd', 'e', 'no'].flatMap((text, i) => [
        `00:00:0${i}.000 --> 00:00:0${i + 1}.000`,
        text,
        '',
      ]),
    ].join('\n');
    const lines = vttToLines(vtt, { dedupeWindow: 4 });
    expect(lines.filter((l) => l === 'no')).toHaveLength(2);
  });

  it('returns an empty array for empty or non-string input', () => {
    expect(vttToLines('')).toEqual([]);
    expect(vttToLines(null)).toEqual([]);
    expect(vttToLines('WEBVTT\n\n')).toEqual([]);
  });
});

describe('vttToPlainText', () => {
  it('joins lines into paragraphs of paragraphEvery lines', () => {
    const cues = ['one', 'two', 'three', 'four'];
    const vtt = ['WEBVTT', '', ...cues.flatMap((t, i) => [`00:00:0${i}.000 --> 00:00:0${i + 1}.000`, t, ''])].join('\n');
    expect(vttToPlainText(vtt, { paragraphEvery: 2 })).toBe('one two\n\nthree four');
  });

  it('returns an empty string when nothing was extracted', () => {
    expect(vttToPlainText('WEBVTT\n')).toBe('');
  });
});
