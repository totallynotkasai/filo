/**
 * Audit-15 Phase 4 — UI/UX LOW polish.
 *
 * Phase 4 is mostly UI/markup polish (P4.1 tab-rename auto-focus, P4.2
 * EmojiPicker arrow nav, P4.3 timer end cue, P4.4 FileTile missing-file
 * badge) validated by svelte-check + manual GUI smoke. The one item that
 * changes command *behavior* is P4.5 — a uniform "target no longer exists"
 * toast for undo/redo. This suite locks the data-adjacent half of P4.5: the
 * AddCardCommand silent-orphan regression (a redo into a deleted column used
 * to create the tile def with no placement and no feedback), plus the shared
 * toast helper's wording.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { AddCardCommand } from '@renderer/commands/index';
import { toastMissingUndoRedoTarget } from '@renderer/commands/missingTargetToast';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function column(id: string, title: string, position: number) {
  return { id, title, position, collapsed: false, tilePlacements: [] as unknown[] };
}

function makeKanban(): V7BoardFileData {
  return {
    version: 8,
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [column('c1', 'Todo', 0), column('c2', 'Doing', 1)],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

// headerColor + bodyColor + borderColor are required by TileStyleSchema, which
// persistAddKanbanPlacement validates — an empty-object style is rejected.
function cardDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    filePath: `${title}.md`,
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function kb(): KanbanBoard {
  return boardCacheStore.cache.kb!.board as KanbanBoard;
}
function cardIds(columnId: string): string[] {
  const col = kb().columns?.find((c) => c.id === columnId);
  return ((col?.tilePlacements ?? []) as Array<{ tileId: string }>).map((p) => p.tileId);
}
/** The toasts a single action appended, robust to the global TOAST_CAP. */
function toastsSince(before: number): string[] {
  return uiStore.toasts.slice(before).map((t) => t.text);
}

describe('Audit-15 Phase 4 — P4.5 uniform missing-target toast', () => {
  beforeEach(() => {
    // Start each test from an empty toast tray so slice(before) is exact.
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    installFiloMock(() => null);
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardCacheStore.hydrate({ kb: makeKanban() }, { kb: 'k.board.json' });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
  });

  it('helper: redo/undo legs produce the uniform wording', () => {
    let before = uiStore.toasts.length;
    toastMissingUndoRedoTarget('redo', 'the tile');
    expect(toastsSince(before)).toEqual(['Cannot redo — the tile no longer exists.']);
    expect(uiStore.toasts.at(-1)?.type).toBe('warning');

    before = uiStore.toasts.length;
    toastMissingUndoRedoTarget('undo', 'the column');
    expect(toastsSince(before)).toEqual(['Cannot undo — the column no longer exists.']);
  });

  it('AddCardCommand: a (re)do into a deleted column toasts and creates no orphan def', () => {
    const cmd = new AddCardCommand('kb', 'gone-column', cardDef('card1', 'First card'), 0);
    const before = uiStore.toasts.length;
    cmd.execute();

    // No silent orphan: the tile def is NOT created when the column is gone.
    expect(boardCacheStore.cache.kb!.tileDefs.card1).toBeUndefined();
    expect(toastsSince(before).some((t) => /column no longer exists/.test(t))).toBe(true);
  });

  it('AddCardCommand: a normal add into a live column does not fire the missing-target toast', () => {
    const cmd = new AddCardCommand('kb', 'c1', cardDef('card1', 'First card'), 0);
    const before = uiStore.toasts.length;
    cmd.execute();

    expect(cardIds('c1')).toContain('card1');
    expect(boardCacheStore.cache.kb!.tileDefs.card1).toBeTruthy();
    expect(toastsSince(before).some((t) => /no longer exists/.test(t))).toBe(false);
  });
});
