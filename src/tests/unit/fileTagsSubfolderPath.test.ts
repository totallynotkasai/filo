/**
 * Audit-12 H2 — the single-tag add/remove path must write a text tile's tag to
 * the note its `filePath` names, NOT a same-named note at the vault ROOT.
 *
 * The bug: on a cold-loaded subfolder Task row (not on the active board, no
 * loaded note), a root-fallback path resolution wrote the tag to a ROOT file,
 * corrupting an unrelated same-named root note or creating a ghost.
 *
 * This drives `fileTagsStore.addTagToTile` for a cold tile and asserts the
 * fire-and-forget `.md` frontmatter write lands in the subfolder, and that no
 * `.filo/tags.json` entry is made for the note (a note's tags live only in its
 * frontmatter).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { emptyTagsFile as newTagsFile } from '@renderer/lib/vault/tagsStorage';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { cancelAllPendingWrites, __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { TaskListBoard as TaskListBoardType } from '@renderer/schema/index';

function emptyTagsFile(): string {
  return JSON.stringify({ version: 1, tags: {}, fileTags: {} });
}

async function drainFireAndForget(): Promise<void> {
  // The note tag write is fire-and-forget — let the read + serialized write +
  // reconcile chain settle.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('Audit-12 H2 — fileTags tag write honors subfolders', () => {
  let mdWrites: string[];

  beforeEach(async () => {
    mdWrites = [];
    boardCacheStore.clear();
    boardStore.clearBoard();
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    fileTagsStore.reset();

    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return emptyTagsFile();
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: []\n---\nbody\n', mtimeMs: 1, size: 20 };
      }
      if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
        mdWrites.push(String(args[1]));
        return { success: true };
      }
      if (channel === 'vault:file-exists') return true;
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 20 };
      return { success: true };
    });
    vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);

    fileTagsStore.commitFromCandidate('/vault', newTagsFile());
  });

  afterEach(() => {
    cancelAllPendingWrites();
    vi.restoreAllMocks();
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    noteStore.__resetForTests();
    fileTagsStore.reset();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  function hydrateColdTextTile(filePath: string): void {
    boardCacheStore.hydrate(
      {
        k1: {
          version: 8,
          board: {
            id: 'k1',
            type: 'tasklist',
            name: 'T',
            emoji: '',
            createdAt: 0,
            updatedAt: 0,
            settings: {},
            sections: [],
            tasks: [{ tileId: 't1', position: 0 }],
          } as unknown as TaskListBoardType,
          tileDefs: {
            t1: {
              id: 't1',
              type: 'text',
              filePath,
              style: { headerColor: '', bodyColor: '', borderColor: '' },
              createdAt: 0,
              updatedAt: 0,
            },
          },
          connections: {},
          frames: [],
        },
      },
      { k1: 'T.board.json' },
    );
  }

  it('explicit subfolder filePath → resolves the tag write to that path', async () => {
    hydrateColdTextTile('Sub/B.md');
    // Cold: not on the active board, no loaded note.
    expect(boardStore.getTile('t1')).toBeUndefined();

    fileTagsStore.addTagToTile('t1', 'newtag');

    await drainFireAndForget();
    expect(mdWrites).toContain('Sub/B.md');
    expect(mdWrites).not.toContain('B.md');
    // The note's tags live in its frontmatter only.
    expect(fileTagsStore.file.fileTags['sub/b.md']).toBeUndefined();
    expect(fileTagsStore.file.fileTags['b.md']).toBeUndefined();
  });
});
