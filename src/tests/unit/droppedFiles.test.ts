import { describe, it, expect, afterEach } from 'vitest';
import {
  isInsideVault,
  classifyDroppedFile,
} from '@renderer/lib/vault/droppedFiles';
import { samePath, toVaultRelative } from '@renderer/lib/utils/path';

describe('isInsideVault', () => {
  it('returns true for a file directly inside the vault (unix)', () => {
    expect(isInsideVault('/vault/Notes.md', '/vault')).toBe(true);
  });

  it('returns true for a nested file inside the vault (unix)', () => {
    expect(isInsideVault('/vault/Sub/Inner/Notes.md', '/vault')).toBe(true);
  });

  it('returns true for a file directly inside the vault (windows)', () => {
    expect(isInsideVault('C:\\Vault\\Notes.md', 'C:\\Vault')).toBe(true);
  });

  it('is case-insensitive on the vault prefix', () => {
    expect(isInsideVault('C:\\VAULT\\Notes.md', 'c:\\vault')).toBe(true);
    expect(isInsideVault('/Vault/Sub/x.png', '/VAULT')).toBe(true);
  });

  it('returns false for a file outside the vault', () => {
    expect(isInsideVault('/Users/me/Downloads/x.md', '/vault')).toBe(false);
    expect(isInsideVault('/vaultish/x.md', '/vault')).toBe(false); // prefix-but-not-folder boundary
  });

  it('ignores trailing slashes on the vault path', () => {
    expect(isInsideVault('/vault/Notes.md', '/vault/')).toBe(true);
    expect(isInsideVault('/vault/Notes.md', '/vault//')).toBe(true);
  });

  it('returns false for empty inputs', () => {
    expect(isInsideVault('', '/vault')).toBe(false);
    expect(isInsideVault('/vault/x', '')).toBe(false);
  });

  it('treats the vault root itself as inside the vault', () => {
    expect(isInsideVault('/vault', '/vault')).toBe(true);
    expect(isInsideVault('/vault/', '/vault')).toBe(true);
  });
});

describe('toVaultRelative (the path a dropped file is linked by)', () => {
  it('returns the path relative to the vault, preserving original casing', () => {
    expect(toVaultRelative('/vault/Sub/Notes.md', '/vault')).toBe('Sub/Notes.md');
  });

  it('strips a windows-style vault prefix', () => {
    expect(toVaultRelative('C:\\Vault\\Sub\\Notes.md', 'C:\\Vault')).toBe('Sub/Notes.md');
  });

  it('preserves casing of the subpath even when vault prefix differs in case', () => {
    expect(toVaultRelative('/Vault/MyFolder/Notes.md', '/VAULT')).toBe(
      'MyFolder/Notes.md',
    );
  });

  it('returns an empty string when the path equals the vault', () => {
    expect(toVaultRelative('/vault', '/vault')).toBe('');
    expect(toVaultRelative('/vault/', '/vault')).toBe('');
  });

  it('returns null for paths outside the vault', () => {
    expect(toVaultRelative('/elsewhere/x.md', '/vault')).toBeNull();
    expect(toVaultRelative('/vaultish/x.md', '/vault')).toBeNull();
  });

  it('returns null for empty inputs', () => {
    expect(toVaultRelative('', '/vault')).toBeNull();
    expect(toVaultRelative('/vault/x', '')).toBeNull();
  });
});

describe('samePath', () => {
  it('returns true for identical vault-relative paths', () => {
    expect(samePath('Notes/Foo.md', 'Notes/Foo.md')).toBe(true);
  });

  it('treats forward and backslashes as equivalent', () => {
    expect(samePath('Notes\\Foo.md', 'Notes/Foo.md')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(samePath('NOTES/Foo.md', 'notes/foo.md')).toBe(true);
  });

  it('ignores a leading slash', () => {
    expect(samePath('/Notes/Foo.md', 'Notes/Foo.md')).toBe(true);
  });

  it('returns false for different files', () => {
    expect(samePath('Foo.md', 'Notes/Foo.md')).toBe(false);
    expect(samePath('Bar.md', 'Foo.md')).toBe(false);
  });

  it('returns false when either argument is null/undefined/empty', () => {
    expect(samePath('', 'Foo.md')).toBe(false);
    expect(samePath('Foo.md', '')).toBe(false);
    expect(samePath(null, 'Foo.md')).toBe(false);
    expect(samePath('Foo.md', undefined)).toBe(false);
  });
});

describe('classifyDroppedFile', () => {
  function dropped(path: string): File {
    const file = new File(['x'], path.split(/[\/]/).pop() ?? 'f');
    (window as unknown as { filo: unknown }).filo = { getPathForFile: (f: File) => (f === file ? path : '') };
    return file;
  }

  afterEach(() => {
    delete (window as unknown as { filo?: unknown }).filo;
  });

  it('a file inside the vault, in any case and either separator, is linked by its own-cased relative path', () => {
    const file = dropped('c:\\VAULT\\Notes\\Plan.md');
    expect(classifyDroppedFile(file, 'C:/Vault')).toEqual({ kind: 'in-vault', file, relPath: 'Notes/Plan.md' });
  });

  it('a file outside the vault is the only kind to copy', () => {
    const file = dropped('D:\\Downloads\\Plan.md');
    expect(classifyDroppedFile(file, 'C:\\Vault')).toEqual({ kind: 'outside', file, sourcePath: 'D:\\Downloads\\Plan.md' });
  });

  it('a sibling folder sharing the prefix is outside', () => {
    const file = dropped('C:\\Vault2\\Plan.md');
    expect(classifyDroppedFile(file, 'C:\\Vault')?.kind).toBe('outside');
  });

  // Filo neither shows nor saves inside these, and what they hold is pruned or
  // emptied without asking: a link there would be a tile whose edits are lost.
  it('a file in a hidden folder of the vault (.filo/recovery, .filo/trash, .stversions) is copied in, not linked', () => {
    for (const p of [
      'C:/Vault/.filo/recovery/2026-10-01T10-00-00.000-unsaved/Notes__Draft.md',
      'C:/Vault/.filo/trash/abc/files/Old.md',
      'C:/Vault/Book/.stversions/Chapter~20261001-100000.md',
    ]) {
      const file = dropped(p);
      expect(classifyDroppedFile(file, 'C:/Vault')).toEqual({ kind: 'outside', file, sourcePath: p });
    }
  });

  it('a file whose own name starts with a dot, in a shown folder, is still linked', () => {
    const file = dropped('C:/Vault/Notes/.draft.md');
    expect(classifyDroppedFile(file, 'C:/Vault')).toEqual({ kind: 'in-vault', file, relPath: 'Notes/.draft.md' });
  });

  it('no path for the file, or the vault folder itself, is neither', () => {
    expect(classifyDroppedFile(dropped(''), 'C:\\Vault')).toBeNull();
    expect(classifyDroppedFile(dropped('C:\\Vault\\'), 'C:\\Vault')).toBeNull();
  });
});
