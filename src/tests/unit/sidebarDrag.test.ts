/**
 * The vault sidebar drag in progress: which items it carries, so a row can
 * tell it is under its own drag, and nothing once the drag has ended.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { endSidebarDrag, isCarriedPath, startSidebarDrag } from '@renderer/lib/vault/sidebarDrag';

afterEach(() => endSidebarDrag());

describe('sidebarDrag', () => {
  it('carries the paths its drag picked up, case-folded as the vault compares paths', () => {
    startSidebarDrag(['C:/Vault/Chapters', 'C:/Vault/Top.md']);
    expect(isCarriedPath('C:/Vault/Chapters')).toBe(true);
    expect(isCarriedPath('c:/vault/top.md')).toBe(true);
    expect(isCarriedPath('C:/Vault/Chapters/Inner.md')).toBe(false);
    expect(isCarriedPath(undefined)).toBe(false);
  });

  it('carries nothing once the drag ends, or before one starts', () => {
    expect(isCarriedPath('C:/Vault/Top.md')).toBe(false);
    startSidebarDrag(['C:/Vault/Top.md']);
    endSidebarDrag();
    expect(isCarriedPath('C:/Vault/Top.md')).toBe(false);
  });

  it('a new drag replaces the last one', () => {
    startSidebarDrag(['C:/Vault/Top.md']);
    startSidebarDrag(['C:/Vault/Other.md']);
    expect(isCarriedPath('C:/Vault/Top.md')).toBe(false);
    expect(isCarriedPath('C:/Vault/Other.md')).toBe(true);
  });
});
