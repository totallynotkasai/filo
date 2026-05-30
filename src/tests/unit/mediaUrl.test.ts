import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toMediaUrl } from '@renderer/lib/utils/mediaUrl';

describe('toMediaUrl', () => {
  it('returns empty string for nullish / empty input', () => {
    expect(toMediaUrl(undefined)).toBe('');
    expect(toMediaUrl(null)).toBe('');
    expect(toMediaUrl('')).toBe('');
  });

  it('passes http and https URLs through unchanged', () => {
    expect(toMediaUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
    expect(toMediaUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('passes data: URLs through unchanged', () => {
    const d = 'data:image/png;base64,iVBORw0KGgo=';
    expect(toMediaUrl(d)).toBe(d);
  });

  it('passes blob: URLs through unchanged', () => {
    const b = 'blob:http://localhost/abc-123';
    expect(toMediaUrl(b)).toBe(b);
  });

  it('passes filo:// URLs through unchanged (no double-wrap)', () => {
    const f = 'filo://media/Notes/cover.png';
    expect(toMediaUrl(f)).toBe(f);
  });

  it('wraps a plain vault-relative path in filo://media/', () => {
    expect(toMediaUrl('cover.png')).toBe('filo://media/cover.png');
  });

  it('URL-encodes each path segment so spaces survive', () => {
    expect(toMediaUrl('Cover 13.png')).toBe('filo://media/Cover%2013.png');
  });

  it('URL-encodes reserved characters per segment but keeps slashes', () => {
    expect(toMediaUrl('subfolder/file with # hash.png')).toBe(
      'filo://media/subfolder/file%20with%20%23%20hash.png',
    );
  });

  it('normalises backslashes to forward slashes', () => {
    expect(toMediaUrl('subfolder\\notes\\cover.png')).toBe(
      'filo://media/subfolder/notes/cover.png',
    );
  });

  it('strips a leading slash', () => {
    expect(toMediaUrl('/Cover.png')).toBe('filo://media/Cover.png');
  });
});

describe('toMediaUrl — absolute path / file:// rescue', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('converts an absolute Windows path inside the vault to filo://', () => {
    const vault = 'C:\\Users\\me\\My Vault';
    const src = 'C:\\Users\\me\\My Vault\\Cover 13.png';
    expect(toMediaUrl(src, vault)).toBe('filo://media/Cover%2013.png');
  });

  it('converts an absolute path with case-mismatched drive letter', () => {
    // Windows is case-preserving but not case-sensitive; the vault root and
    // the file path can disagree on case. The helper underneath does a
    // case-insensitive prefix-strip.
    const vault = 'C:\\Users\\me\\My Vault';
    const src = 'c:/Users/me/My Vault/sub/photo.png';
    expect(toMediaUrl(src, vault)).toBe('filo://media/sub/photo.png');
  });

  it('converts a file:/// URL that lies inside the vault', () => {
    const vault = 'C:\\Users\\me\\My Vault';
    const src = 'file:///C:/Users/me/My%20Vault/Cover%2013.png';
    expect(toMediaUrl(src, vault)).toBe('filo://media/Cover%2013.png');
  });

  it('refuses an absolute path outside the vault and warns', () => {
    const vault = 'C:\\Users\\me\\My Vault';
    const src = 'C:\\Windows\\System32\\evil.exe';
    expect(toMediaUrl(src, vault)).toBe('');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('refuses an absolute path with no vault root and warns', () => {
    expect(toMediaUrl('C:\\Users\\me\\My Vault\\Cover.png')).toBe('');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('refuses a Windows-drive path with empty-string vault root', () => {
    expect(toMediaUrl('C:\\absolute\\path.png', '')).toBe('');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('preserves the legacy "strip leading slash" behaviour for non-Windows paths', () => {
    // A bare POSIX-style leading slash on a vault-relative path is treated
    // as a normalisation artefact, NOT as an absolute path. This matches
    // pre-existing callers that wrote `/Cover.png` into tile.src.
    expect(toMediaUrl('/Cover.png')).toBe('filo://media/Cover.png');
    expect(toMediaUrl('/sub/photo.png')).toBe('filo://media/sub/photo.png');
  });

  it('rescues a POSIX file:// URL that lies inside the vault', () => {
    const vault = '/home/me/vault';
    const src = 'file:///home/me/vault/sub/photo.png';
    expect(toMediaUrl(src, vault)).toBe('filo://media/sub/photo.png');
  });
});
