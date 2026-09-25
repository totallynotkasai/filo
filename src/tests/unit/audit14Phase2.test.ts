import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { DeleteTilesCommand, RemoveTileTagCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { ACCENT_COLOR } from '@renderer/constants/defaults';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault } from '../helpers/memoryVault';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TileDefinition } from '@renderer/schema/index';

/**
 * Audit-14 Phase 2 — undo/redo & command-pattern correctness.
 *
 * 2.1 Cross-board rollback restored onto the wrong stack.
 * 2.3 DeleteTilesCommand.undo must reconcile open editors on the restored note.
 * 2.4 A command targeting a closed board stranded on a sibling's stack (wedge).
 * 2.5 Tag-remove undo resurrected a deleted tag definition with the default colour.
 *
 * (2.2 — DeleteCardCommand neighbour anchor — lives in
 * kanbanStructureCommandsRoundTrip.test.ts alongside the other Kanban
 * structure round-trips.)
 */

// ── Test command helpers ─────────────────────────────────────────────────────

class ScopedCommand extends Command {
  description = 'scoped';
  readonly targetBoardId: string;
  executeCount = 0;
  undoCount = 0;
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
  }
  execute(): void {
    this.executeCount += 1;
  }
  undo(): void {
    this.undoCount += 1;
  }
}

/** Targets a board, but its undo() always rejects (drives the rollback path). */
class RejectingScopedCommand extends Command {
  description = 'rejecting';
  readonly targetBoardId: string;
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
  }
  execute(): void {}
  undo(): Promise<void> {
    return Promise.reject(new Error('undo boom'));
  }
}

// ── 2.1 — cross-board rollback restores the ORIGIN board's stack ──────────────

describe('Audit-14 2.1 — cross-board rollback resolves the origin board stack', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null);
    toastSpy.mockRestore();
  });

  it('a rejected cross-board undo rolls back board A (move origin), not the switched-to board B', async () => {
    // Seed board B's own stack so we can prove it stays untouched.
    historyStore.setActiveBoard('board-B');
    const bCmd = new ScopedCommand('board-B');
    historyStore.pushWithoutExecute(bCmd); // B.undo = [bCmd]

    // The B-targeting command is filed on board A's stack (inactive-pane case).
    historyStore.setActiveBoard('board-A');
    // The activator focuses the originating board (App.svelte's real wiring),
    // flipping the active board to B inside the auto-switch — exactly the
    // condition that used to make the rollback read the wrong stack.
    historyStore.setBoardActivator((boardId) => {
      historyStore.setActiveBoard(boardId);
      return true;
    });
    const cmd = new RejectingScopedCommand('board-B');
    historyStore.pushWithoutExecute(cmd); // A.undo = [cmd]

    // Ctrl+Z on A → auto-switch to B → cmd.undo() rejects → rollbackUndo.
    await historyStore.undo().catch(() => {});

    // 2.1 — board A's stack (where the synchronous move happened) is restored.
    historyStore.setActiveBoard('board-A');
    expect(historyStore.canUndo).toBe(true); // cmd back on A's undo
    expect(historyStore.canRedo).toBe(false); // cmd removed from A's redo (would be true under the bug)

    // Board B's stack was NOT clobbered: its own command still undoes.
    historyStore.setActiveBoard('board-B');
    historyStore.setBoardActivator(null);
    await historyStore.undo().catch(() => {});
    expect(bCmd.undoCount).toBe(1); // under the bug, B.undo held the stranded `cmd`, not bCmd
  });
});

// ── 2.4 — closing a board sweeps commands targeting it off sibling stacks ─────

describe('Audit-14 2.4 — clearBoard sweeps stranded commands off sibling stacks', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.setBoardActivator(null); // no auto-switch — the closed board is gone
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('Ctrl+Z on A is not wedged behind a command targeting a closed board B', async () => {
    historyStore.setActiveBoard('board-A');
    const aCmd = new ScopedCommand('board-A');
    const bCmd = new ScopedCommand('board-B'); // targets the soon-closed board, filed on A
    historyStore.pushWithoutExecute(aCmd);
    historyStore.pushWithoutExecute(bCmd); // A.undo = [aCmd, bCmd] (bCmd on top)

    // Board B closes (last tab / board removed). The stranded bCmd must be swept.
    historyStore.clearBoard('board-B');

    // Ctrl+Z on A reaches aCmd instead of wedging behind bCmd's switch-back toast.
    await historyStore.undo();
    expect(aCmd.undoCount).toBe(1);
    expect(bCmd.undoCount).toBe(0);
    const switchToasts = toastSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('Switch to the originating board'),
    );
    expect(switchToasts.length).toBe(0);
  });

  it('leaves commands targeting OTHER live boards in place', async () => {
    historyStore.setActiveBoard('board-A');
    const cCmd = new ScopedCommand('board-C'); // targets a still-open board
    historyStore.pushWithoutExecute(cCmd);

    historyStore.clearBoard('board-B'); // unrelated close — must not touch cCmd

    expect(historyStore.canUndo).toBe(true);
  });
});

// ── 2.3 — DeleteTilesCommand.undo reconciles an open editor on the restored file

function makeMindMapWithTextTile(boardId: string, tileId: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        [tileId]: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      [tileId]: {
        id: tileId,
        type: 'text',
        title: 'Notes',
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        boardId,
        position: { x: 0, y: 0 },
        size: { width: 200, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
        filePath,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

describe('Audit-14 2.3 — DeleteTilesCommand.undo reconciles open editors', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('reloads an editor still open on the restored .md so its next save cannot invert the restore', async () => {
    const relPath = 'Notes.md';
    const bytes = '---\ntitle: Notes\n---\nrestored body\n';
    const vault = installMemoryVault({ [relPath]: bytes });
    // The sidebar tree read a restore refreshes; the memory vault has no tree.
    const filo = (window as unknown as { filo: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } }).filo;
    const inner = filo.invoke;
    filo.invoke = async (channel: string, ...args: unknown[]) =>
      channel === 'vault:read-tree' ? { ok: true, tree: [] } : inner(channel, ...args);

    // The tile is on the active board (DeleteTilesCommand snapshots from boardStore).
    const fixture = makeMindMapWithTextTile('board-1', 't_1', relPath);
    boardCacheStore.hydrate({ 'board-1': fixture }, { 'board-1': 'board-1.board.json' });
    const tiles = boardCacheStore.getFullTilesForBoard('board-1');
    boardStore.setBoard(fixture.board, tiles, {}, []);

    // The SAME file is open as a Document on a second pane.
    const model = noteStore.acquire(relPath, 'document-editor:pane2');
    await model.loaded;
    expect(model.body).toBe('restored body\n');

    const cmd = new DeleteTilesCommand(['t_1'], { vaultRoot: '/vault', filePaths: [relPath] });
    await cmd.execute();
    await cmd.lastExecuteCompletion;
    expect(vault.read(relPath)).toBeUndefined();
    expect(model.status).toBe('missing');

    await cmd.undo();
    await cmd.lastUndoCompletion;
    await model.loaded;

    // The open editor's model read the restored file again: a view still
    // showing it as missing would invert the restore on its next save.
    expect(vault.read(relPath)).toBe(bytes);
    expect(noteStore.get(relPath)).toBe(model);
    expect(model.body).toBe('restored body\n');
    expect(model.frontmatter).toEqual({ title: 'Notes' });
    expect(model.status).toBe('ready');
    expect(model.hasUnsavedBody).toBe(false);
    expect(vault.writes.filter(([, rel]) => rel === relPath)).toEqual([]);
    noteStore.release(relPath, 'document-editor:pane2');
  });
});

// ── 2.5 — tag-remove undo preserves the global tag colour ─────────────────────

/** A link tile owns its tags on the board def, so the tag edit is a cache write. */
function makeMindMapLinkTileWithTags(tags: string[]): V7BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: { t1: { x: 0, y: 0, width: 200, height: 100, locked: false, faded: false } },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'link',
        title: 'A',
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        tags,
        url: 'https://example.com',
        createdAt: 0,
        updatedAt: 0,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  } as unknown as V7BoardFileData;
}

/** The link tile's tags as stored on its board def. */
function linkTags(): string[] {
  const def = boardCacheStore.cache.mm?.tileDefs.t1;
  return def?.type === 'link' ? def.tags : [];
}

describe('Audit-14 2.5 — RemoveTileTagCommand.undo preserves the tag colour', () => {
  beforeEach(() => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: []\n---\nbody\n', mtimeMs: 1, size: 20 };
      }
      if (channel === 'vault:file-exists') return true;
      if (channel === 'tags:load') return null;
      return { success: true };
    });
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    fileTagsStore.reset();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    fileTagsStore.reset();
  });

  it('resurrects a tag definition deleted between execute and undo with its ORIGINAL colour', () => {
    const fixture = makeMindMapLinkTileWithTags(['audit14tag']);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
    // Give the tag a distinctive global colour.
    fileTagsStore.ensureTag('audit14tag', '#ff0000');
    expect(fileTagsStore.getDefinition('audit14tag').color).toBe('#ff0000');

    const cmd = new RemoveTileTagCommand('t1', 'audit14tag'); // snapshots colour #ff0000
    cmd.execute();
    expect(linkTags()).not.toContain('audit14tag');

    // An interleaved GLOBAL tag delete wipes the definition + its colour.
    fileTagsStore.deleteTag('audit14tag');
    // getDefinition now falls back to the accent default (no real definition).
    expect(fileTagsStore.getDefinition('audit14tag').color).toBe(ACCENT_COLOR);

    cmd.undo();

    // 2.5 — the original colour is restored, not the ensureTag fallback default.
    expect(fileTagsStore.getDefinition('audit14tag').color).toBe('#ff0000');
    expect(linkTags()).toContain('audit14tag');
  });
});
