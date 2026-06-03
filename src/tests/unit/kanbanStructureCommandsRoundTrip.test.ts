/**
 * Audit-6 Phase 5.5 — execute/undo ROUND-TRIP coverage for the Kanban
 * structure commands the `ci:command-roundtrip-coverage` gate requires.
 *
 * H1 (`ReorderSectionCommand`) silently no-op'd a multi-slot drag because no
 * test ever drove a degenerate-delta reorder through execute → undo. These
 * tests lock the Kanban analogues — most importantly a multi-COLUMN
 * move-first-to-last (the direct `ReorderColumnCommand` twin of H1) — plus the
 * add-column / rename-column / add-card round-trips. Each asserts execute
 * changes state, undo reverses it, and redo re-applies it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  AddColumnCommand,
  RenameColumnCommand,
  ReorderColumnCommand,
  AddCardCommand,
} from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard, TileDefinition } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function column(id: string, title: string, position: number) {
  return { id, title, position, collapsed: false, tilePlacements: [] as unknown[] };
}

function makeKanban(): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [column('c1', 'Todo', 0), column('c2', 'Doing', 1), column('c3', 'Done', 2)],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

// headerColor + bodyColor + borderColor are required by TileStyleSchema, which
// `persistAddKanbanPlacement` validates — an empty-object style is rejected.
function cardDef(id: string, title: string): TileDefinition {
  return {
    id,
    type: 'text',
    title,
    style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
    tags: [],
    contentId: `doc_${id}`,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as TileDefinition;
}

function kb(): KanbanBoard {
  return boardCacheStore.cache.kb!.board as KanbanBoard;
}
function columnIds(): string[] {
  return [...(kb().columns ?? [])].sort((a, b) => a.position - b.position).map((c) => c.id);
}
function columnTitle(id: string): string | undefined {
  return kb().columns?.find((c) => c.id === id)?.title;
}
function cardIds(columnId: string): string[] {
  const col = kb().columns?.find((c) => c.id === columnId);
  return ((col?.tilePlacements ?? []) as Array<{ tileId: string }>).map((p) => p.tileId);
}

describe('Audit-6 Phase 5.5 — Kanban structure command round-trips', () => {
  beforeEach(() => {
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

  it('AddColumnCommand: execute adds, undo removes, redo re-adds', () => {
    const cmd = new AddColumnCommand('kb', { id: 'c4', title: 'Archive', position: 3 });
    cmd.execute();
    expect(columnIds()).toContain('c4');
    cmd.undo();
    expect(columnIds()).not.toContain('c4');
    cmd.execute(); // redo
    expect(columnIds()).toContain('c4');
  });

  it('RenameColumnCommand: execute renames, undo restores, redo re-applies', () => {
    const cmd = new RenameColumnCommand('kb', 'c1', 'Todo', 'Backlog');
    cmd.execute();
    expect(columnTitle('c1')).toBe('Backlog');
    cmd.undo();
    expect(columnTitle('c1')).toBe('Todo');
    cmd.execute(); // redo
    expect(columnTitle('c1')).toBe('Backlog');
  });

  it('ReorderColumnCommand: a multi-slot move-first-to-last round-trips (H1 twin)', () => {
    // 3 positions change at once — the exact shape H1's section command silently
    // dropped. ReorderColumnCommand captures the WHOLE order, so it survives.
    const cmd = new ReorderColumnCommand('kb', ['c1', 'c2', 'c3'], ['c2', 'c3', 'c1']);
    cmd.execute();
    expect(columnIds()).toEqual(['c2', 'c3', 'c1']);
    cmd.undo();
    expect(columnIds()).toEqual(['c1', 'c2', 'c3']);
    cmd.execute(); // redo
    expect(columnIds()).toEqual(['c2', 'c3', 'c1']);
  });

  it('AddCardCommand: execute adds the card + def, undo removes them, redo re-adds', () => {
    const cmd = new AddCardCommand('kb', 'c1', cardDef('card1', 'First card'), 0);
    cmd.execute();
    expect(cardIds('c1')).toContain('card1');
    expect(boardCacheStore.cache.kb!.tileDefs.card1).toBeTruthy();
    cmd.undo();
    expect(cardIds('c1')).not.toContain('card1');
    cmd.execute(); // redo
    expect(cardIds('c1')).toContain('card1');
  });
});
