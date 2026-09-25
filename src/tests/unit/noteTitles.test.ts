/**
 * Note titles and filenames: the title is frontmatter `title:` (the filename
 * stem without one), a new note's filename is derived from its title, and
 * the board's formatted title shows only while it still spells the title.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileStemFromTitle, fileNameProblem } from '@shared/fileNames';
import { noteStem, noteTitle, titleFromFrontmatter } from '@renderer/stores/noteMeta';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { visibleTitleHtml } from '@renderer/lib/editor/titleCommit';

describe('fileStemFromTitle', () => {
  it.each([
    ['What? / Why', 'What- - Why'],
    ['a:b*c', 'a-b-c'],
    ['  spaced   out  ', 'spaced out'],
    ['Call Bob.', 'Call Bob'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['', 'Untitled'],
    ['...', 'Untitled'],
  ])('%j becomes %j', (title, stem) => {
    expect(fileStemFromTitle(title)).toBe(stem);
  });

  it('caps a very long title', () => {
    expect(fileStemFromTitle('x'.repeat(400)).length).toBe(200);
  });
});

describe('fileNameProblem', () => {
  it('accepts an ordinary name', () => {
    expect(fileNameProblem('Notes 2026.md')).toBeNull();
  });

  it.each([
    ['a/b', '"/"'],
    ['a:b', '":"'],
    ['what?', '"?"'],
    ['trailing.', 'dot or a space'],
    ['CON.md', 'reserved'],
    ['', 'required'],
  ])('refuses %j', (name, reason) => {
    expect(fileNameProblem(name)).toContain(reason);
  });
});

describe('noteTitle', () => {
  beforeEach(() => {
    vaultIndexStore.clear();
    noteStore.__resetForTests();
  });

  it('is the frontmatter title', () => {
    vaultIndexStore.restoreMetadata('Notes/a.md', parseMarkdown('Notes/a.md', '---\ntitle: Alpha\n---\n# Heading\n'));
    expect(noteTitle('Notes/a.md')).toBe('Alpha');
  });

  it('is the filename stem without a title, never the first heading', () => {
    vaultIndexStore.restoreMetadata('Notes/b.md', parseMarkdown('Notes/b.md', '# Heading\nText\n'));
    expect(noteTitle('Notes/b.md')).toBe('b');
    expect(noteTitle('Unindexed note.markdown')).toBe('Unindexed note');
  });

  it('shows a queued title change before it is written', () => {
    vaultIndexStore.restoreMetadata('Notes/a.md', parseMarkdown('Notes/a.md', '---\ntitle: Alpha\n---\n'));
    noteStore.patchFrontmatter('Notes/a.md', { set: { title: 'Beta' }, unset: [] });
    expect(noteTitle('notes/A.md')).toBe('Beta');
  });

  it('ignores an empty or non-string title', () => {
    expect(titleFromFrontmatter({ title: '   ' })).toBeNull();
    expect(titleFromFrontmatter({ title: 42 })).toBeNull();
    expect(noteStem('a/b/c.md')).toBe('c');
  });
});

describe('visibleTitleHtml', () => {
  it('shows the formatting while it spells the title', () => {
    expect(visibleTitleHtml('<p><strong>Plans</strong> for May</p>', 'Plans for May')).toBe('<p><strong>Plans</strong> for May</p>');
  });

  it('hides it once the title changed elsewhere', () => {
    expect(visibleTitleHtml('<p><strong>Plans</strong></p>', 'Plans (revised)')).toBeNull();
  });

  it('has nothing to show without formatting', () => {
    expect(visibleTitleHtml(undefined, 'Plans')).toBeNull();
    expect(visibleTitleHtml('  ', 'Plans')).toBeNull();
  });
});
