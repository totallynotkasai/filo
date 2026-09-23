/**
 * Audit-19 EXT-4 — the "file missing" toast for a `.md` referenced by tiles
 * with no open editor. On a synced vault it fires for moves and
 * delete-then-recreate, and its old primary action ("Mark broken refs")
 * actually ran a VAULT-WIDE cascade removing every tile on every board — one
 * click on a sync blip deleted tiles. Now the default does nothing and removal
 * runs only behind a danger confirm that lists the boards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promptClosedBoardFileMissing } from '@renderer/stores/vaultExternalPrompts';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function boardWithNote(boardId: string, name: string, tileId: string): V7BoardFileData {
  return {
    board: {
      id: boardId, type: 'mindmap', name, emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: { [tileId]: { x: 0, y: 0, width: 100, height: 100, locked: false, faded: false } },
      inlineTiles: {}, waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tileId]: {
        id: tileId, type: 'text', title: 'Notes', boardId, filePath: 'Notes.md',
        position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, tags: [],
        createdAt: 0, updatedAt: 0, locked: false, faded: false,
      },
    },
    connections: {},
    frames: [],
  } as unknown as V7BoardFileData;
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('Audit-19 EXT-4 — missing-file toast never removes tiles on one click', () => {
  let cascade: ReturnType<typeof vi.spyOn>;
  let dropFile: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearToasts();
    uiStore.closeConfirm();
    boardCacheStore.hydrate(
      { a: boardWithNote('a', 'Alpha', 't1'), b: boardWithNote('b', 'Beta', 't2') },
      { a: 'Alpha.board.json', b: 'Beta.board.json' },
    );
    installFiloMock({ 'vault:file-exists': () => false });
    cascade = vi.spyOn(boardStore, 'cascadeDeleteByVaultPath').mockImplementation(() => {});
    dropFile = vi.spyOn(fileTagsStore, 'dropFile').mockImplementation(() => {});
  });
  afterEach(() => {
    cascade.mockRestore();
    dropFile.mockRestore();
    uiStore.closeConfirm();
    clearToasts();
    restoreFiloDefault();
  });

  function theToast() {
    const t = uiStore.toasts.find((x) => x.text.includes('Notes.md'));
    expect(t).toBeDefined();
    return t!;
  }

  it('the default action (index 0) performs no mutation (bite)', async () => {
    promptClosedBoardFileMissing('Notes.md', 2, '/vault');
    const toast = theToast();
    expect(toast.actions![0].label).toBe('Keep tiles (show as missing)');
    await toast.actions![0].handler();
    await settle();
    expect(cascade).not.toHaveBeenCalled();
    expect(dropFile).not.toHaveBeenCalled();
    expect(uiStore.confirmDialog).toBeNull();
  });

  it('the text names the real scope (tiles on K boards), not "closed boards"', () => {
    promptClosedBoardFileMissing('Notes.md', 2, '/vault');
    const toast = theToast();
    expect(toast.text).toMatch(/is missing from the vault/);
    expect(toast.text).toMatch(/2 tiles on 2 boards/);
    expect(toast.text).not.toMatch(/closed boards/);
    expect(toast.sticky).toBe(true);
    expect(toast.dedupeKey).toBe('missing:Notes.md');
  });

  it('"Remove…" → confirm lists the boards; confirming runs the cascade + tag drop', async () => {
    promptClosedBoardFileMissing('Notes.md', 2, '/vault');
    await theToast().actions![1].handler();
    const dialog = uiStore.confirmDialog!;
    expect(dialog.danger).toBe(true);
    expect(dialog.body).toContain('Alpha');
    expect(dialog.body).toContain('Beta');
    expect(cascade).not.toHaveBeenCalled();
    uiStore.closeConfirm();
    dialog.onConfirm(false);
    await settle();
    expect(cascade).toHaveBeenCalledWith('Notes.md', {}, '/vault');
    expect(dropFile).toHaveBeenCalledWith('Notes.md');
  });

  it('"Remove…" → Cancel runs nothing', async () => {
    promptClosedBoardFileMissing('Notes.md', 2, '/vault');
    await theToast().actions![1].handler();
    const dialog = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    dialog.onCancel?.();
    await settle();
    expect(cascade).not.toHaveBeenCalled();
  });

  it('confirming after the file reappeared (synced move / restore) skips the cascade', async () => {
    installFiloMock({ 'vault:file-exists': () => true });
    promptClosedBoardFileMissing('Notes.md', 2, '/vault');
    await theToast().actions![1].handler();
    const dialog = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    dialog.onConfirm(false);
    await settle();
    expect(cascade).not.toHaveBeenCalled();
  });
});
