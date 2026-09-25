/**
 * A card field edit made while no view holds the note, undone after the user
 * opened the note in an editor: the undo must show in the open editor and
 * reach disk, and the editor's next body save must not bring the undone value
 * back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/kanbanCommands';
import { historyStore } from '@renderer/stores/history.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

beforeEach(() => {
  __resetDirtyTrackingForTests();
  vaultStore.setPath('/vault');
  vaultIndexStore.clear();
  boardCacheStore.clear();
  historyStore.clear();
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  vaultIndexStore.clear();
  __resetDirtyTrackingForTests();
  vaultStore.setPath('');
  restoreFiloDefault();
});

describe('UpdateCardFieldCommand — editor opened between execute and undo', () => {
  it('the undo shows in the open editor and its next save does not revert it', async () => {
    const REL = 'Tasks/card.md';
    const vault = installMemoryVault({ [REL]: '---\ntitle: Card\n---\nBody' });
    vaultIndexStore.restoreMetadata(REL, parseMarkdown(REL, vault.read(REL) ?? ''));

    // The patch adds a due date; the inverse removes it (empty value = delete key).
    const cmd = new UpdateCardFieldCommand('kb', REL, { due: '2026-06-01' }, { due: '' });

    // 1) Execute while no view holds the card's note.
    await cmd.execute();
    await noteStore.flushAll();
    expect(vault.read(REL)).toContain('2026-06-01');

    // 2) The user opens the card's note as a Document.
    const m = noteStore.acquire(REL, 'document-editor');
    await m.loaded;
    expect(m.frontmatter.due).toBe('2026-06-01');

    // 3) Undo.
    await cmd.undo();
    expect(m.frontmatter.due).toBeUndefined();
    await noteStore.flushAll();
    expect(vault.read(REL)).not.toContain('2026-06-01');

    // 4) The editor saves a body edit: the due date stays gone.
    noteStore.setBody(REL, 'Body edited', 'document-editor');
    await noteStore.flushAll();
    expect(vault.read(REL)).toBe('---\ntitle: Card\n---\nBody edited\n');
  });
});
