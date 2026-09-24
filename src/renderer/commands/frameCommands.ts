import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { framesStore } from '../stores/frames.svelte';
import type { Frame } from '../schema/index';

export class AddFrameCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private frame: Frame;

  constructor(frame: Frame, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // Deep-clone so the snapshot doesn't share `position`, `size`, `style`, or
    // `tileIds` with the live store; later mutations would leak into redo.
    this.frame = this.snapshot(frame);
    this.description = `Add frame "${frame.title}"`;
  }

  execute() {
    boardStore.addFrame(this.snapshot(this.frame));
  }

  undo() {
    boardStore.removeFrame(this.frame.id);
  }
}

/**
 * Generic Frame patch — captures a before/after `Partial<Frame>` pair so
 * title commits, collapse toggles, resize endpoints and drag endpoints can
 * all share one command shape.
 *
 * Drag is handled by `MoveFrameCommand` rather than this class because the
 * frame's contained tiles also move during a drag — see that command for
 * the full picture.
 *
 * When the patch changes `size`, the frame's contained
 * tile set can shift (tiles fall outside the new bounds, others fall
 * inside). The constructor snapshots `frame.tileIds` BEFORE the resize
 * (Frame.svelte runs `updateContainment` AFTER `pushWithoutExecute`, so
 * the read still sees the pre-resize state). On undo we restore that
 * snapshot; on redo we call `updateContainment` to re-derive the
 * post-resize state from the restored size + tile positions.
 */
export class UpdateFrameCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private frameId: string;
  private beforeUpdates: Partial<Frame>;
  private afterUpdates: Partial<Frame>;
  private frameTileIdsBefore: string[] | null;

  constructor(
    frameId: string,
    beforeUpdates: Partial<Frame>,
    afterUpdates: Partial<Frame>,
    description?: string,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.frameId = frameId;
    // Deep-clone so nested `style` or `tileIds` arrays can't be
    // mutated through the original reference after the command is pushed.
    this.beforeUpdates = this.snapshot(beforeUpdates);
    this.afterUpdates = this.snapshot(afterUpdates);
    this.description = description ?? `Update frame`;
    const sizeInPatch = 'size' in afterUpdates || 'size' in beforeUpdates;
    if (sizeInPatch) {
      const f = boardStore.frames.find((fr) => fr.id === frameId);
      this.frameTileIdsBefore = f ? [...f.tileIds] : null;
    } else {
      this.frameTileIdsBefore = null;
    }
  }

  execute() {
    boardStore.updateFrame(this.frameId, this.afterUpdates);
    if (this.frameTileIdsBefore !== null) {
      framesStore.updateContainment(this.frameId);
    }
  }

  undo() {
    boardStore.updateFrame(this.frameId, this.beforeUpdates);
    if (this.frameTileIdsBefore !== null) {
      // Restore the exact pre-resize containment, filtering out tile IDs
      // whose tiles were deleted out-of-band so we don't resurrect stale
      // refs.
      const frame = boardStore.frames.find((f) => f.id === this.frameId);
      if (frame) {
        const filtered = this.frameTileIdsBefore.filter((id) => !!boardStore.getTile(id));
        boardStore.updateFrame(this.frameId, { tileIds: filtered });
      }
    }
  }
}

/**
 * Move a Frame and every tile it contained at drag start by the same
 * delta. `containedTileIds` is the snapshot of which tiles travelled with
 * the frame — captured at drag start so a `framesStore.updateContainment`
 * fired between drag start and end (e.g. an external add-tile race)
 * doesn't widen or narrow the undo set.
 */
export class MoveFrameCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private frameId: string;
  private beforePos: { x: number; y: number };
  private afterPos: { x: number; y: number };
  private containedTileIds: string[];

  constructor(
    frameId: string,
    beforePos: { x: number; y: number },
    afterPos: { x: number; y: number },
    containedTileIds: string[],
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.frameId = frameId;
    // allow-shallow: positions are `{x, y}` primitives, containedTileIds
    // are primitive strings.
    this.beforePos = { ...beforePos };
    this.afterPos = { ...afterPos };
    this.containedTileIds = [...containedTileIds];
    this.description = `Move frame`;
  }

  private applyTo(pos: { x: number; y: number }, fromPos: { x: number; y: number }): void {
    boardStore.updateFrame(this.frameId, { position: { ...pos } });
    const dx = pos.x - fromPos.x;
    const dy = pos.y - fromPos.y;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
    const updates = this.containedTileIds
      .map((id) => {
        const tile = boardStore.getTile(id);
        if (!tile) return null;
        return { id, changes: { position: { x: tile.position.x + dx, y: tile.position.y + dy } } };
      })
      .filter((u): u is NonNullable<typeof u> => !!u);
    if (updates.length > 0) boardStore.batchUpdateTiles(updates);
  }

  execute() {
    this.applyTo(this.afterPos, this.beforePos);
    // Recompute containment so tiles added or removed between the
    // original drag and a redo (or any tile whose centre now falls
    // outside the frame's restored position) get the correct tileIds.
    framesStore.updateContainment(this.frameId);
  }

  undo() {
    this.applyTo(this.beforePos, this.afterPos);
    framesStore.updateContainment(this.frameId);
  }
}

export class DeleteFrameCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private frame: Frame;

  constructor(frameId: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    const f = boardStore.frames.find(fr => fr.id === frameId);
    // Explicit not-found guard: otherwise snapshotting `undefined` throws an
    // opaque JSON.parse error for what is really a stale UI handle racing a
    // frame that was already removed.
    if (!f) throw new Error(`DeleteFrameCommand: frame ${frameId} not found`);
    // Deep-clone so a tile dropped into / out of the frame between delete and
    // undo can't mutate the snapshot's containment through the live store.
    this.frame = this.snapshot(f);
    this.description = `Delete frame`;
  }

  execute() {
    boardStore.removeFrame(this.frame.id);
  }

  undo() {
    boardStore.addFrame(this.snapshot(this.frame));
  }
}
