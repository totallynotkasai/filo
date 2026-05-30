import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultRegistry } from '../../main/services/vaultRegistry';
import {
  assertActiveVault,
  isActiveVault,
  NoActiveVaultError,
} from '../../main/utils/activeVaultCheck';

/**
 * Phase 3 (P0-15 / P0-16) regression guard: every vaultRoot-accepting IPC
 * handler now gates on `assertActiveVault`. The contract:
 *
 *   1. When no vault is open, every call throws `NoActiveVaultError`.
 *   2. When a vault is open, a mismatched path throws.
 *   3. When the path matches the active vault (with Windows case-folding),
 *      it passes silently.
 */
describe('activeVaultCheck', () => {
  beforeEach(() => {
    vaultRegistry.setCurrentVault(null);
  });

  afterEach(() => {
    vaultRegistry.setCurrentVault(null);
  });

  describe('isActiveVault', () => {
    it('returns false when no vault is open', () => {
      expect(isActiveVault('/vault')).toBe(false);
    });

    it('returns true for the exact active vault path', () => {
      vaultRegistry.setCurrentVault('/vault');
      expect(isActiveVault('/vault')).toBe(true);
    });

    it('returns false for a different vault path', () => {
      vaultRegistry.setCurrentVault('/vault');
      expect(isActiveVault('/other-vault')).toBe(false);
    });

    it('normalises `.` and `..` segments', () => {
      vaultRegistry.setCurrentVault('/foo/bar');
      expect(isActiveVault('/foo/bar/./')).toBe(true);
      expect(isActiveVault('/foo/baz/../bar')).toBe(true);
    });

    it('returns false for empty / non-string inputs', () => {
      vaultRegistry.setCurrentVault('/vault');
      expect(isActiveVault('')).toBe(false);
      expect(isActiveVault(null as unknown as string)).toBe(false);
      expect(isActiveVault(undefined as unknown as string)).toBe(false);
    });

    it.runIf(process.platform === 'win32')(
      'is case-insensitive on Windows',
      () => {
        vaultRegistry.setCurrentVault('C:\\Vault');
        expect(isActiveVault('c:\\vault')).toBe(true);
        expect(isActiveVault('C:\\VAULT')).toBe(true);
      },
    );

    it.runIf(process.platform !== 'win32')(
      'is case-sensitive on POSIX',
      () => {
        vaultRegistry.setCurrentVault('/Vault');
        expect(isActiveVault('/vault')).toBe(false);
        expect(isActiveVault('/Vault')).toBe(true);
      },
    );
  });

  describe('assertActiveVault', () => {
    it('throws NoActiveVaultError when no vault is open', () => {
      expect(() => assertActiveVault('/vault')).toThrow(NoActiveVaultError);
      expect(() => assertActiveVault('/vault')).toThrow(
        /No vault is currently open/,
      );
    });

    it('throws when the path does not match the active vault', () => {
      vaultRegistry.setCurrentVault('/vault');
      expect(() => assertActiveVault('/other')).toThrow(NoActiveVaultError);
      expect(() => assertActiveVault('/other')).toThrow(
        /does not match the active vault/,
      );
    });

    it('passes for the exact active vault path', () => {
      vaultRegistry.setCurrentVault('/vault');
      expect(() => assertActiveVault('/vault')).not.toThrow();
    });

    it('rejects a path-traversal attempt that escapes the vault root', () => {
      vaultRegistry.setCurrentVault('/vault');
      // After resolution `/vault/../etc/passwd` becomes `/etc/passwd`,
      // which is not the active vault — assertActiveVault refuses.
      expect(() => assertActiveVault('/vault/../etc/passwd')).toThrow(
        NoActiveVaultError,
      );
    });

    it('rejects an empty string', () => {
      vaultRegistry.setCurrentVault('/vault');
      expect(() => assertActiveVault('')).toThrow(NoActiveVaultError);
    });
  });
});
