import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import {
  vaultPathForTile,
  makeKanbanFrontmatterWriter,
} from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-10 B2 — the Kanban frontmatter writer's path resolver ignored the def's
 * explicit `filePath`. After a restart the document store is empty (boards don't
 * preload docs), so a subfolder card fell back to `${title}.md` at the vault
 * ROOT. `UpdateCardFieldCommand` then wrote there: ENOENT-lost the edit, or
 * silently corrupted an unrelated same-named root file. The fix delegates to the
 * canonical `resolveTextTileVaultPath`, which consults `filePath` FIRST.
 *
 * Reverting the delegation (back to the old `${title}.md` body) turns the
 * "resolves to the subfolder path" assertions red.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

/** Every vault-relative path written via the gateway (write-existing-file-text). */
function writePaths(captured: Captured[]): string[] {
  return captured
    .filter((c) => c.channel === 'vault:write-existing-file-text')
    .map((c) => c.args[1] as string);
}

describe('vaultPathForTile — honors the def filePath (Audit-10 B2)', () => {
  afterEach(() => {
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
  });

  it('returns the subfolder filePath for a card with NO document loaded (the repro)', () => {
    // Post-restart state: the document store is empty, only the def survives.
    const tile = {
      id: 't1',
      type: 'text',
      title: 'Card',
      filePath: 'Folder/Card.md',
      tags: [],
    } as unknown as Tile;
    // OLD body returned 'Card.md' (root); the canonical resolver returns the
    // explicit subfolder path.
    expect(vaultPathForTile(tile)).toBe('Folder/Card.md');
  });

  it('returns null for a non-text tile', () => {
    const tile = { id: 't2', type: 'image', title: 'Img', tags: [] } as unknown as Tile;
    expect(vaultPathForTile(tile)).toBeNull();
  });

  it('does not guess a path from an open document when no filePath is set', () => {
    documentStore.loadDocument({
      filename: 'Notes/Real.md',
      title: 'X',
      body: '',
      htmlContent: '',
      richText: [],
    });
    const tile = {
      id: 't3',
      type: 'text',
      title: 'X',
      tags: [],
    } as unknown as Tile;
    // A card's note is named only by its filePath; without one it has no note.
    expect(vaultPathForTile(tile)).toBeNull();
    documentStore.unloadDocument('Notes/Real.md');
  });

  it('does not guess ${title}.md at root when neither filePath nor a document exists', () => {
    const tile = { id: 't4', type: 'text', title: 'Loose', tags: [] } as unknown as Tile;
    expect(vaultPathForTile(tile)).toBeNull();
  });
});

describe('updateTileFrontmatter — writes to the subfolder path end-to-end (Audit-10 B2)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  /** Recorder whose `.md` on disk is fixed (mtime stable → no drift prompt). */
  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 5, size: content.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: content.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  }

  it('a subfolder card (no document loaded) writes to Folder/Card.md, NOT Card.md at root', async () => {
    const tile = {
      id: 't1',
      type: 'text',
      title: 'Card',
      filePath: 'Folder/Card.md',
      tags: [],
    } as unknown as Tile;
    installDisk('---\ncompleted: false\n---\ncard body\n');

    const writer = makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ [tile.id]: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
    await writer.updateTileFrontmatter(tile.id, { priority: 'high' });
    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(writePaths(captured), 'no markdown write captured').toContain('Folder/Card.md');
      },
      { timeout: 1000, interval: 20 },
    );

    // The edit landed at the subfolder path and NEVER at the wrong root path.
    expect(writePaths(captured)).toContain('Folder/Card.md');
    expect(writePaths(captured)).not.toContain('Card.md');
  });
});
