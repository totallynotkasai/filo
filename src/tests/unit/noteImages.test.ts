import { describe, it, expect } from 'vitest';
import { noteImagePath, noteImageUrl } from '../../renderer/lib/editor/noteImages';

describe('noteImagePath (the vault file an image address in a note names)', () => {
  it('resolves an address from the note\'s folder', () => {
    expect(noteImagePath('images/map.png', 'Notes/Chapter.md')).toBe('Notes/images/map.png');
    expect(noteImagePath('./map.png', 'Notes/Chapter.md')).toBe('Notes/map.png');
    expect(noteImagePath('map.png', 'Chapter.md')).toBe('map.png');
  });

  it('climbs out of the note\'s folder with ..', () => {
    expect(noteImagePath('../Art/map.png', 'Notes/Chapter.md')).toBe('Art/map.png');
  });

  it('reads an address starting with / from the vault\'s top', () => {
    expect(noteImagePath('/Art/map.png', 'Notes/Chapter.md')).toBe('Art/map.png');
  });

  it('decodes an escaped address, and drops a query or fragment', () => {
    expect(noteImagePath('images/World%20Map.png', 'Notes/A.md')).toBe('Notes/images/World Map.png');
    expect(noteImagePath('map.png?raw=1#top', 'A.md')).toBe('map.png');
    expect(noteImagePath('images\\map.png', 'Notes\\A.md')).toBe('Notes/images/map.png');
  });

  it('keeps a bad escape as written', () => {
    expect(noteImagePath('100%.png', 'A.md')).toBe('100%.png');
  });

  it('names no vault file for a web or data address, or one above the vault\'s top', () => {
    expect(noteImagePath('https://example.com/a.png', 'A.md')).toBeNull();
    expect(noteImagePath('//cdn.example.com/a.png', 'A.md')).toBeNull();
    expect(noteImagePath('data:image/png;base64,AAAA', 'A.md')).toBeNull();
    expect(noteImagePath('filo://media/a.png', 'A.md')).toBeNull();
    expect(noteImagePath('../../outside.png', 'Notes/A.md')).toBeNull();
    expect(noteImagePath('', 'A.md')).toBeNull();
  });
});

describe('noteImageUrl (what the page loads)', () => {
  it('loads a vault file through the media protocol, each segment escaped', () => {
    expect(noteImageUrl('images/World Map.png', 'Notes/A.md')).toBe('filo://media/Notes/images/World%20Map.png');
    expect(noteImageUrl('images/World%20Map.png', 'Notes/A.md')).toBe('filo://media/Notes/images/World%20Map.png');
    expect(noteImageUrl('a b/c#d.png', 'A.md')).toBe('filo://media/a%20b/c');
  });

  it('leaves any other address as written', () => {
    expect(noteImageUrl('https://example.com/a.png', 'A.md')).toBe('https://example.com/a.png');
    expect(noteImageUrl('filo://media/a.png', 'A.md')).toBe('filo://media/a.png');
    expect(noteImageUrl('', 'A.md')).toBe('');
    expect(noteImageUrl(null, 'A.md')).toBe('');
  });
});
