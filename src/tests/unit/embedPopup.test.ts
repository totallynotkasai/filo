import { describe, it, expect } from 'vitest';
import { embedPopupTarget, EMBED_POPUP_MIN_GAP_MS } from '../../main/utils/embedPopup';
import { isPrivateUrl } from '../../main/utils/pathSecurity';

/**
 * A link inside an iframe tile's page that asks for a new window opens in the
 * default browser: public https only, and not more than one a second.
 */
describe('embedPopupTarget', () => {
  const NOW = 1_000_000;

  it('passes a public https link on', () => {
    expect(embedPopupTarget('https://www.youtube.com/watch?v=abc', NOW, 0, isPrivateUrl)).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('drops every other scheme, a private address, credentials and junk', () => {
    for (const url of [
      'http://example.com/',
      'file:///C:/Windows/system32/calc.exe',
      'javascript:alert(1)',
      'data:text/html,hi',
      'mailto:a@b.c',
      'https://127.0.0.1/',
      'https://localhost/admin',
      'https://192.168.1.1/',
      'https://user:pass@example.com/',
      'not a url',
      '',
    ]) {
      expect(embedPopupTarget(url, NOW, 0, isPrivateUrl), url).toBeNull();
    }
  });

  it('drops a second link within a second of the first', () => {
    expect(embedPopupTarget('https://example.com/', NOW, NOW - 10, isPrivateUrl)).toBeNull();
  });

  it('a private host stays refused whatever its query or fragment holds', () => {
    expect(embedPopupTarget('https://192.168.1.1/setup?a=[::8.8.8.8]', NOW, 0, isPrivateUrl)).toBeNull();
    expect(embedPopupTarget('https://[fd12::1]/#[::ffff:8.8.8.8]', NOW, 0, isPrivateUrl)).toBeNull();
    expect(embedPopupTarget('https://example.com/', NOW, NOW - EMBED_POPUP_MIN_GAP_MS, isPrivateUrl)).toBe('https://example.com/');
  });
});
