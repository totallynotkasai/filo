import { describe, it, expect } from 'vitest';
import { isOpenable, normaliseLinkUrl } from '@renderer/lib/editor/linkUrl';

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
    'HTTPS://EXAMPLE.COM',
    'mailto:someone@example.com',
    'tel:+441234567890',
    'tel:01234567890',
    'filo://board/abc123def456',
    'filo://note/Notes.md',
  ])('leaves %s alone', (input) => {
    expect(normaliseLinkUrl(input)).toBe(input);
  });

  // A link the editor would accept but a click wouldn't open is saved dead.
  it.each(['ftp://files.example.com/a.zip', 'sms:+441234567890', 'javascript:alert(1)', 'data:text/html,x', 'file:///C:/x.txt'])(
    'refuses %s, which a click would not open',
    (input) => {
      expect(normaliseLinkUrl(input)).toBeNull();
    },
  );

  it.each(['', '   ', 'Notes.md', 'folder/Notes.markdown', 'just words', 'nodot', 'two words.com'])(
    'makes nothing openable of %j',
    (input) => {
      expect(normaliseLinkUrl(input)).toBeNull();
    },
  );

  it('everything it returns is openable', () => {
    for (const input of ['example.com', 'a@b.com', '//x.example', 'tel:1', 'filo://note/A.md', 'http://x.example']) {
      const href = normaliseLinkUrl(input);
      expect(href).not.toBeNull();
      expect(isOpenable(href ?? '')).toBe(true);
    }
  });
});

describe('isOpenable', () => {
  it.each(['https://example.com', 'http://example.com', 'mailto:a@b.com', 'tel:123', 'filo://note/A.md'])(
    'opens %s',
    (href) => {
      expect(isOpenable(href)).toBe(true);
    },
  );

  it.each(['ftp://example.com', 'sms:123', 'javascript:alert(1)', 'example.com', 'Notes.md', ''])(
    'does not open %j',
    (href) => {
      expect(isOpenable(href)).toBe(false);
    },
  );
});
