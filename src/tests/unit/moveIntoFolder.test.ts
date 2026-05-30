import { describe, it, expect } from 'vitest';
import { computeMoveIntoFolderTarget } from '@renderer/lib/vault/moveIntoFolder';

describe('computeMoveIntoFolderTarget', () => {
  it('returns the composed destination path for a file → folder move (unix)', () => {
    expect(computeMoveIntoFolderTarget('/vault/Notes.md', '/vault/Sub')).toBe('/vault/Sub/Notes.md');
  });

  it('returns the composed destination path for a file → folder move (windows)', () => {
    expect(computeMoveIntoFolderTarget('C:\\vault\\Notes.md', 'C:\\vault\\Sub')).toBe(
      'C:\\vault\\Sub\\Notes.md',
    );
  });

  it('returns null when the file is already a direct child of the target folder', () => {
    expect(computeMoveIntoFolderTarget('/vault/Sub/Notes.md', '/vault/Sub')).toBeNull();
  });

  it('returns null when source and destination are identical', () => {
    expect(computeMoveIntoFolderTarget('/vault/Sub', '/vault/Sub')).toBeNull();
  });

  it('refuses moving a folder into one of its own descendants', () => {
    expect(computeMoveIntoFolderTarget('/vault/Sub', '/vault/Sub/Nested')).toBeNull();
    expect(computeMoveIntoFolderTarget('/vault/Sub', '/vault/Sub/Nested/Deep')).toBeNull();
  });

  it('moves a folder into a sibling folder', () => {
    expect(computeMoveIntoFolderTarget('/vault/A', '/vault/B')).toBe('/vault/B/A');
  });

  it('moves a deeply-nested file to the vault root', () => {
    expect(computeMoveIntoFolderTarget('/vault/Sub/Inner/Notes.md', '/vault')).toBe(
      '/vault/Notes.md',
    );
  });

  it('strips a trailing slash on the target folder', () => {
    expect(computeMoveIntoFolderTarget('/vault/Notes.md', '/vault/Sub/')).toBe('/vault/Sub/Notes.md');
  });

  it('returns null for empty inputs', () => {
    expect(computeMoveIntoFolderTarget('', '/vault/Sub')).toBeNull();
    expect(computeMoveIntoFolderTarget('/vault/Notes.md', '')).toBeNull();
  });
});
