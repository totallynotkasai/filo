import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emptyTagsFile, getTagDefinition, addTagToFile, setFileTags } from '@renderer/lib/vault/tagsStorage';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A tag another program (or an AI agent) writes into a note's `tags:` has no
 * `.filo/tags.json` entry until Filo registers it. It must show the same
 * colour before and after, whichever path registers it.
 */

beforeEach(() => {
  installFiloMock((channel: string) => (channel === 'tags:load' ? null : { success: true }));
  vaultStore.setPath('/vault');
  fileTagsStore.reset();
});
afterEach(() => {
  restoreFiloDefault();
  vaultStore.setPath('');
  fileTagsStore.reset();
});

describe('a tag keeps its colour when Filo registers it', () => {
  const shownBefore = (): string => getTagDefinition(emptyTagsFile(), 'draft').color;

  it('added to a file', () => {
    expect(getTagDefinition(addTagToFile(emptyTagsFile(), 'a.md', 'draft'), 'draft').color).toBe(shownBefore());
  });

  it("read from a note's frontmatter", () => {
    expect(getTagDefinition(setFileTags(emptyTagsFile(), 'a.md', ['draft']), 'draft').color).toBe(shownBefore());
  });

  it('added from the tag row, a tile or quick add', () => {
    const before = fileTagsStore.getDefinition('draft').color;
    expect(before).toBe(shownBefore());
    fileTagsStore.ensureTag('draft');
    expect(fileTagsStore.getDefinition('draft').color).toBe(before);
  });
});
