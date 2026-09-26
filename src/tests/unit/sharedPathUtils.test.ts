import { describe, it, expect } from 'vitest';
import { normalizePath, stripLeadingSlash, toPosix, toVaultRelative } from '@shared/pathUtils';
import * as rendererPath from '@renderer/lib/utils/path';

describe('shared path helpers', () => {
  it('toPosix only swaps separators', () => {
    expect(toPosix('C:\\Vault\\Notes\\A.md')).toBe('C:/Vault/Notes/A.md');
    expect(toPosix('/a/b/')).toBe('/a/b/');
    expect(toPosix('')).toBe('');
  });

  it('stripLeadingSlash removes every leading slash and nothing else', () => {
    expect(stripLeadingSlash('///Notes/A.md')).toBe('Notes/A.md');
    expect(stripLeadingSlash('Notes/')).toBe('Notes/');
  });

  it('normalizePath swaps separators and drops trailing slashes, keeping case', () => {
    expect(normalizePath('C:\\Vault\\')).toBe('C:/Vault');
    expect(normalizePath('/Vault//')).toBe('/Vault');
  });

  describe('toVaultRelative', () => {
    it('is null without a vault root or outside it', () => {
      expect(toVaultRelative('/vault/a.md', '')).toBeNull();
      expect(toVaultRelative('/elsewhere/a.md', '/vault')).toBeNull();
      expect(toVaultRelative('/vault-other/a.md', '/vault')).toBeNull();
    });

    it('maps the root itself to an empty string, trailing slashes ignored', () => {
      expect(toVaultRelative('/vault', '/vault')).toBe('');
      expect(toVaultRelative('/vault/', '/vault')).toBe('');
      expect(toVaultRelative('C:\\Vault', 'c:\\vault\\')).toBe('');
    });

    it('matches the root case-insensitively but keeps the path casing', () => {
      expect(toVaultRelative('C:\\Vault\\Notes\\A.md', 'c:\\vault')).toBe('Notes/A.md');
      expect(toVaultRelative('/Users/Me/Vault/Sub/B.md', '/users/me/vault')).toBe('Sub/B.md');
    });

    it('handles mixed separators and a trailing slash on a folder', () => {
      expect(toVaultRelative('C:/Vault\\Folder\\', 'C:\\Vault')).toBe('Folder');
    });

    it('works for a drive-root or filesystem-root vault', () => {
      expect(toVaultRelative('D:\\Notes\\A.md', 'D:\\')).toBe('Notes/A.md');
      expect(toVaultRelative('/A.md', '/')).toBe('A.md');
    });

    it('does not resolve dot segments (string-only)', () => {
      expect(toVaultRelative('/vault/a/../b.md', '/vault')).toBe('a/../b.md');
    });
  });

  it('the renderer path module re-exports the same functions', () => {
    expect(rendererPath.toPosix).toBe(toPosix);
    expect(rendererPath.stripLeadingSlash).toBe(stripLeadingSlash);
    expect(rendererPath.normalizePath).toBe(normalizePath);
    expect(rendererPath.toVaultRelative).toBe(toVaultRelative);
  });
});
