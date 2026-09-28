import { describe, it, expect } from 'vitest';
import { isAtOrUnder } from '../../shared/vaultPath';

describe('isAtOrUnder', () => {
  it('matches the item itself and anything inside it, case-folded', () => {
    expect(isAtOrUnder('Notes', 'notes')).toBe(true);
    expect(isAtOrUnder('Notes/Sub/A.md', 'notes')).toBe(true);
    expect(isAtOrUnder('notes/a.md', 'Notes/A.md')).toBe(true);
  });

  it('treats backslashes, a leading slash and a trailing slash as the same path', () => {
    expect(isAtOrUnder('Notes\\Sub\\A.md', '/Notes/')).toBe(true);
  });

  it('needs a separator boundary: a sibling sharing the prefix is not inside', () => {
    expect(isAtOrUnder('Notes-old/A.md', 'Notes')).toBe(false);
    expect(isAtOrUnder('Notes.md', 'Notes')).toBe(false);
  });

  it('never matches an empty folder (the vault root is not a deletable item)', () => {
    expect(isAtOrUnder('A.md', '')).toBe(false);
    expect(isAtOrUnder('', '')).toBe(false);
  });

  it('a parent is not under its child', () => {
    expect(isAtOrUnder('Notes', 'Notes/Sub')).toBe(false);
  });
});
