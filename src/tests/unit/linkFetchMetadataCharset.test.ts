import { describe, it, expect } from 'vitest';
import { detectCharsetFromContentType } from '../../main/ipc/media.ipc';

/**
 * Sprint 37 / 37.8 — `link:fetch-metadata` honours the charset parameter
 * on the Content-Type header. Tests the extractor in isolation so the
 * fallback behaviour and supported-encoding probe are covered without
 * needing to mock the full fetch pipeline.
 */
describe('detectCharsetFromContentType — Sprint 37 / 37.8', () => {
  it('returns utf-8 when the header is empty', () => {
    expect(detectCharsetFromContentType('')).toBe('utf-8');
  });

  it('returns utf-8 when no charset parameter is present', () => {
    expect(detectCharsetFromContentType('text/html')).toBe('utf-8');
    expect(detectCharsetFromContentType('application/xhtml+xml')).toBe('utf-8');
  });

  it('extracts a supported charset label', () => {
    expect(detectCharsetFromContentType('text/html; charset=shift_jis')).toBe('shift_jis');
    expect(detectCharsetFromContentType('text/html; charset=windows-1252')).toBe('windows-1252');
    expect(detectCharsetFromContentType('text/html; charset=gbk')).toBe('gbk');
  });

  it('accepts whitespace around the `=`', () => {
    expect(detectCharsetFromContentType('text/html; charset = shift_jis')).toBe('shift_jis');
  });

  it('strips surrounding quotes', () => {
    expect(detectCharsetFromContentType('text/html; charset="utf-8"')).toBe('utf-8');
    expect(detectCharsetFromContentType("text/html; charset='iso-8859-1'")).toBe('iso-8859-1');
  });

  it('lowercases the charset label', () => {
    expect(detectCharsetFromContentType('text/html; charset=Shift_JIS')).toBe('shift_jis');
    expect(detectCharsetFromContentType('text/html; charset=UTF-8')).toBe('utf-8');
  });

  it('falls back to utf-8 for unsupported charset labels', () => {
    // `TextDecoder` rejects fictional labels.
    expect(detectCharsetFromContentType('text/html; charset=not-a-real-encoding')).toBe('utf-8');
  });

  it('decodes Shift_JIS bytes correctly via the returned label', () => {
    // U+3053 U+3093 U+306B U+3061 U+306F → こんにちは in Shift_JIS:
    const shiftJisBytes = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    const charset = detectCharsetFromContentType('text/html; charset=shift_jis');
    expect(charset).toBe('shift_jis');
    const decoded = new TextDecoder(charset).decode(shiftJisBytes);
    expect(decoded).toBe('こんにちは');
  });

});
