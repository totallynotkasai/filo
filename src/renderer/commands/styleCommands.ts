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
 * Each command keeps the keys the session changed (`keyDelta.ts`), not the
 * whole style: undo and redo change only those keys on the style as it is
 * then, so a key changed since by anything else keeps its value.
 *
 * The cache-side `updateXStyle` writers merge the patch onto the existing
 * `style` block (and clear it entirely on `null`). To replace the block with
 * the computed one the command first clears (`null`) and then applies it —
 * two cheap in-memory writes per execute/undo.
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { applyKeyDelta, keyDelta, type KeyDelta } from './keyDelta';
import type { Frame } from '../schema/index';
import type {
  PartialTaskStyle,
  PartialKanbanCardStyle,
} from '../schema/placement';

type StyleSnapshot = Record<string, unknown> | undefined;
type StyleBlock = Record<string, unknown>;

/** The board in the cache, when it is of `type`. */
function liveBoard(boardId: string, type: 'kanban' | 'tasklist'): StyleBlock | null {
  const cached = boardCacheStore.cache[boardId];
  if (!cached || cached.board.type !== type) return null;
  return cached.board as StyleBlock;
}

function detach(style: StyleBlock | undefined): StyleBlock {
  return style ? (JSON.parse(JSON.stringify(style)) as StyleBlock) : {};
}

/**
 * A Kanban card's placement style as it is in the cache now, detached. `null`
 * when the board is gone or is another type; `{}` when the card or its style
 * is gone.
 */
export function liveKanbanCardStyle(boardId: string, tileId: string): StyleBlock | null {
  const kb = liveBoard(boardId, 'kanban');
  if (!kb) return null;
  const columns = (kb.columns ?? []) as Array<{ tilePlacements?: Array<{ tileId: string; style?: StyleBlock }> }>;
  for (const c of columns) {
    const placement = (c.tilePlacements ?? []).find((p) => p.tileId === tileId);
    if (placement) return detach(placement.style);
  }
  return {};
}

/** A Kanban column's style now (see `liveKanbanCardStyle`). */
export function liveKanbanColumnStyle(boardId: string, columnId: string): StyleBlock | null {
  const kb = liveBoard(boardId, 'kanban');
  if (!kb) return null;
  const columns = (kb.columns ?? []) as Array<{ id: string; style?: StyleBlock }>;
  return detach(columns.find((c) => c.id === columnId)?.style);
}

/** A Task List task's placement style now (see `liveKanbanCardStyle`). */
export function liveTaskStyle(boardId: string, tileId: string): StyleBlock | null {
  const tl = liveBoard(boardId, 'tasklist');
  if (!tl) return null;
  const tasks = (tl.tasks ?? []) as Array<{ tileId: string; style?: StyleBlock }>;
  return detach(tasks.find((p) => p.tileId === tileId)?.style);
}

/** A Task List section's style now (see `liveKanbanCardStyle`). */
export function liveTaskSectionStyle(boardId: string, sectionId: string): StyleBlock | null {
  const tl = liveBoard(boardId, 'tasklist');
  if (!tl) return null;
  const sections = (tl.sections ?? []) as Array<{ id: string; style?: StyleBlock }>;
  return detach(sections.find((s) => s.id === sectionId)?.style);
}

/**
 * The element's style with `delta` applied, written back whole (clear, then
 * apply, as the cache writers merge). Nothing when its board is gone.
 */
function applyDelta(
  read: (boardId: string, id: string) => StyleBlock | null,
  write: (boardId: string, id: string, style: StyleBlock | null) => void,
  boardId: string,
  id: string,
  delta: KeyDelta,
): void {
  const current = read(boardId, id);
  if (current === null) return;
  const next = applyKeyDelta(current, delta);
  write(boardId, id, null);
  if (Object.keys(next).length > 0) write(boardId, id, next);
}

const writeKanbanCard = (boardId: string, id: string, style: StyleBlock | null): void =>
  boardCacheStore.updateKanbanCardPlacementStyle(boardId, id, style as PartialKanbanCardStyle | null);
const writeKanbanColumn = (boardId: string, id: string, style: StyleBlock | null): void =>
  boardCacheStore.updateKanbanColumnStyle(boardId, id, style);
const writeTask = (boardId: string, id: string, style: StyleBlock | null): void =>
  boardCacheStore.updateTaskPlacementStyle(boardId, id, style as PartialTaskStyle | null);
const writeTaskSection = (boardId: string, id: string, style: StyleBlock | null): void =>
  boardCacheStore.updateTaskSectionStyle(boardId, id, style);

/**
 * Per-frame style override. `updateFrame` is a top-level patch
 * (`{ ...existing, ...updates }`), so the computed `style` replaces the
 * frame's whole block — no clear-then-apply two-step needed.
 */
export class UpdateFrameStyleCommand extends Command {
  description: string;
  /**
   * FrameStylePopup captures this at popup mount and threads it through;
   * the destroy effect can fire after a board switch.
   */
  readonly targetBoardId: string;
  private frameId: string;
  private forward: KeyDelta;
  private inverse: KeyDelta;

  constructor(
    frameId: string,
    beforeStyle: Frame['style'],
    afterStyle: Frame['style'],
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.frameId = frameId;
    // Computed from detached snapshots, so nested style fields can't be
    // mutated through the caller-side reference after the command is pushed.
    this.forward = this.snapshot(keyDelta(beforeStyle as StyleSnapshot, afterStyle as StyleSnapshot));
    this.inverse = this.snapshot(keyDelta(afterStyle as StyleSnapshot, beforeStyle as StyleSnapshot));
    this.description = `Update frame style`;
  }

  private apply(delta: KeyDelta): void {
    const frames = boardCacheStore.cache[this.targetBoardId]?.frames ?? boardStore.frames;
    const frame = frames.find((f) => f.id === this.frameId);
    if (!frame) return;
    const style = applyKeyDelta(frame.style as StyleSnapshot, delta) as Frame['style'];
    boardStore.updateFrame(this.frameId, { style });
  }

  execute() {
    this.apply(this.forward);
  }

  undo() {
    this.apply(this.inverse);
  }
}

/** The shared shape of the element style commands below. */
abstract class ElementStyleCommand extends Command {
  description: string;
  /**
   * The boardId is passed explicitly by the popup's mount-time capture, since
   * the popup's destroy effect can fire after a board switch.
   */
  readonly targetBoardId: string;
  private boardId: string;
  private elementId: string;
  private forward: KeyDelta;
  private inverse: KeyDelta;

  constructor(boardId: string, elementId: string, beforeStyle: StyleSnapshot, afterStyle: StyleSnapshot, description: string) {
    super();
    this.targetBoardId = boardId;
    this.boardId = boardId;
    this.elementId = elementId;
    this.forward = this.snapshot(keyDelta(beforeStyle, afterStyle));
    this.inverse = this.snapshot(keyDelta(afterStyle, beforeStyle));
    this.description = description;
  }

  protected abstract read(boardId: string, id: string): StyleBlock | null;
  protected abstract write(boardId: string, id: string, style: StyleBlock | null): void;

  execute() {
    applyDelta((b, i) => this.read(b, i), (b, i, s) => this.write(b, i, s), this.boardId, this.elementId, this.forward);
  }

  undo() {
    applyDelta((b, i) => this.read(b, i), (b, i, s) => this.write(b, i, s), this.boardId, this.elementId, this.inverse);
  }
}

export class UpdateKanbanCardStyleCommand extends ElementStyleCommand {
  constructor(boardId: string, tileId: string, beforeStyle: StyleSnapshot, afterStyle: StyleSnapshot) {
    super(boardId, tileId, beforeStyle, afterStyle, `Update card style`);
  }
  protected read(boardId: string, id: string): StyleBlock | null {
    return liveKanbanCardStyle(boardId, id);
  }
  protected write(boardId: string, id: string, style: StyleBlock | null): void {
    writeKanbanCard(boardId, id, style);
  }
}

export class UpdateKanbanColumnStyleCommand extends ElementStyleCommand {
  constructor(boardId: string, columnId: string, beforeStyle: StyleSnapshot, afterStyle: StyleSnapshot) {
    super(boardId, columnId, beforeStyle, afterStyle, `Update column style`);
  }
  protected read(boardId: string, id: string): StyleBlock | null {
    return liveKanbanColumnStyle(boardId, id);
  }
  protected write(boardId: string, id: string, style: StyleBlock | null): void {
    writeKanbanColumn(boardId, id, style);
  }
}

export class UpdateTaskItemStyleCommand extends ElementStyleCommand {
  constructor(boardId: string, tileId: string, beforeStyle: StyleSnapshot, afterStyle: StyleSnapshot) {
    super(boardId, tileId, beforeStyle, afterStyle, `Update task style`);
  }
  protected read(boardId: string, id: string): StyleBlock | null {
    return liveTaskStyle(boardId, id);
  }
  protected write(boardId: string, id: string, style: StyleBlock | null): void {
    writeTask(boardId, id, style);
  }
}

export class UpdateTaskSectionStyleCommand extends ElementStyleCommand {
  constructor(boardId: string, sectionId: string, beforeStyle: StyleSnapshot, afterStyle: StyleSnapshot) {
    super(boardId, sectionId, beforeStyle, afterStyle, `Update section style`);
  }
  protected read(boardId: string, id: string): StyleBlock | null {
    return liveTaskSectionStyle(boardId, id);
  }
  protected write(boardId: string, id: string, style: StyleBlock | null): void {
    writeTaskSection(boardId, id, style);
  }
}
