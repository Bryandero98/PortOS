import { describe, it, expect } from 'vitest';
import { parseBareUrl } from './bareUrl.js';

describe('parseBareUrl', () => {
  it('returns an explicit http(s) URL unchanged', () => {
    expect(parseBareUrl('https://example.com/parks')).toBe('https://example.com/parks');
    expect(parseBareUrl('http://example.com')).toBe('http://example.com');
  });

  it('trims surrounding whitespace and newlines (pasted URLs carry them)', () => {
    expect(parseBareUrl('  https://example.com  ')).toBe('https://example.com');
    expect(parseBareUrl('https://example.com\n')).toBe('https://example.com');
  });

  it('prepends https:// to a bare host', () => {
    expect(parseBareUrl('example.com')).toBe('https://example.com');
    expect(parseBareUrl('sub.example.co.uk/path?q=1')).toBe('https://sub.example.co.uk/path?q=1');
    expect(parseBareUrl('example.com:8080/x')).toBe('https://example.com:8080/x');
  });

  it('accepts an ssh git remote as-is', () => {
    expect(parseBareUrl('git@github.com:owner/repo.git')).toBe('git@github.com:owner/repo.git');
  });

  it('rejects free text', () => {
    expect(parseBareUrl('call mom about the trip')).toBeNull();
    expect(parseBareUrl('idea')).toBeNull();
  });

  it('rejects a URL wrapped in prose — that is a thought that mentions a link', () => {
    expect(parseBareUrl('read this https://example.com')).toBeNull();
    expect(parseBareUrl('https://example.com and https://example.org')).toBeNull();
    expect(parseBareUrl('https://example.com — great post')).toBeNull();
  });

  it('rejects dotted tokens that are not hosts', () => {
    expect(parseBareUrl('v1.2')).toBeNull();
    expect(parseBareUrl('e.g')).toBeNull();
  });

  it('rejects a bare filename whose extension doubles as a ccTLD', () => {
    expect(parseBareUrl('notes.md')).toBeNull();
    expect(parseBareUrl('deploy.sh')).toBeNull();
    expect(parseBareUrl('train.py')).toBeNull();
  });

  it('still accepts those TLDs with a scheme or a path', () => {
    expect(parseBareUrl('https://example.md')).toBe('https://example.md');
    expect(parseBareUrl('example.md/page')).toBe('https://example.md/page');
  });

  it('rejects non-http schemes so a capture cannot file a javascript:/file: payload', () => {
    expect(parseBareUrl('javascript:alert(1)')).toBeNull();
    expect(parseBareUrl('data:text/html,<script>')).toBeNull();
    expect(parseBareUrl('file:///etc/passwd')).toBeNull();
    expect(parseBareUrl('ftp://example.com/x')).toBeNull();
  });

  it('rejects empty and non-string input', () => {
    expect(parseBareUrl('')).toBeNull();
    expect(parseBareUrl('   ')).toBeNull();
    expect(parseBareUrl(null)).toBeNull();
    expect(parseBareUrl(undefined)).toBeNull();
  });
});
