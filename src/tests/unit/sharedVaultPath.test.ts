import { describe, it, expect } from 'vitest';
import {
  normalizeVaultRelative,
  vaultPath,
  isVaultPath,
  type VaultPath,
} from '@shared/vaultPath';

/**
 * Branded `VaultPath` newtype + `vaultPath()` constructor.
 *
 * The brand prevents raw `string` from being used as a key in
 * `Map<VaultPath, _>` / `Record<VaultPath, _>` / `Set<VaultPath>` without
 * being routed through the normalising constructor. These tests exercise:
 *
 *  - normalisation rules (slash, case-fold, leading-slash strip)
 *  - constructor idempotency (vaultPath(vaultPath(x)) === vaultPath(x))
 *  - the `isVaultPath` type-guard
 *  - the empty-string sentinel (used widely as "no path yet")
 *  - the locale-pinned case-fold (Turkish dotted-i would otherwise split
 *    path identity across machines)
 */

describe('shared/vaultPath — `normalizeVaultRelative`', () => {
  it('lowercases via en-US locale', () => {
    expect(normalizeVaultRelative('Notes/Foo.md')).toBe('notes/foo.md');
    expect(normalizeVaultRelative('NOTES/FOO.MD')).toBe('notes/foo.md');
  });

  it('converts backslashes to forward slashes', () => {
    expect(normalizeVaultRelative('sub\\Notes.md')).toBe('sub/notes.md');
    expect(normalizeVaultRelative('a\\b\\c.md')).toBe('a/b/c.md');
  });

  it('strips one OR many leading slashes', () => {
    expect(normalizeVaultRelative('/Notes.md')).toBe('notes.md');
    expect(normalizeVaultRelative('//Notes.md')).toBe('notes.md');
    expect(normalizeVaultRelative('///Notes.md')).toBe('notes.md');
  });

  it('returns the empty string unchanged', () => {
    expect(normalizeVaultRelative('')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeVaultRelative('Notes/Foo.md');
    const twice = normalizeVaultRelative(once);
    expect(once).toBe(twice);
  });

  it('pins to en-US so Turkish locale dotted-i does not split path identity', () => {
    // In the Turkish locale, `'I'.toLowerCase()` produces `'ı'` (dotless),
    // not `'i'`. If `normalizeVaultRelative` used the host locale, two
    // machines on different locales would disagree on whether
    // `'Indices/X.md'` matches `'indices/x.md'`. Pinning to en-US keeps
    // path identity stable across machines.
    const turkishStyle = 'Indices/X.md'.toLocaleLowerCase('tr-TR');
    expect(turkishStyle).not.toBe('indices/x.md'); // sanity: tr-TR really would diverge
    expect(normalizeVaultRelative('Indices/X.md')).toBe('indices/x.md');
  });
});

describe('shared/vaultPath — `vaultPath()` constructor', () => {
  it('brands the result so it satisfies the `VaultPath` type', () => {
    const v: VaultPath = vaultPath('Notes/Foo.md');
    // The brand is structural — verify by usage in a typed map.
    const m = new Map<VaultPath, number>();
    m.set(v, 1);
    expect(m.get(v)).toBe(1);
  });

  it('returns the normalised form', () => {
    expect(vaultPath('Notes/Foo.md')).toBe('notes/foo.md');
    expect(vaultPath('\\sub\\Notes.md')).toBe('sub/notes.md');
    expect(vaultPath('/Notes.md')).toBe('notes.md');
  });

  it('is idempotent', () => {
    const a = vaultPath('Notes/Foo.md');
    const b = vaultPath(a);
    expect(a).toBe(b);
  });

  it('returns the empty string for empty input (sentinel for "no path yet")', () => {
    expect(vaultPath('')).toBe('');
  });
});

describe('shared/vaultPath — `isVaultPath` type-guard', () => {
  it('returns true for already-normalised strings', () => {
    expect(isVaultPath('notes/foo.md')).toBe(true);
    expect(isVaultPath('a/b/c.md')).toBe(true);
    expect(isVaultPath('')).toBe(true); // empty-string sentinel
  });

  it('returns false for un-normalised strings', () => {
    expect(isVaultPath('Notes/Foo.md')).toBe(false); // mixed case
    expect(isVaultPath('sub\\Notes.md')).toBe(false); // backslash
    expect(isVaultPath('/Notes.md')).toBe(false); // leading slash
  });

  it('returns false for non-strings', () => {
    expect(isVaultPath(undefined)).toBe(false);
    expect(isVaultPath(null)).toBe(false);
    expect(isVaultPath(42)).toBe(false);
    expect(isVaultPath({})).toBe(false);
  });
});

describe('shared/vaultPath — map-key parity', () => {
  it('two `vaultPath()` calls with different casings collide on the same key', () => {
    const m = new Map<VaultPath, number>();
    m.set(vaultPath('Notes/Foo.md'), 1);
    m.set(vaultPath('notes/foo.md'), 2);
    expect(m.size).toBe(1);
    expect(m.get(vaultPath('NOTES/FOO.MD'))).toBe(2);
  });

  it('rename Notes/Foo.md → notes/foo.md finds the prior entry', () => {
    const m = new Map<VaultPath, number>();
    m.set(vaultPath('Notes/Foo.md'), 1);
    // OS-emitted lowercase rename event — with a raw-`string` key the
    // map would keep the OLD entry forever under `'Notes/Foo.md'` and a
    // lookup against the new path would miss. With VaultPath:
    expect(m.has(vaultPath('notes/foo.md'))).toBe(true);
    m.delete(vaultPath('notes/foo.md'));
    expect(m.size).toBe(0);
  });

  it('handles separator + leading-slash mixing in the same map', () => {
    const s = new Set<VaultPath>();
    s.add(vaultPath('sub/Notes.md'));
    s.add(vaultPath('\\sub\\notes.md'));
    s.add(vaultPath('/sub/NOTES.MD'));
    expect(s.size).toBe(1);
  });
});
