import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
 *
 * 6.3.P1 / 6.3.P2 — the Windows-only rules (illegal chars `<>:"|?*`, reserved
 * DOS names) are platform-gated by default; callers pass
 * `{ forCreation: true }` at creation channels to enforce on every platform.
 * The "creation rule" tests below pass `{ forCreation: true }` so they pin
 * the cross-platform-portability invariant regardless of which OS CI runs
 * on. Separate tests below mock `process.platform = 'darwin'` to pin the
 * POSIX-read invariant (legitimately-named files like `2025:01:15.md` must
 * be accessible).
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

  it('rejects a leading drive letter (on Windows the drive-letter colon trips the Win-illegal-char gate; cross-platform creation always rejects)', () => {
    // The `\\` separators trip the path-separator gate, so this rejects on
    // every platform without depending on the Windows-illegal `:` rule.
    expect(() => assertSafeFilename('C:\\Windows\\System32\\cmd.exe')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => assertSafeFilename('')).toThrow(/empty/);
  });

  it('rejects Windows reserved names at creation regardless of case or extension', () => {
    // 6.3.P2 — pass forCreation:true so these reject on every CI platform.
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename('CON', c)).toThrow(/CON/);
    expect(() => assertSafeFilename('con', c)).toThrow(/CON/);
    expect(() => assertSafeFilename('CON.md', c)).toThrow(/CON/);
    expect(() => assertSafeFilename('con.txt', c)).toThrow(/CON/);
    expect(() => assertSafeFilename('PRN.json', c)).toThrow(/PRN/);
    expect(() => assertSafeFilename('AUX', c)).toThrow(/AUX/);
    expect(() => assertSafeFilename('NUL.md', c)).toThrow(/NUL/);
    expect(() => assertSafeFilename('COM1', c)).toThrow(/COM1/);
    expect(() => assertSafeFilename('COM9.txt', c)).toThrow(/COM9/);
    expect(() => assertSafeFilename('LPT1.tar.gz', c)).toThrow(/LPT1/);
    expect(() => assertSafeFilename('LPT9', c)).toThrow(/LPT9/);
  });

  it('accepts names that merely contain reserved substrings', () => {
    // The stem before the first `.` is what matters — `controller.md` ≠ CON.
    expect(() => assertSafeFilename('controller.md')).not.toThrow();
    expect(() => assertSafeFilename('aux-data.json')).not.toThrow();
    expect(() => assertSafeFilename('Console.md')).not.toThrow();
  });

  // Audit-8 L1 — the device-name set previously omitted CONIN$ / CONOUT$ /
  // CLOCK$. Each opens a device handle on Windows like CON/NUL do.
  it('rejects the CONIN$ / CONOUT$ / CLOCK$ device names at creation', () => {
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename('CONIN$', c)).toThrow(/CONIN\$/);
    expect(() => assertSafeFilename('conin$.md', c)).toThrow(/CONIN\$/);
    expect(() => assertSafeFilename('CONOUT$.txt', c)).toThrow(/CONOUT\$/);
    expect(() => assertSafeFilename('CLOCK$', c)).toThrow(/CLOCK\$/);
    expect(() => assertSafeFilename('clock$.log', c)).toThrow(/CLOCK\$/);
  });

  it('accepts a `$` filename that is not a reserved device stem', () => {
    // `$` is a legal filename character — only the exact device stem rejects.
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename('money$.md', c)).not.toThrow();
    expect(() => assertSafeFilename('CONINNER$.md', c)).not.toThrow();
  });

  // Audit-8 L1 — Windows trims leading/trailing spaces off the name component,
  // so ` CON.md` / `CON .md` still resolve to the CON device. The stem trim
  // before the reserved-name compare catches them.
  it('rejects a space-padded reserved device name at creation', () => {
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename(' CON.md', c)).toThrow(/CON/);
    expect(() => assertSafeFilename('CON .md', c)).toThrow(/CON/);
    expect(() => assertSafeFilename(' NUL ', c)).toThrow(/trailing/); // trailing-space gate fires first
  });

  it('rejects trailing dot or trailing space', () => {
    expect(() => assertSafeFilename('foo.')).toThrow(/trailing/);
    expect(() => assertSafeFilename('foo ')).toThrow(/trailing/);
  });

  // Audit2 5.4 / 6.3.P1 — `:` is the load-bearing entry: NTFS Alternate
  // Data Streams. A filename like `note.md:hidden` writes to a hidden
  // stream inside the vault on Windows. Creation channels (forCreation:
  // true) reject these on every platform so a cross-platform vault stays
  // portable.
  it('rejects NTFS Alternate Data Stream filenames (colon) at creation', () => {
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename('note.md:hidden', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('Notes:secret.txt', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename(':leading', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('trailing:', c)).toThrow(/Windows-illegal/);
  });

  it('rejects other Windows-illegal characters (<>"|?*) at creation', () => {
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename('foo<bar.md', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo>bar.md', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo"bar.md', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo|bar.md', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo?bar.md', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('foo*bar.md', c)).toThrow(/Windows-illegal/);
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

/**
 * 6.3.P1 / 6.3.P2 — the bug fix. Audit2 5.4 / 5.5 enforced Windows-only
 * rules platform-blind, which made any POSIX vault containing a file named
 * `2025:01:15 meeting.md` (Obsidian daily-notes default) unreadable through
 * Filo — every read/delete/rename IPC threw before reaching `fs.readFile`.
 * The default behaviour now gates those checks to win32; creation channels
 * still get `forCreation: true` to keep the cross-platform-portability
 * invariant.
 */
describe('assertSafeFilename — platform gating (6.3.P1 / 6.3.P2)', () => {
  let platformSpy: ReturnType<typeof vi.spyOn> | null = null;
  const setPlatform = (p: NodeJS.Platform): void => {
    platformSpy?.mockRestore();
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(p);
  };

  beforeEach(() => {
    platformSpy = null;
  });

  afterEach(() => {
    platformSpy?.mockRestore();
    platformSpy = null;
  });

  it('on POSIX, accepts files with `:` in the name (Obsidian daily notes)', () => {
    setPlatform('darwin');
    expect(() => assertSafeFilename('2025:01:15 meeting.md')).not.toThrow();
    expect(() => assertSafeFilename('note.md:hidden')).not.toThrow();
    setPlatform('linux');
    expect(() => assertSafeFilename('2025:01:15 meeting.md')).not.toThrow();
  });

  it('on POSIX, accepts files named with Windows DOS-device stems', () => {
    setPlatform('darwin');
    expect(() => assertSafeFilename('CON.md')).not.toThrow();
    expect(() => assertSafeFilename('NUL.txt')).not.toThrow();
    expect(() => assertSafeFilename('COM1.md')).not.toThrow();
  });

  it('on POSIX, accepts files with other Windows-illegal chars (<>"|?*)', () => {
    setPlatform('darwin');
    expect(() => assertSafeFilename('foo<bar.md')).not.toThrow();
    expect(() => assertSafeFilename('foo|bar.md')).not.toThrow();
    expect(() => assertSafeFilename('foo*bar.md')).not.toThrow();
  });

  it('on Windows, still rejects the same names (default platform gate)', () => {
    setPlatform('win32');
    expect(() => assertSafeFilename('2025:01:15 meeting.md')).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('CON.md')).toThrow(/CON/);
    expect(() => assertSafeFilename('foo<bar.md')).toThrow(/Windows-illegal/);
  });

  it('on POSIX, `forCreation: true` still rejects (cross-platform portability)', () => {
    setPlatform('darwin');
    const c = { forCreation: true } as const;
    expect(() => assertSafeFilename('2025:01:15 meeting.md', c)).toThrow(/Windows-illegal/);
    expect(() => assertSafeFilename('CON.md', c)).toThrow(/CON/);
    expect(() => assertSafeFilename('foo<bar.md', c)).toThrow(/Windows-illegal/);
  });

  it('platform-independent rules (control chars, length, separators) still apply on POSIX without forCreation', () => {
    setPlatform('darwin');
    expect(() => assertSafeFilename('foo\x00bar')).toThrow(/control/);
    expect(() => assertSafeFilename('a'.repeat(256))).toThrow(/255/);
    expect(() => assertSafeFilename('foo/bar.md')).toThrow();
    expect(() => assertSafeFilename('..')).toThrow();
    expect(() => assertSafeFilename('foo.')).toThrow(/trailing/);
  });

  it('assertSafeRelativePath threads the forCreation flag through every segment', () => {
    setPlatform('darwin');
    // POSIX, no forCreation: `2025:01:15.md` is a legitimate filename inside
    // a nested path — must not throw.
    expect(() => assertSafeRelativePath('notes/2025:01:15.md')).not.toThrow();
    // POSIX, forCreation: same path must reject so a Mac user can't seed
    // a vault that breaks Windows.
    expect(() => assertSafeRelativePath('notes/2025:01:15.md', { forCreation: true }))
      .toThrow(/Windows-illegal/);
    // POSIX, forCreation: a reserved-name segment anywhere rejects.
    expect(() => assertSafeRelativePath('notes/CON/page.md', { forCreation: true }))
      .toThrow(/CON/);
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
