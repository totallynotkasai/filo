import { describe, it, expect } from 'vitest';
import { normalizePath, pathsEqualExact } from '@renderer/lib/utils/path';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Vault\\Notes')).toBe('C:/Vault/Notes');
  });

  it('strips trailing slashes', () => {
    expect(normalizePath('/vault/notes/')).toBe('/vault/notes');
    expect(normalizePath('/vault/notes//')).toBe('/vault/notes');
  });

  it('strips a trailing backslash after separator normalisation', () => {
    expect(normalizePath('C:\\Vault\\Notes\\')).toBe('C:/Vault/Notes');
  });

  it('leaves already-normalised paths untouched', () => {
    expect(normalizePath('/vault/notes')).toBe('/vault/notes');
  });

  it('does not lowercase paths', () => {
    expect(normalizePath('C:\\Vault\\Notes')).toBe('C:/Vault/Notes');
    expect(normalizePath('C:\\Vault\\Notes')).not.toBe('c:/vault/notes');
  });
});

describe('pathsEqualExact', () => {
  it('returns true for identical paths', () => {
    expect(pathsEqualExact('/vault/notes', '/vault/notes')).toBe(true);
  });

  it('treats forward and backslashes as equivalent', () => {
    expect(pathsEqualExact('C:\\Vault\\Notes', 'C:/Vault/Notes')).toBe(true);
  });

  it('ignores trailing slashes', () => {
    expect(pathsEqualExact('/vault/notes/', '/vault/notes')).toBe(true);
    expect(pathsEqualExact('C:\\Vault\\Notes\\', 'C:\\Vault\\Notes')).toBe(true);
  });

  it('returns false for different paths', () => {
    expect(pathsEqualExact('/vault/notes', '/vault/other')).toBe(false);
  });

  it('is case-sensitive (caller decides casing rules)', () => {
    expect(pathsEqualExact('C:\\Vault', 'c:\\vault')).toBe(false);
  });

  it('handles empty inputs', () => {
    expect(pathsEqualExact('', '')).toBe(true);
    expect(pathsEqualExact('', '/vault')).toBe(false);
  });
});
