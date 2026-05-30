import { describe, it, expect } from 'vitest';
import { isSafeIframeUrl } from '@renderer/lib/utils/urlSafety';

describe('isSafeIframeUrl', () => {
  it('accepts a plain https URL', () => {
    expect(isSafeIframeUrl('https://example.com')).toEqual({ ok: true });
  });

  it('accepts an http URL', () => {
    expect(isSafeIframeUrl('http://example.com/path?q=1')).toEqual({ ok: true });
  });

  it('rejects javascript: URLs', () => {
    const result = isSafeIframeUrl('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/javascript:/);
  });

  it('rejects javascript: with mixed case', () => {
    expect(isSafeIframeUrl('JavaScript:alert(1)').ok).toBe(false);
  });

  it('rejects data: URLs', () => {
    const result = isSafeIframeUrl('data:text/html,<script>alert(1)</script>');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/data:/);
  });

  it('rejects vbscript: URLs', () => {
    expect(isSafeIframeUrl('vbscript:msgbox("hi")').ok).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isSafeIframeUrl('file:///etc/passwd').ok).toBe(false);
  });

  it('rejects blob: URLs', () => {
    expect(isSafeIframeUrl('blob:https://example.com/abc').ok).toBe(false);
  });

  it('rejects malformed URLs', () => {
    const result = isSafeIframeUrl('not a url');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('Malformed URL');
  });

  it('rejects empty strings', () => {
    expect(isSafeIframeUrl('').ok).toBe(false);
    expect(isSafeIframeUrl('   ').ok).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeIframeUrl(null).ok).toBe(false);
    expect(isSafeIframeUrl(undefined).ok).toBe(false);
    expect(isSafeIframeUrl(123 as unknown).ok).toBe(false);
  });

  it('rejects exotic schemes that are not http(s)', () => {
    expect(isSafeIframeUrl('ftp://example.com').ok).toBe(false);
    expect(isSafeIframeUrl('mailto:user@example.com').ok).toBe(false);
    expect(isSafeIframeUrl('chrome://settings').ok).toBe(false);
  });

  it('trims whitespace before validating', () => {
    expect(isSafeIframeUrl('  https://example.com  ')).toEqual({ ok: true });
  });
});
