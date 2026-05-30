import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __runRecoverySequencerForTests, vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 4.4 / 4.5 (2026-05-30) — rename-cascade recovery sentinel handlers.
 *
 * 4.4: the Retry handler repaired board JSON + tags.json but not the
 *      in-memory document filename pointer, unlike the normal rename path.
 *      A doc already open when an in-session retry fires kept writing to the
 *      OLD path.
 * 4.5: the Discard handler just cleared the breadcrumb — leaving any board
 *      whose flush had failed pointing at the old path with no repair.
 *
 * The sequencer is private; `__runRecoverySequencerForTests` drives it past
 * recovery steps 1 (.dirty) and 2 (tag-rewrite), which no-op here (their
 * sentinel reads return ENOENT), straight to step 3 (rename-cascade).
 */

const SENTINEL = '.filo/rename-cascade-pending.json';

function sentinelJson(oldPath: string, newPath: string): string {
  return JSON.stringify({
    entries: [
      { id: 'r1', timestamp: 1, oldPath, newPath, affectedBoardIds: [], tagsAffected: false },
    ],
  });
}

async function fireDialog(which: 'confirm' | 'cancel'): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (uiStore.confirmDialog) {
      const cfg = uiStore.confirmDialog;
      uiStore.closeConfirm();
      if (which === 'confirm') cfg.onConfirm(false);
      else cfg.onCancel?.();
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('recovery confirm dialog never appeared');
}

async function waitFor(pred: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

/** A board carrying a single file-ref tile def that propagateRename rewrites. */
function boardWithFileRef(boardId: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'file',
        title: 'F',
        filePath,
        tags: [],
        style: {},
        createdAt: 0,
        updatedAt: 0,
      } as never,
    },
    connections: {},
    frames: [],
  };
}

function resetAll(): void {
  __resetDirtyTrackingForTests();
  __resetRenameCascadeSentinelForTests();
  documentStore.clear();
  vaultIndexStore.clear();
  boardCacheStore.clear();
  boardStore.clearBoard();
  fileTagsStore.reset();
  uiStore.closeConfirm();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

describe('rename-cascade recovery — Retry repoints open documents (Phase 4.4)', () => {
  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const p = String(args[1]);
        if (p === SENTINEL) {
          return { success: true, content: sentinelJson('Notes/old.md', 'Notes/new.md') };
        }
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'tags:load') return null;
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  it('updates an open document filename from old to new on Retry', async () => {
    documentStore.loadDocument({
      docId: 'd',
      filename: 'Notes/old.md',
      title: 'old',
      body: '',
      htmlContent: '',
      richText: [],
    });

    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('confirm');
    await seq;
    await waitFor(() => documentStore.findByFilename('Notes/new.md') !== null);

    expect(documentStore.findByFilename('Notes/new.md')?.docId).toBe('d');
    expect(documentStore.findByFilename('Notes/old.md')).toBeNull();
  });

  // Phase 4.5 — "Discard" now repairs too (the renamed file is already on
  // disk; abandoning the cascade would strand boards with broken refs).
  it('repairs board refs + open documents and confirms on Discard', async () => {
    boardCacheStore.hydrate({ b1: boardWithFileRef('b1', 'Notes/old.md') }, { b1: 'b1.board.json' });
    documentStore.loadDocument({
      docId: 'd',
      filename: 'Notes/old.md',
      title: 'old',
      body: '',
      htmlContent: '',
      richText: [],
    });

    const toastsBefore = uiStore.toasts.length;
    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('cancel');
    await seq;
    // The confirmation toast is the last observable step of the repair IIFE,
    // so waiting for it guarantees the board + doc repairs already ran.
    await waitFor(() => uiStore.toasts.some((t) => /[Rr]epair/.test(t.text)));

    // Open document repointed (Discard ran the same repair as Retry).
    expect(documentStore.findByFilename('Notes/new.md')?.docId).toBe('d');
    expect(documentStore.findByFilename('Notes/old.md')).toBeNull();

    // Board file-ref rewritten old → new.
    const def = boardCacheStore.cache.b1.tileDefs.t1 as unknown as { filePath: string };
    expect(def.filePath).toBe('Notes/new.md');

    // A repair-confirmation toast was surfaced (the new Discard feedback).
    const newToasts = uiStore.toasts.slice(toastsBefore);
    expect(newToasts.some((t) => /[Rr]epair/.test(t.text))).toBe(true);

    for (const t of newToasts) uiStore.dismissToast(t.id);
  });
});
