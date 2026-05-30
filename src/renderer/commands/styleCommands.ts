/**
 * Style-popup commands — one per popup type so a closing popup can push a
 * single history entry spanning every pick the user made during the
 * session (matches the `UpdateTileStyleCommand` pattern from
 * TileStylePopup).
 *
 * Per-pick history entries would blow through MAX_HISTORY on a normal
 * styling session (3+ picks per popup is typical), and the user's mental
 * model is "I opened the picker, I undo to close it".
 *
 * The cache-side `updateXStyle` writers merge the patch onto the existing
 * `style` block (and clear it entirely on `null`). To replay an exact
 * snapshot the command first clears (`null`) and then re-applies the
 * snapshot — two cheap in-memory writes per execute/undo.
 *
 * Phase 15 (Sprint D / C3): extracted from `commands/index.ts` to keep
 * the host file under the size-allowlist ceiling.
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import type { Frame } from '../schema/index';
import type {
  PartialTaskStyle,
  PartialKanbanCardStyle,
} from '../schema/placement';

type StyleSnapshot = Record<string, unknown> | undefined;

function applyKanbanCardSnapshot(boardId: string, tileId: string, snapshot: StyleSnapshot): void {
  boardCacheStore.updateKanbanCardPlacementStyle(boardId, tileId, null);
  if (snapshot && Object.keys(snapshot).length > 0) {
    boardCacheStore.updateKanbanCardPlacementStyle(boardId, tileId, snapshot as PartialKanbanCardStyle);
  }
}

function applyKanbanColumnSnapshot(boardId: string, columnId: string, snapshot: StyleSnapshot): void {
  boardCacheStore.updateKanbanColumnStyle(boardId, columnId, null);
  if (snapshot && Object.keys(snapshot).length > 0) {
    boardCacheStore.updateKanbanColumnStyle(boardId, columnId, snapshot);
  }
}

function applyTaskItemSnapshot(boardId: string, tileId: string, snapshot: StyleSnapshot): void {
  boardCacheStore.updateTaskPlacementStyle(boardId, tileId, null);
  if (snapshot && Object.keys(snapshot).length > 0) {
    boardCacheStore.updateTaskPlacementStyle(boardId, tileId, snapshot as PartialTaskStyle);
  }
}

function applyTaskSectionSnapshot(boardId: string, sectionId: string, snapshot: StyleSnapshot): void {
  boardCacheStore.updateTaskSectionStyle(boardId, sectionId, null);
  if (snapshot && Object.keys(snapshot).length > 0) {
    boardCacheStore.updateTaskSectionStyle(boardId, sectionId, snapshot);
  }
}

/**
 * Per-frame style override snapshot. `updateFrame` is a top-level patch
 * (`{ ...existing, ...updates }`) so the whole `style` object replaces
 * cleanly — no clear-then-apply two-step needed.
 */
export class UpdateFrameStyleCommand extends Command {
  description: string;
  /**
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — flagged as a P1-5 site.
   * FrameStylePopup captures this at popup mount and threads it through;
   * the destroy effect can fire after a board switch.
   */
  readonly targetBoardId: string;
  private frameId: string;
  private beforeStyle: Frame['style'];
  private afterStyle: Frame['style'];

  constructor(
    frameId: string,
    beforeStyle: Frame['style'],
    afterStyle: Frame['style'],
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.frameId = frameId;
    // Phase R3 — deep-clone via `this.snapshot(...)` so nested style fields
    // (backgroundImage object, border, etc.) can't be mutated through the
    // caller-side reference after the command is pushed.
    this.beforeStyle = this.snapshot(beforeStyle);
    this.afterStyle = this.snapshot(afterStyle);
    this.description = `Update frame style`;
  }

  execute() {
    boardStore.updateFrame(this.frameId, { style: this.afterStyle });
  }

  undo() {
    boardStore.updateFrame(this.frameId, { style: this.beforeStyle });
  }
}

export class UpdateKanbanCardStyleCommand extends Command {
  description: string;
  /**
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — flagged as a P1-5 site.
   * The boardId is passed explicitly by the popup's mount-time capture.
   */
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private beforeStyle: StyleSnapshot;
  private afterStyle: StyleSnapshot;

  constructor(
    boardId: string,
    tileId: string,
    beforeStyle: StyleSnapshot,
    afterStyle: StyleSnapshot,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    // Phase R3 — deep-clone style snapshots so nested objects can't be
    // mutated through caller-side references.
    this.beforeStyle = beforeStyle ? this.snapshot(beforeStyle) : beforeStyle;
    this.afterStyle = afterStyle ? this.snapshot(afterStyle) : afterStyle;
    this.description = `Update card style`;
  }

  execute() {
    applyKanbanCardSnapshot(this.boardId, this.tileId, this.afterStyle);
  }

  undo() {
    applyKanbanCardSnapshot(this.boardId, this.tileId, this.beforeStyle);
  }
}

export class UpdateKanbanColumnStyleCommand extends Command {
  description: string;
  /** Phase 2 — see UpdateKanbanCardStyleCommand. */
  readonly targetBoardId: string;
  private boardId: string;
  private columnId: string;
  private beforeStyle: StyleSnapshot;
  private afterStyle: StyleSnapshot;

  constructor(
    boardId: string,
    columnId: string,
    beforeStyle: StyleSnapshot,
    afterStyle: StyleSnapshot,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.columnId = columnId;
    this.beforeStyle = beforeStyle ? this.snapshot(beforeStyle) : beforeStyle;
    this.afterStyle = afterStyle ? this.snapshot(afterStyle) : afterStyle;
    this.description = `Update column style`;
  }

  execute() {
    applyKanbanColumnSnapshot(this.boardId, this.columnId, this.afterStyle);
  }

  undo() {
    applyKanbanColumnSnapshot(this.boardId, this.columnId, this.beforeStyle);
  }
}

export class UpdateTaskItemStyleCommand extends Command {
  description: string;
  /** Phase 2 — see UpdateKanbanCardStyleCommand. */
  readonly targetBoardId: string;
  private boardId: string;
  private tileId: string;
  private beforeStyle: StyleSnapshot;
  private afterStyle: StyleSnapshot;

  constructor(
    boardId: string,
    tileId: string,
    beforeStyle: StyleSnapshot,
    afterStyle: StyleSnapshot,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.tileId = tileId;
    this.beforeStyle = beforeStyle ? this.snapshot(beforeStyle) : beforeStyle;
    this.afterStyle = afterStyle ? this.snapshot(afterStyle) : afterStyle;
    this.description = `Update task style`;
  }

  execute() {
    applyTaskItemSnapshot(this.boardId, this.tileId, this.afterStyle);
  }

  undo() {
    applyTaskItemSnapshot(this.boardId, this.tileId, this.beforeStyle);
  }
}

export class UpdateTaskSectionStyleCommand extends Command {
  description: string;
  /** Phase 2 — see UpdateKanbanCardStyleCommand. */
  readonly targetBoardId: string;
  private boardId: string;
  private sectionId: string;
  private beforeStyle: StyleSnapshot;
  private afterStyle: StyleSnapshot;

  constructor(
    boardId: string,
    sectionId: string,
    beforeStyle: StyleSnapshot,
    afterStyle: StyleSnapshot,
  ) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.sectionId = sectionId;
    this.beforeStyle = beforeStyle ? this.snapshot(beforeStyle) : beforeStyle;
    this.afterStyle = afterStyle ? this.snapshot(afterStyle) : afterStyle;
    this.description = `Update section style`;
  }

  execute() {
    applyTaskSectionSnapshot(this.boardId, this.sectionId, this.afterStyle);
  }

  undo() {
    applyTaskSectionSnapshot(this.boardId, this.sectionId, this.beforeStyle);
  }
}
