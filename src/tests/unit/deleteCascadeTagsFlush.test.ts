import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { emptyTagsFile as newTagsFile } from '@renderer/lib/vault/tagsStorage';
import { uiStore } from '@renderer/stores/ui.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * In-app delete must flush `.filo/tags.json` synchronously, mirroring the
 * rename cascade's tags flush.
 *
 * The file is an attachment: a note's tags live in its frontmatter, but an
 * attachment's live in `tags.json`.
 *
 * The folder-ops delete path drops the deleted file's tag membership via
 * `fileTagsStore.dropFile` / `dropFolder`, which only arm the 300ms misc
 * debounce. The cascade then synchronously awaits the board flush
 * (`flushAllDirty`). A crash in that window left a permanent orphan
 * `fileTags` entry in `tags.json` — the file is gone from disk but its tag
 * membership lingers until the next vault-open `pruneOrphanFileTags`.
 *
 * The fix drains the tag write (`fileTagsStore.flushPendingSave`) right
 * after the drop, before the cascade flush — the symmetric counterpart to
 * the rename path's existing flush. This suite asserts the dropped entry is
 * on disk by the time `vaultStore.delete` resolves, WITHOUT advancing any
 * debounce timer.
 */

/**
 * Drives the `uiStore.openConfirm`-based delete confirmation
 * by polling for the modal config and firing its `onConfirm`. Mirrors the
 * helper in `vaultFolderOpsDelete.test.ts`.
 */
async function autoConfirm(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (uiStore.confirmDialog) {
      const cfg = uiStore.confirmDialog;
      uiStore.closeConfirm();
      cfg.onConfirm(false);
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('delete cascade — synchronous tags.json flush', () => {
  let tagsSaves: string[];

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    fileTagsStore.reset();
    uiStore.closeConfirm();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    vaultStore.setPath('/vault');

    tagsSaves = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return null;
      if (channel === 'tags:save') {
        tagsSaves.push(String(args[1]));
        return undefined;
      }
      if (channel === 'vault:delete') return { success: true };
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });

    // Seed a tag on Notes/foo.png and drain the resulting write so the
    // delete's flush is the only tags:save we observe.
    fileTagsStore.commitFromCandidate('/vault', newTagsFile());
    fileTagsStore.setFileTags('Notes/foo.png', ['mytag']);
    await fileTagsStore.flushPendingSave();
    tagsSaves.length = 0;
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    tabStore.closeAll();
    fileTagsStore.reset();
    uiStore.closeConfirm();
    vaultStore.setPath('');
  });

  it('drops the deleted file from tags.json and persists it before delete resolves', async () => {
    const pending = vaultStore.delete('/vault/Notes/foo.png');
    await autoConfirm();
    const ok = await pending;
    expect(ok).toBe(true);

    // The dropped entry reached disk synchronously inside the cascade — not
    // left on the 300ms misc debounce a crash could straddle. (No timers
    // were advanced in this test.)
    expect(tagsSaves.length).toBeGreaterThanOrEqual(1);
    const latest = JSON.parse(tagsSaves[tagsSaves.length - 1]);
    // tags.json keys are canonicalised to lowercase (normalizeVaultRelative).
    expect(latest.fileTags['notes/foo.png']).toBeUndefined();
  });
});
