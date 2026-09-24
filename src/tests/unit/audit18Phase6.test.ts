/**
 * Audit-18 Phase 6 — canvas / store residual corners.
 *
 *  6.1 `tileDragAction` opened/closed the spatial-index batch via the GLOBAL
 *      `spatialStore` facade (→ the globally-active pane's spatial index). The
 *      drag is pointer-captured to the pane it started on, so its handlers keep
 *      firing there — but a second touch on the OTHER pane retargets the active
 *      scope mid-drag (PaneView activates on pointerdowncapture). `beginBatch()`
 *      then opened pane A's batch while `endBatch()` closed pane B's, leaking
 *      pane A's batch forever (frozen spatial revision → viewport culling stops
 *      updating; looks like data loss). Fix: thread the pane's `BoardScope` into
 *      the action and bind begin/endBatch (and all board/canvas/selection reads)
 *      to `scope.spatial` — immune to active-scope flips. Mirrors Audit-12 M5.
 *
 *  6.3 `UpdatePropertiesCommand`'s undo/redo (`applySnapshot`) blind-applied the
 *      target snapshot's frontmatter with a STALE/empty body (index `content` or
 *      `''`) when the disk hydrate read FAILED and no editor was open. The branch
 *      comment wrongly assumed a read failure implies the WRITE will ENOENT-fail;
 *      a non-ENOENT read failure (FILE_TOO_LARGE / transient EACCES/EBUSY) leaves
 *      the file PRESENT, so the write succeeds and silently overwrites the real
 *      note. Fix (B1 contract): when the read failed AND there's no live
 *      docState, `markPathFailed` + throw instead of blind-writing.
 *
 * The jsdom suite has no Svelte component-mount harness; 6.1 is driven through
 * the raw action (the component only forwards its context scope), and 6.3's
 * narrowness (the else-path blind-apply is preserved) is pinned via a
 * source-shape assertion, same pattern as audit18Phase5.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { tileDragAction } from '@renderer/lib/canvas/tileDrag';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import {
  setActiveScope,
  resetActiveScope,
  type BoardScope,
} from '@renderer/lib/boards/boardScope.svelte';
import { UpdatePropertiesCommand } from '@renderer/commands/propertiesCommands';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import {
  hasFailedWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetMarkdownFileWriterForTests } from '@renderer/lib/vault/markdownFileWriter';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, TileDefinition } from '@renderer/schema/index';

const ROOT = process.cwd();

// ── 6.1 helpers ──────────────────────────────────────────────────────────

function makeMindMapWithTile(): V7BoardFileData {
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {
        t1: { x: 100, y: 100, width: 200, height: 150, locked: false, faded: false },
      },
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'text',
        filePath: 'T.md',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        boardId: 'mm',
        position: { x: 100, y: 100 },
        size: { width: 200, height: 150 },
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

/** Hydrate the shared board cache + bind `scope`'s board to the 'mm' fixture. */
function bindBoardToScope(scope: BoardScope): void {
  const fixture = makeMindMapWithTile();
  boardCacheStore.hydrate({ mm: fixture }, { mm: 'map.board.json' });
  const tiles = boardCacheStore.getFullTilesForBoard('mm');
  scope.board.setBoard(fixture.board, tiles, {}, []);
}

function makePointerEvent(
  type: string,
  init: { clientX: number; clientY: number; button?: number; pointerId?: number },
): PointerEvent {
  const ev = new MouseEvent(type, {
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1, configurable: true });
  return ev as unknown as PointerEvent;
}

function stubPointerCapture(el: HTMLElement): void {
  if (!(el as { setPointerCapture?: unknown }).setPointerCapture) {
    (el as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {};
    (el as { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => {};
  }
}

describe('Audit-18 6.1 — tile drag spatial batch is pane-scoped', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    resetActiveScope();
  });
  afterEach(() => {
    boardCacheStore.clear();
    resetActiveScope();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('opens AND closes the batch on the THREADED scope even when the active scope flips mid-drag', () => {
    // The pane the drag starts on (active at drag-start, as PaneView would have
    // activated it on pointerdown).
    const dragScope = createBoardScope();
    bindBoardToScope(dragScope);
    setActiveScope(dragScope);

    // The OTHER pane — what a mid-drag touch retargets the global facades to.
    const otherScope = createBoardScope();

    const beginDrag = vi.spyOn(dragScope.spatial, 'beginBatch');
    const endDrag = vi.spyOn(dragScope.spatial, 'endBatch');
    const beginOther = vi.spyOn(otherScope.spatial, 'beginBatch');
    const endOther = vi.spyOn(otherScope.spatial, 'endBatch');

    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: dragScope });

    // Drag start — opens the batch on the drag pane's spatial index.
    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    expect(beginDrag).toHaveBeenCalledTimes(1);
    expect(beginOther).not.toHaveBeenCalled();

    // A second touch on the OTHER pane retargets the global active scope.
    setActiveScope(otherScope);

    // Drag end — MUST close the SAME batch it opened (the drag pane's), not the
    // now-active other pane's. Pre-fix this routed through the global facade and
    // closed `otherScope` → `dragScope`'s batch leaked open forever.
    node.dispatchEvent(makePointerEvent('pointerup', { clientX: 200, clientY: 200 }));
    expect(endDrag).toHaveBeenCalledTimes(1);
    expect(endOther).not.toHaveBeenCalled();

    action.destroy();
    node.remove();
  });

  it('never touches the active scope when the drag pane is NOT the active one', () => {
    // Drag pane is distinct from (and never) the active pane for the whole
    // gesture — the action must still operate purely on the threaded scope.
    const dragScope = createBoardScope();
    bindBoardToScope(dragScope);
    const activeScope = createBoardScope();
    setActiveScope(activeScope);

    const beginDrag = vi.spyOn(dragScope.spatial, 'beginBatch');
    const endDrag = vi.spyOn(dragScope.spatial, 'endBatch');
    const beginActive = vi.spyOn(activeScope.spatial, 'beginBatch');
    const endActive = vi.spyOn(activeScope.spatial, 'endBatch');

    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: dragScope });

    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    node.dispatchEvent(makePointerEvent('pointerup', { clientX: 200, clientY: 200 }));

    expect(beginDrag).toHaveBeenCalledTimes(1);
    expect(endDrag).toHaveBeenCalledTimes(1);
    expect(beginActive).not.toHaveBeenCalled();
    expect(endActive).not.toHaveBeenCalled();

    action.destroy();
    node.remove();
  });

  it('pointercancel also closes the batch on the threaded scope', () => {
    const dragScope = createBoardScope();
    bindBoardToScope(dragScope);
    const otherScope = createBoardScope();
    setActiveScope(dragScope);

    const endDrag = vi.spyOn(dragScope.spatial, 'endBatch');
    const endOther = vi.spyOn(otherScope.spatial, 'endBatch');

    const node = document.createElement('div');
    document.body.appendChild(node);
    stubPointerCapture(node);
    const action = tileDragAction(node, { tileId: 't1', locked: false, scope: dragScope });

    node.dispatchEvent(makePointerEvent('pointerdown', { clientX: 200, clientY: 200 }));
    setActiveScope(otherScope);
    node.dispatchEvent(makePointerEvent('pointercancel', { clientX: 200, clientY: 200 }));

    expect(endDrag).toHaveBeenCalledTimes(1);
    expect(endOther).not.toHaveBeenCalled();

    action.destroy();
    node.remove();
  });
});

// ── 6.3 ──────────────────────────────────────────────────────────────────

describe('Audit-18 6.3 — Properties undo/redo refuses on read failure with no docState', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
  });

  it('throws and fires NO write IPC when the hydrate read fails and no doc is open', async () => {
    // The on-disk `.md` exists but is unreadable (e.g. AV/OneDrive holds a read
    // lock, or a >25 MB note hits FILE_TOO_LARGE) — the read THROWS but the file
    // is present, so a blind write would overwrite it with a stale/empty body.
    const writeSpy = vi.fn(async () => ({ ok: true, data: undefined }));
    installFiloMock({
      'vault:read-file-text': () => {
        throw new Error('EACCES: read locked by another process');
      },
      'vault:write-existing-file-text': writeSpy,
    });

    // No `docId` → no live docState → no live body to fall back on.
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'Note.md', docId: null, fm: { status: 'todo' } },
      { kind: 'frontmatter', relPath: 'Note.md', docId: null, fm: { status: 'done' } },
      'b1',
    );

    await expect(cmd.execute()).rejects.toThrow(/Could not read|refusing to overwrite/i);
    // The blind write was refused — the real on-disk note is untouched.
    expect(writeSpy).not.toHaveBeenCalled();
    // Failure is surfaced loudly (sentinel stays dirty), not swallowed as success.
    expect(hasFailedWrites()).toBe(true);
  });

  it('source pins the refuse guard AND preserves the else-path blind-apply (narrowness)', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/commands/propertiesCommands.ts'),
      'utf8',
    );
    // The refuse is gated on BOTH the read failing and there being no live
    // docState (a live body is safe to write), and it fails loudly.
    expect(src).toMatch(/if\s*\(\s*readFailed\s*&&\s*!docState\s*\)/);
    expect(src).toMatch(/markPathFailed\(\s*vaultRoot\s*,\s*relPath\s*\)/);
    // The non-refuse corner (live body present) still blind-applies — the fix is
    // narrow, not a blanket refusal of every no-baseline write.
    expect(src).toMatch(/merged\s*=\s*cleanFrontmatter\(\s*\{\s*\.\.\.targetFm\s*\}\s*\)/);
  });
});
