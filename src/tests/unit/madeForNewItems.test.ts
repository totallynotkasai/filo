/**
 * A note Filo made for a new tile, card or task is "as made" only while its
 * frontmatter is what Filo wrote: a tag or field set since in another view
 * makes it the user's, so undoing the add keeps it.
 */
import { describe, it, expect } from 'vitest';
import { frontmatterAsMade, isNoteMadeForNewItem, newItemSeed, noteMadeForNewItem } from '@renderer/lib/notes/madeForNewItems';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';

describe('frontmatterAsMade', () => {
  it('is true for the frontmatter Filo wrote, in any key order, and false once anything is added or changed', () => {
    noteMadeForNewItem('Asmade/New Card.md', '---\ntitle: New Card\ncompleted: false\n---\n');
    expect(frontmatterAsMade('Asmade/New Card.md', { completed: false, title: 'New Card' })).toBe(true);
    expect(frontmatterAsMade('Asmade/New Card.md', { title: 'New Card', completed: false, tags: ['plot'] })).toBe(false);
    expect(frontmatterAsMade('Asmade/New Card.md', { title: 'Renamed', completed: false })).toBe(false);
    expect(frontmatterAsMade('Asmade/Other.md', {})).toBe(false);
  });

  it('follows the note through a rename', () => {
    noteMadeForNewItem('Work/New Tile.md', '---\ntitle: New Tile\n---\n');
    renameAllPathKeys('Work', 'Story');
    expect(isNoteMadeForNewItem('Story/New Tile.md')).toBe(true);
    expect(newItemSeed('Story/New Tile.md')).toBe('---\ntitle: New Tile\n---\n');
    expect(frontmatterAsMade('Story/New Tile.md', { title: 'New Tile' })).toBe(true);
  });
});
