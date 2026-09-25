import { describe, it, expect } from 'vitest';
import { normaliseLinkUrl } from '@renderer/lib/editor/linkUrl';

describe('normaliseLinkUrl', () => {
  it.each([
    ['example.com', 'https://example.com'],
    ['www.example.com/page?q=1#top', 'https://www.example.com/page?q=1#top'],
    ['sub.example.co.uk', 'https://sub.example.co.uk'],
    ['localhost:3000', 'https://localhost:3000'],
    ['example.com:8080/x', 'https://example.com:8080/x'],
    ['192.168.1.10/admin', 'https://192.168.1.10/admin'],
    ['//cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
    ['someone@example.com', 'mailto:someone@example.com'],
    ['  example.com  ', 'https://example.com'],
  ])('adds a scheme to %s', (input, expected) => {
    expect(normaliseLinkUrl(input)).toBe(expected);
  });

  it.each([
    'https://example.com',
    'http://example.com',
    'mailto:someone@example.com',
    'tel:+441234567890',
    'tel:01234567890',
    'filo://board/abc123def456',
    'filo://note/Notes.md',
  ])('leaves %s alone', (input) => {
    expect(normaliseLinkUrl(input)).toBe(input);
  });

  it('passes a refused scheme through unchanged, for the editor to refuse', () => {
    expect(normaliseLinkUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it.each(['', '   ', 'Notes.md', 'folder/Notes.markdown', 'just words', 'nodot', 'two words.com'])(
    'makes nothing openable of %j',
    (input) => {
      expect(normaliseLinkUrl(input)).toBeNull();
    },
  );
});
