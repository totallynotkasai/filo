import { describe, it, expect } from 'vitest';
import {
  assertSafeFilename,
  assertSafeRelativePath,
  isPrivateUrl,
  MAX_VAULT_PATH_DEPTH,
} from '../../main/utils/pathSecurity';

/**
 * Phase 3 (P0-17) regression guard for the existing path-security helpers
 * that Phase 3 newly enforces at the IPC layer. `assertSafeFilename` and
 * `isPrivateUrl` were already exported but only sporadically called — the
 * tests below pin the traversal / SSRF payloads we now reject.
 */
describe('assertSafeFilename', () => {
  it('accepts a bare filename', () => {
    expect(() => assertSafeFilename('theme.json')).not.toThrow();
    expect(() => assertSafeFilename('My Theme.json')).not.toThrow();
  });

  it('rejects path separators (forward slash)', () => {
    expect(() => assertSafeFilename('foo/bar.json')).toThrow();
    expect(() => assertSafeFilename('a/b/c.json')).toThrow();
  });

  it('rejects path separators (backslash)', () => {
    expect(() => assertSafeFilename('foo\\bar.json')).toThrow();
  });

  it('rejects `..` traversal sequences', () => {
    expect(() => assertSafeFilename('..')).toThrow();
    expect(() => assertSafeFilename('../etc/passwd')).toThrow();
    expect(() => assertSafeFilename('..\\Windows\\System32')).toThrow();
  });

  it('rejects a leading slash', () => {
    expect(() => assertSafeFilename('/etc/passwd')).toThrow();
  });

  it('rejects a leading drive letter', () => {
    expect(() => assertSafeFilename('C:\\Windows\\System32\\cmd.exe')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => assertSafeFilename('')).toThrow(/empty/);
  });

  it('rejects Windows reserved names regardless of case or extension', () => {
    expect(() => assertSafeFilename('CON')).toThrow(/CON/);
    expect(() => assertSafeFilename('con')).toThrow(/CON/);
    expect(() => assertSafeFilename('CON.md')).toThrow(/CON/);
    expect(() => assertSafeFilename('con.txt')).toThrow(/CON/);
    expect(() => assertSafeFilename('PRN.json')).toThrow(/PRN/);
    expect(() => assertSafeFilename('AUX')).toThrow(/AUX/);
    expect(() => assertSafeFilename('NUL.md')).toThrow(/NUL/);
    expect(() => assertSafeFilename('COM1')).toThrow(/COM1/);
    expect(() => assertSafeFilename('COM9.txt')).toThrow(/COM9/);
    expect(() => assertSafeFilename('LPT1.tar.gz')).toThrow(/LPT1/);
    expect(() => assertSafeFilename('LPT9')).toThrow(/LPT9/);
  });

  it('accepts names that merely contain reserved substrings', () => {
    // The stem before the first `.` is what matters — `controller.md` ≠ CON.
    expect(() => assertSafeFilename('controller.md')).not.toThrow();
    expect(() => assertSafeFilename('aux-data.json')).not.toThrow();
    expect(() => assertSafeFilename('Console.md')).not.toThrow();
  });

  it('rejects trailing dot or trailing space', () => {
    expect(() => assertSafeFilename('foo.')).toThrow(/trailing/);
    expect(() => assertSafeFilename('foo ')).toThrow(/trailing/);
  });

  // Audit2 5.4 — `:` is the load-bearing entry: NTFS Alternate Data Streams.
  // A filename like `note.md:hidden` writes to a hidden stream inside the
  // vault that most tools never enumerate.
  it('rejects NTFS Alternate Data Stream filenames (colon)', () => {
    expect(() => assertSafeFilename('note.md:hidden')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('Notes:secret.txt')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename(':leading')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('trailing:')).toThrow(/Windows-illegal/);
  });

  it('rejects other Windows-illegal characters (<>"|?*)', () => {
    expect(() => assertSafeFilename('foo<bar.md')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo>bar.md')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo"bar.md')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo|bar.md')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo?bar.md')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo*bar.md')).toThrow(/Windows-illegal/);
  });

  it('rejects embedded control characters', () => {
    expect(() => assertSafeFilename('foo\x00bar')).toThrow(/control/);
    expect(() => assertSafeFilename('foo\x01bar')).toThrow(/control/);
    expect(() => assertSafeFilename('foo\x1fbar')).toThrow(/control/);
    expect(() => assertSafeFilename('foo\x7fbar')).toThrow(/control/);
    expect(() => assertSafeFilename('foo\nbar')).toThrow(/control/);
  });

  it('rejects names longer than 255 characters', () => {
    const long = 'a'.repeat(256);
    expect(() => assertSafeFilename(long)).toThrow(/255/);
    // Boundary: 255 is OK (POSIX NAME_MAX + Win MAX_PATH segment).
    expect(() => assertSafeFilename('a'.repeat(255))).not.toThrow();
  });
});

describe('assertSafeRelativePath', () => {
  it('accepts a bare filename', () => {
    expect(() => assertSafeRelativePath('Notes.md')).not.toThrow();
  });

  it('accepts a typical multi-segment vault path', () => {
    expect(() => assertSafeRelativePath('notes/2025/Plan.md')).not.toThrow();
    expect(() => assertSafeRelativePath('boards/sub/Plan.board.json')).not.toThrow();
  });

  it('accepts the dirty sentinel path', () => {
    expect(() => assertSafeRelativePath('.filo/.dirty')).not.toThrow();
  });

  // D.10 — `//` and `\\\\` runs are now defensively rejected. The
  // previous tolerant behaviour silently masked buggy path joins;
  // surfacing them as errors makes accidents loud instead of silent.
  it('rejects redundant forward-slash separators', () => {
    expect(() => assertSafeRelativePath('notes//Plan.md')).toThrow(/empty segment/);
  });

  it('rejects redundant backslash separators', () => {
    expect(() => assertSafeRelativePath('notes\\\\Plan.md')).toThrow(/empty segment/);
  });

  it('rejects mixed empty-segment between separators', () => {
    expect(() => assertSafeRelativePath('notes/\\Plan.md')).toThrow(/empty segment/);
  });

  it('rejects leading slash (treated as empty first segment)', () => {
    expect(() => assertSafeRelativePath('/Notes.md')).toThrow(/empty segment/);
  });

  it('rejects trailing slash (treated as empty trailing segment)', () => {
    expect(() => assertSafeRelativePath('notes/')).toThrow(/empty segment/);
  });

  it('rejects empty input', () => {
    expect(() => assertSafeRelativePath('')).toThrow();
  });

  it('rejects a path that only contains separators', () => {
    expect(() => assertSafeRelativePath('///')).toThrow();
  });

  it('rejects depths above MAX_VAULT_PATH_DEPTH', () => {
    const deep = Array.from({ length: MAX_VAULT_PATH_DEPTH + 1 }, (_, i) => `seg${i}`).join('/');
    expect(() => assertSafeRelativePath(deep)).toThrow(/depth limit/);
  });

  it('accepts a path at exactly MAX_VAULT_PATH_DEPTH', () => {
    const atLimit = Array.from({ length: MAX_VAULT_PATH_DEPTH }, (_, i) => `seg${i}`).join('/');
    expect(() => assertSafeRelativePath(atLimit)).not.toThrow();
  });

  it('rejects `..` segments', () => {
    expect(() => assertSafeRelativePath('foo/../bar.md')).toThrow();
    expect(() => assertSafeRelativePath('../etc/passwd')).toThrow();
  });

  it('rejects backslash traversal mixed with forward slashes', () => {
    expect(() => assertSafeRelativePath('notes\\..\\..\\evil.md')).toThrow();
  });
});

describe('isPrivateUrl', () => {
  it('flags localhost', () => {
    expect(isPrivateUrl('http://localhost')).toBe(true);
    expect(isPrivateUrl('http://localhost:8080/x')).toBe(true);
  });

  it('flags 127.0.0.0/8', () => {
    expect(isPrivateUrl('http://127.0.0.1')).toBe(true);
    expect(isPrivateUrl('http://127.255.255.255')).toBe(true);
  });

  it('flags RFC 1918 private ranges', () => {
    expect(isPrivateUrl('http://10.0.0.1')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.1')).toBe(true);
    expect(isPrivateUrl('http://172.16.0.1')).toBe(true);
    expect(isPrivateUrl('http://172.31.255.255')).toBe(true);
  });

  it('flags 169.254.0.0/16 link-local', () => {
    expect(isPrivateUrl('http://169.254.169.254')).toBe(true);
  });

  it('flags IPv6 loopback and ULA / link-local', () => {
    expect(isPrivateUrl('http://[::1]')).toBe(true);
    expect(isPrivateUrl('http://[fc00::1]')).toBe(true);
    expect(isPrivateUrl('http://[fe80::1]')).toBe(true);
  });

  it('does NOT flag public addresses', () => {
    expect(isPrivateUrl('https://example.com')).toBe(false);
    expect(isPrivateUrl('https://1.1.1.1')).toBe(false);
    expect(isPrivateUrl('https://8.8.8.8')).toBe(false);
  });

  it('rejects unparseable URLs as private (conservative default)', () => {
    expect(isPrivateUrl('not a url')).toBe(true);
    expect(isPrivateUrl('')).toBe(true);
  });
});
