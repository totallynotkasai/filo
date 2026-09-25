import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeTagChangeToMarkdownPath } from '@renderer/lib/tags/noteTagWriter';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * The single-tag write (a tag added to or removed from one note) and an open
 * view of the same note:
 *   - the open note takes the new frontmatter WITHOUT losing a body the user
 *     is still typing, and the next body save keeps the tag;
 *   - a body queued before the tag write lands first, and the tag lands on top
 *     of it (the two can't interleave or overwrite each other);
 *   - the tag write coming back through the watcher is recognised as ours, so
 *     the next edit raises no "modified externally" prompt;
 *   - a note deleted meanwhile is left deleted.
 */

const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

describe('single-tag write and an open note', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    __resetErrorBusForTests();
    vault = installMemoryVault({
      'Notes/A.md': '---\ntitle: A\n---\noriginal body\n',
    });
    for (const fn of Object.values(prompts)) fn.mockReset();
    setNotePromptHandlers(prompts);
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
  });

  it('takes the new frontmatter without touching a body the user is still typing', async () => {
    const m = noteStore.acquire('Notes/A.md', 'editor');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'unsaved local edits\n', 'editor');

    await writeTagChangeToMarkdownPath('Notes/A.md', 'foo', 'add');

    expect(m.body).toBe('unsaved local edits\n');
    expect(m.frontmatter).toEqual({ title: 'A', tags: ['foo'] });
    // The queued body landed first (inside the note's queue), then the tag.
    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\ntags:\n  - foo\n---\nunsaved local edits\n');
  });

  it("the editor's next body save keeps the tag", async () => {
    const m = noteStore.acquire('Notes/A.md', 'editor');
    await m.loaded;

    await writeTagChangeToMarkdownPath('Notes/A.md', 'foo', 'add');
    noteStore.setBody('Notes/A.md', 'edited body\n', 'editor');
    expect(await noteStore.flush('Notes/A.md')).toBe(true);

    const written = vault.read('Notes/A.md') ?? '';
    expect(written).toContain('- foo');
    expect(written).toContain('edited body');
    expect(prompts.conflict).not.toHaveBeenCalled();
  });

  it('the tag write coming back through the watcher is ours: no prompt, the next edit saves', async () => {
    const m = noteStore.acquire('Notes/A.md', 'editor');
    await m.loaded;

    await writeTagChangeToMarkdownPath('Notes/A.md', 'focus', 'add');
    const rev = m.bodyRevision;
    await noteStore.onDiskChanged('Notes/A.md');
    expect(m.bodyRevision).toBe(rev);

    noteStore.setBody('Notes/A.md', 'after the tag\n', 'editor');
    expect(await noteStore.flush('Notes/A.md')).toBe(true);
    expect(prompts.conflict).not.toHaveBeenCalled();
    expect(m.status).toBe('ready');
    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\ntags:\n  - focus\n---\nafter the tag\n');
  });

  it('removing a tag rewrites only the tags entry', async () => {
    vault.writeExternally('Notes/A.md', '---\ntitle: A # keep\ntags:\n  - foo\n  - bar\n---\nbody\n');
    await writeTagChangeToMarkdownPath('Notes/A.md', 'foo', 'remove');
    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A # keep\ntags:\n  - bar\n---\nbody\n');
  });

  it('a note deleted before the tag write is not recreated', async () => {
    vault.remove('Notes/A.md');
    await writeTagChangeToMarkdownPath('Notes/A.md', 'foo', 'add');
    expect(vault.read('Notes/A.md')).toBeUndefined();
    expect(vault.writes.filter(([, rel]) => rel.endsWith('.md'))).toEqual([]);
  });
});
