import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import type { CascadeStyleClears } from '../stores/boardCacheFrontmatter';
import type { BoardView } from '../stores/boardCacheDelete';
import type { Tile, Connection, TileGroup } from '../schema/index';
import { cloneTile } from '../lib/utils/cloneTile';
import { reportError } from '../lib/utils/errorBus';
import { fileTagsStore } from '../stores/fileTags.svelte';
import { restoreFiles, retargetPath, trashFiles, type TrashedItem } from './trashedFiles';
import { ChangeRefusedError } from './changeRefusedError';
import { DeleteCardCommand } from './kanbanCommands';
import { DeleteTaskCommand } from './taskCommands';
import { restoreClearedPins, type ClearedPin } from '../lib/vault/folderPins';
import { clearDefaultImages, restoreDefaultImages, type ClearedDefaultImage } from '../stores/globalDefaultImages';
import { captureTileMemberships, restoreTileMemberships, type TileMemberships } from '../lib/boards/tileMemberships';
import { plural } from '../lib/utils/plural';

/**
 * Opens a notice when one or more rollback children threw inside
 * `BatchCommand`: part of the change stayed in place. A toast is too easy to
 * miss for that, so the notice waits for OK. There is nothing to choose: what
 * the board shows is what is saved, so it says which parts to look over.
 */
function openBatchRollbackFailureModal(
  batchDescription: string,
  failures: { description: string; phase: 'execute' | 'undo' }[],
): void {
  const summary = failures
    .map((f) => `• ${f.description} (while ${f.phase === 'undo' ? 'undoing' : 'redoing'} it)`)
    .join('\n');
  uiStore.openConfirm({
    title: 'Part of a change stayed in place',
    body:
      `"${batchDescription}" stopped partway, and Filo couldn't put every part of it back.\n\n` +
      `Parts left as they are now:\n${summary}\n\n` +
      'What the board shows now is what is saved. Look over these parts and change back by hand anything that looks wrong.',
    confirmLabel: 'OK',
    notice: true,
    onConfirm: () => {},
  });
}

// ── Batch Command ──

export class BatchCommand extends Command {
  description: string;
  /**
   * A batch's effective board is determined by its children: the first child
   * with a non-empty targetBoardId. Empty means board-agnostic (the
   * historyStore guard skips empty strings).
   */
  readonly targetBoardId: string;
  private commands: Command[];

  constructor(description: string, commands: Command[], boardId?: string) {
    super();
    this.description = description;
    // allow-shallow: copy the array so the caller can't mutate the input and
    // corrupt the execute / undo sequence. The commands carry their own
    // snapshots, so we don't deep-clone.
    this.commands = [...commands];
    // Resolution order: explicit boardId param > first child's
    // targetBoardId > active board > empty. Falling through to the active
    // board is the safest default for the typical use case (every batch is
    // built within a single board's scope) without forcing every caller
    // through the same explicit-boardId boilerplate.
    const childWithBoard = commands.find((c) => c.targetBoardId);
    this.targetBoardId = boardId ?? childWithBoard?.targetBoardId ?? boardStore.current?.id ?? '';
  }

  /** Its own board and every board a child touches. */
  touchedBoardIds(): ReadonlySet<string> {
    const ids = new Set<string>(this.targetBoardId ? [this.targetBoardId] : []);
    for (const cmd of this.commands) for (const id of cmd.touchedBoardIds()) ids.add(id);
    return ids;
  }

  /** Whether any child changes a board file. */
  changesBoardFile(): boolean {
    return this.commands.some((cmd) => cmd.changesBoardFile());
  }

  /**
   * Atomic-ish execute: if child #N throws, children 0..N-1 have already
   * mutated state, so undo them in reverse order and rethrow the original
   * failure. Rollback errors are reported but never mask the primary failure.
   */
  async execute(): Promise<void> {
    // Every child call (forward + rollback) is awaited via
    // `Promise.resolve(...)` so sync and async children both sequence, and an
    // async child's rejection lands in this try/catch instead of escaping.
    const executed: Command[] = [];
    for (const cmd of this.commands) {
      try {
        await Promise.resolve(cmd.execute());
        executed.push(cmd);
      } catch (err) {
        // Log the ORIGINAL child failure that triggered the rollback. The
        // user-facing toast comes from historyStore's catch; this is the
        // per-child diagnostic that toast can't carry.
        console.error(
          `[BatchCommand] Child "${cmd.description}" failed in batch "${this.description}"; rolling back ${executed.length} applied child/children.`,
          err,
        );
        // Track rollback failures so the user gets a danger modal, not just
        // an easily-dismissed toast, for a half-applied batch.
        const rollbackFailures: { description: string; phase: 'undo' }[] = [];
        for (let i = executed.length - 1; i >= 0; i--) {
          const ex = executed[i];
          if (!ex) continue;
          try {
            // Awaited so snapshot-write commands (DeleteTilesCommand) don't
            // race their .md restores against later rollback steps.
            await Promise.resolve(ex.undo());
          } catch (rollbackErr) {
            reportError(
              'BatchCommand',
              rollbackErr,
              `Rollback failure for "${ex.description}" while undoing partial batch "${this.description}".`,
            );
            rollbackFailures.push({ description: ex.description, phase: 'undo' });
          }
        }
        if (rollbackFailures.length > 0) {
          openBatchRollbackFailureModal(this.description, rollbackFailures);
        }
        throw err;
      }
    }
  }

  async undo(): Promise<void> {
    // Symmetric: walk forward through the LIFO order, but if a child's
    // undo throws we attempt to re-execute the children we already
    // undid so the state matches the pre-undo snapshot. The historyStore
    // chain then sees a rejected promise and the user gets a toast.
    // Child calls are awaited (see execute()).
    const undone: Command[] = [];
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const cmd = this.commands[i];
      if (!cmd) continue;
      try {
        await Promise.resolve(cmd.undo());
        undone.push(cmd);
      } catch (err) {
        // Log the original child-undo failure that triggered the re-apply;
        // the toast comes from historyStore, this is the per-child diagnostic.
        console.error(
          `[BatchCommand] Child "${cmd.description}" undo failed in batch "${this.description}"; re-applying ${undone.length} undone child/children.`,
          err,
        );
        // Same logic as execute(): if the rollback path itself
        // throws on one or more re-executes, the state is now genuinely
        // inconsistent. Surface a modal so the user can decide to close
        // without saving.
        const rollbackFailures: { description: string; phase: 'execute' }[] = [];
        for (let j = undone.length - 1; j >= 0; j--) {
          const u = undone[j];
          if (!u) continue;
          try {
            await Promise.resolve(u.execute());
          } catch (rollbackErr) {
            reportError(
              'BatchCommand',
              rollbackErr,
              `Rollback failure for "${u.description}" while redoing partial batch undo "${this.description}".`,
            );
            rollbackFailures.push({ description: u.description, phase: 'execute' });
          }
        }
        if (rollbackFailures.length > 0) {
          openBatchRollbackFailureModal(this.description, rollbackFailures);
        }
        throw err;
      }
    }
  }
}

// ── Group / Settings / Cascade ──

/**
 * Groups or ungroups the selected tiles in a Mind Map board. Both branches
 * snapshot the entire `groups` array so undo restores the prior structure
 * exactly — including any pre-existing groups affected by the group/merge
 * heuristic in `groupTiles`. Storing the full snapshot is cheap (groups are
 * shallow objects) and avoids the corner-case bookkeeping of trying to
 * reconstruct the diff after the fact.
 */
export class ToggleGroupCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileIds: string[];
  private action: 'group' | 'ungroup';
  private groupsBefore: TileGroup[];

  constructor(
    tileIds: string[],
    action: 'group' | 'ungroup',
    groupsBefore: TileGroup[],
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: tileIds are primitive strings.
    this.tileIds = [...tileIds];
    this.action = action;
    // Deep-clone so a later mutation
    // of the live groups array (or its nested `tileIds`) can't leak into
    // the would-be-restored snapshot.
    this.groupsBefore = this.snapshot(groupsBefore);
    this.description = action === 'group'
      ? `Group ${tileIds.length} tiles`
      : `Ungroup ${tileIds.length} tiles`;
  }

  execute() {
    if (this.action === 'group') boardStore.groupTiles(this.tileIds);
    else boardStore.ungroupTiles(this.tileIds);
  }

  undo() {
    // Re-clone via `this.snapshot(...)` on restore so a future undo cycle
    // doesn't share refs with the post-undo store state.
    boardStore.replaceGroups(this.snapshot(this.groupsBefore));
  }
}

/** What a cascade delete took away besides the placements, for its undo. */
export interface CascadeDeleteOptions {
  /** Anchors the vault-swap guard; defaults to the open vault. */
  vaultRoot?: string;
  styleClears?: CascadeStyleClears;
  /** The file or folder the delete moved into Filo's trash, when it did. */
  trashed?: TrashedItem | null;
  /** `.filo/tags.json` file tags the delete dropped (path → tags). */
  fileTags?: Record<string, string[]>;
  /** Folder pins (Root Directory, board folders) the delete cleared. */
  clearedPins?: ClearedPin[];
  /** The Global Defaults' frame image, when the delete took its file. */
  clearedDefaultImages?: ClearedDefaultImage[];
  /** How each board whose file went with the item was shown (camera, side toolbar), by board id. */
  boardViews?: Record<string, BoardView>;
}

/**
 * Undo for a delete of a vault file or folder (the sidebar delete) and for
 * "remove the tiles of a missing file": every tile placement on every board
 * that pointed at it, their connections and the style fields that referenced
 * it, plus the item itself, which waits in Filo's trash.
 *
 * Undo moves the item back from the trash (a rename, whatever its type or
 * size), then restores the placements. Redo moves it to the trash again.
 *
 * It snapshots the tiles of every board it touches, so undo restores the
 * cache of boards that aren't open as well as the open one. The step sits on
 * the stack of the board that was active at the delete; it names every
 * board it holds a snapshot of (`touchedBoardIds`), so a reload of any of
 * them drops it.
 */
export class CascadeDeleteCommand extends Command {
  description: string;
  /**
   * Board-spanning by design: the cascade restores placements across every
   * board's cache, so a single targetBoardId would block legitimate
   * cross-board work. Set to '' so the history dispatcher's guard skips it.
   */
  readonly targetBoardId: string;
  private byBoard: Record<string, Tile[]>;
  private connections: Connection[];
  private vaultRoot: string;
  /**
   * Style-clears applied when the cascade ran (Kanban `coverImage`, frame
   * `style.backgroundImage`, mindmap `defaults.frame.backgroundImage` that
   * pointed at the file), each with its `matchedPath`. Without this, undo
   * restores the placements but the style fields stay wiped.
   */
  private styleClears: CascadeStyleClears;
  /** In the trash now (null once undo brought it back, until a redo). */
  private trashed: TrashedItem | null;
  /** Where the item is when not in the trash: what a redo after undo moves. */
  private itemRel: string | null;
  private fileTags: Record<string, string[]>; // allow-string-path-key: tags.json fileTags keys, put back verbatim
  /** Pins on the deleted folder or inside it: undo puts them back, redo clears them again. */
  private clearedPins: ClearedPin[];
  /** The Global Defaults' frame image the delete cleared: undo puts it back, redo clears it again. */
  private clearedDefaultImages: ClearedDefaultImage[];
  /**
   * The camera and side toolbar of each board inside the item, which the
   * delete drops with the board: undo puts them back once the file is back,
   * as the Board Browser's delete does. Keyed by board id (the file keeps it).
   */
  private boardViews: Record<string, BoardView>;
  /** The frames and groups the removed tiles were in, per board. */
  private memberships: TileMemberships[] = [];
  private hasRun = false;
  /**
   * Kanban cards and Task List tasks, one placement-only delete each, in the
   * order undo puts them back. `addTile` on those boards restores only the
   * definition (the `Tile` shape has no column, section or order), so these
   * snapshots carry each card's column, neighbour, style and cover, and each
   * task's position, style and lock.
   */
  private placements: Array<DeleteCardCommand | DeleteTaskCommand> = [];
  /** Boards whose tiles come back through `placements`, not `addTile`. */
  private placementBoards = new Set<string>();

  /**
   * Must run before the cascade touches the cache (style clears included),
   * so the placement snapshots hold the card's cover and position.
   */
  constructor(
    byBoard: Record<string, Tile[]>,
    connections: Connection[],
    opts: CascadeDeleteOptions = {},
  ) {
    super();
    // Board-spanning command; empty string skips the history-store guard.
    this.targetBoardId = '';
    this.byBoard = {};
    for (const [boardId, tiles] of Object.entries(byBoard)) {
      // cloneTile shares large string references but detaches every nested
      // object — the snapshot contract we want here.
      this.byBoard[boardId] = tiles.map((t) => cloneTile(t));
      this.snapshotPlacements(boardId, tiles);
      this.memberships.push(captureTileMemberships(boardId, tiles.map((t) => t.id)));
    }
    this.connections = this.snapshot(connections);
    // Capture the vault root so undo/redo can refuse to run against a
    // different vault.
    this.vaultRoot = opts.vaultRoot || vaultStore.path || '';
    // Deep-clone via `this.snapshot(...)` so a later mutation against the
    // originating objects can't leak into the undo plan.
    this.styleClears = this.snapshot(
      opts.styleClears ?? { coverImage: {}, columnCoverImage: {}, frameBackground: {}, boardSettings: {} },
    );
    this.trashed = opts.trashed ? { ...opts.trashed } : null;
    this.itemRel = opts.trashed?.rel ?? null;
    this.fileTags = this.snapshot(opts.fileTags ?? {});
    this.clearedPins = this.snapshot(opts.clearedPins ?? []);
    this.clearedDefaultImages = this.snapshot(opts.clearedDefaultImages ?? []);
    this.boardViews = this.snapshot(opts.boardViews ?? {});
    const totalTiles = Object.values(byBoard).reduce((sum, t) => sum + t.length, 0);
    this.description = this.itemRel
      ? `Delete "${this.itemRel}"`
      : `Delete ${plural(totalTiles, 'tile')}`;
  }

  private snapshotPlacements(boardId: string, tiles: Tile[]): void {
    const board = boardCacheStore.cache[boardId]?.board;
    const ids = new Set(tiles.map((t) => t.id));
    if (board?.type === 'kanban') {
      // Last card first: each card's anchor is the sibling that followed it,
      // which may itself be one of the deleted cards.
      const order: string[] = [];
      for (const col of board.columns ?? []) {
        for (const p of col.tilePlacements ?? []) if (ids.has(p.tileId)) order.push(p.tileId);
      }
      for (const tileId of order.reverse()) this.placements.push(new DeleteCardCommand(boardId, tileId));
      this.placementBoards.add(boardId);
    } else if (board?.type === 'tasklist') {
      // First task first: each goes back at its old index, which is right
      // once every earlier one is back.
      for (const p of board.tasks ?? []) {
        if (ids.has(p.tileId)) this.placements.push(new DeleteTaskCommand(boardId, p.tileId));
      }
      this.placementBoards.add(boardId);
    }
  }

  /** Every board it holds a tile, placement, connection or style snapshot for. */
  touchedBoardIds(): ReadonlySet<string> {
    const ids = new Set<string>([...Object.keys(this.byBoard), ...this.placementBoards]);
    for (const conn of this.connections) if (conn.boardId) ids.add(conn.boardId);
    for (const clears of Object.values(this.styleClears)) {
      for (const boardId of Object.keys(clears ?? {})) ids.add(boardId);
    }
    for (const m of this.memberships) ids.add(m.boardId);
    return ids;
  }

  /** The Filo's trash entry the item is in now; null while it isn't there (undone). */
  get trashId(): string | null {
    return this.trashed?.trashId ?? null;
  }

  private vaultChanged(verb: string): boolean {
    // A path-STRING compare (not the generation-aware `isStillSameVault`) is
    // enough: a same-path new generation requires a vault OPEN, whose pre-swap
    // hook clears history, so this command can never observe one.
    if (this.vaultRoot && vaultStore.path && vaultStore.path !== this.vaultRoot) {
      uiStore.toast(`Cannot ${verb} the delete: the vault has changed since it ran.`, 'warning', 5000);
      return true;
    }
    return false;
  }

  async execute(): Promise<void> {
    if (this.vaultChanged('redo')) return;
    const redo = this.hasRun;
    this.hasRun = true;
    // A redo moves the item to the trash again first; the first run comes
    // after the caller already moved it. If it can't go, nothing changes and
    // the step stays a redo: counted as done, the next undo would skip the
    // restore and put back placements the boards still hold.
    if (redo && this.itemRel && !this.trashed) {
      // The boards go with the item again: the next undo puts back how they look now.
      for (const boardId of Object.keys(this.boardViews)) {
        this.boardViews[boardId] = this.snapshot(boardCacheStore.boardView(boardId));
      }
      const refused: string[] = [];
      const trashed = await trashFiles(this.vaultRoot, [this.itemRel], 'cascadeDelete.redo', undefined, refused);
      // Another vault opened during the move: its boards aren't this one's.
      if (vaultStore.path !== this.vaultRoot) return;
      if (refused.length > 0) {
        throw new ChangeRefusedError(
          `Couldn't redo the delete: "${this.itemRel}" couldn't be moved to Filo's trash (it may be open in another program). Nothing was changed.`,
        );
      }
      // Already gone from disk: nothing to trash, the placements still go.
      this.trashed = trashed[0] ?? null;
      for (const path of Object.keys(this.fileTags)) fileTagsStore.dropFile(path);
      if (this.clearedPins.length > 0) {
        vaultStore.clearActiveRootFolderIfMatches(this.itemRel);
        boardStore.clearBoardDefaultFolderIfMatches(this.itemRel);
      }
      void vaultStore.enqueueRenameQueueWork(() => vaultStore.refreshTreeAndCleanup());
    }

    // allow-board-store-current: active-vs-cache pivot — the command operates across boards, so we route same-board mutations through the runtime facade and other-board mutations through the cache-only persist path
    const activeId = boardStore.current?.id ?? null;
    for (const [boardId, tiles] of Object.entries(this.byBoard)) {
      for (const tile of tiles) {
        if (boardId === activeId) {
          boardStore.removeTile(tile.id);
        } else {
          boardCacheStore.persistRemoveTile(tile.id);
        }
      }
    }
    // Re-apply style clears on redo. The first run is a no-op because the
    // caller already applied them before history.execute.
    boardCacheStore.applyCascadeStyleClears(this.styleClears);
    clearDefaultImages(this.clearedDefaultImages);
  }

  async undo(): Promise<void> {
    if (this.vaultChanged('undo')) return;

    // The item comes back BEFORE the placements, so a restored tile that
    // reads its note during persistAddTile finds it, and nothing seeds an
    // empty note over the path.
    if (this.trashed) {
      const [restored] = await restoreFiles(this.vaultRoot, [this.trashed], 'cascadeDelete.undo');
      // Still in the trash when the restore failed: keep its id, so a redo
      // doesn't try to trash it again and the next undo retries it.
      if (restored) this.trashed = null;
      if (restored && restored.restoredPath !== restored.rel) {
        // Restored beside a file that took its old name: the tiles, the tags,
        // the pins and a later redo all follow the restored copy.
        this.followRestoredCopy(restored.rel, restored.restoredPath);
      }
      // The folder is back, so its pins and its boards' cameras are too.
      if (restored) {
        restoreClearedPins(this.clearedPins, vaultStore.project?.settings.general, () => vaultStore.markMetaDirty());
        for (const [boardId, view] of Object.entries(this.boardViews)) {
          boardCacheStore.putBackBoardView(boardId, this.snapshot(view));
        }
      }
    }
    for (const [path, tags] of Object.entries(this.fileTags)) {
      fileTagsStore.setFileTags(path, tags);
    }

    // Cards and tasks go back into their column or section from their own
    // snapshot. They carry no seed, so a note that did not come back shows
    // as a broken reference.
    for (const placement of this.placements) void placement.undo();

    // `skipEmptySeed: true` so a text tile whose file did NOT come back
    // doesn't get a blank `.md` seeded under it; the placement comes back
    // pointing at a missing file and the broken-ref UX kicks in.
    // allow-board-store-current: active-vs-cache pivot, mirror of execute()
    const activeId = boardStore.current?.id ?? null;
    for (const [boardId, tiles] of Object.entries(this.byBoard)) {
      if (this.placementBoards.has(boardId)) continue;
      for (const tile of tiles) {
        if (boardId === activeId) {
          void boardStore.addTile(tile, { skipEmptySeed: true });
        } else {
          // Pass the known boardId so the re-add doesn't depend on
          // findBoardIdForTile resolving a tile that isn't in the cache yet.
          void boardCacheStore.persistAddTile(tile, { skipEmptySeed: true }, boardId);
        }
      }
    }
    for (const m of this.memberships) restoreTileMemberships(m);
    // Style fields come back once the placements they live on exist again: a
    // cover image on a card deleted with its folder has nowhere to land
    // before its card is back.
    boardCacheStore.restoreCascadeStyleClears(this.styleClears);
    restoreDefaultImages(this.clearedDefaultImages);
    for (const conn of this.connections) {
      // Skip a restored connection whose endpoint tile no longer exists (e.g.
      // independently removed after this cascade). The tile-restore loop above
      // mutated the cache synchronously, so a null `findTileBoardId` means the
      // edge is dangling and must not persist.
      if (
        !boardCacheStore.findTileBoardId(conn.fromTileId)
        || !boardCacheStore.findTileBoardId(conn.toTileId)
      ) {
        console.warn(
          `[CascadeDeleteCommand.undo] Skipping connection ${conn.id}: endpoint tile missing (dangling edge avoided)`,
        );
        continue;
      }
      if (conn.boardId === activeId) {
        boardStore.addConnection(conn);
      } else {
        boardCacheStore.persistAddConnection(conn);
      }
    }
  }

  private followRestoredCopy(from: string, to: string): void {
    const retarget = (path: string): string => retargetPath(path, from, to);
    this.itemRel = to;
    for (const [boardId, tiles] of Object.entries(this.byBoard)) {
      this.byBoard[boardId] = tiles.map((t) => retargetTile(t, retarget));
    }
    for (const placement of this.placements) placement.renamePath(from, to);
    const tags: Record<string, string[]> = {}; // allow-string-path-key: tags.json fileTags keys
    for (const [path, list] of Object.entries(this.fileTags)) tags[retarget(path)] = list;
    this.fileTags = tags;
    this.clearedPins = this.clearedPins.map((pin) => ({ ...pin, defaultFolder: retarget(pin.defaultFolder) }));
    this.clearedDefaultImages = this.clearedDefaultImages.map((c) => ({ backgroundImage: retarget(c.backgroundImage) }));
  }
}

/** A copy of `tile` whose file reference goes through `retarget`. */
function retargetTile(tile: Tile, retarget: (path: string) => string): Tile {
  const copy = cloneTile(tile);
  if ((copy.type === 'text' || copy.type === 'file') && copy.filePath) {
    copy.filePath = retarget(copy.filePath);
  } else if ((copy.type === 'image' || copy.type === 'video' || copy.type === 'audio') && copy.src) {
    copy.src = retarget(copy.src);
  }
  return copy;
}

/**
 * Merges a partial `settings` patch into the active board. Records the
 * inverse patch (prior values for each affected key) so undo restores exactly
 * the keys that changed — adjacent settings stay untouched even if they were
 * mutated by other commands in between.
 *
 * Keys that were absent in the prior settings restore to `undefined` via
 * `deleteOnUndo`, so undo doesn't leave behind a phantom undefined value.
 */
export class UpdateBoardSettingsCommand extends Command {
  description: string;
  /**
   * The originating board; execute/undo apply to it via the cache (see
   * `applyToTarget`), never to whichever board happens to be active.
   */
  readonly targetBoardId: string;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;
  private deleteOnUndo: string[];

  constructor(
    patch: Record<string, unknown>,
    inversePatch: Record<string, unknown>,
    deleteOnUndo: string[] = [],
    description?: string,
    boardId?: string,
  ) {
    super();
    // Fallback to the currently-active board ID at construction time.
    // Every call site already runs against the active board; explicit
    // capture is the safe move even if the caller forgets to pass it.
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // Deep-clone so nested settings sub-objects (e.g. `defaults.frame`) can't
    // be mutated through the caller's reference after the command is pushed.
    this.patch = this.snapshot(patch);
    this.inversePatch = this.snapshot(inversePatch);
    // allow-shallow: deleteOnUndo is an array of primitive strings.
    this.deleteOnUndo = [...deleteOnUndo];
    this.description = description ?? `Update board settings (${Object.keys(patch).join(', ')})`;
  }

  /**
   * Apply settings to THIS command's board via the cache, not the global
   * `boardStore` facade: on a cross-board undo the pane pivot is async, so the
   * facade could still point at the previously-active board.
   * `updateBoardSettings` replaces that board's cache entry, so the
   * target re-renders whether or not it is the active pane.
   */
  private applyToTarget(patch: Record<string, unknown>, deleteKeys: string[]): void {
    const cached = boardCacheStore.cache[this.targetBoardId];
    if (!cached) {
      // Target board was closed/evicted. Undo stacks file by the GLOBAL active
      // board, so this command can outlive its target; toast rather than
      // silently dropping the undo/redo.
      uiStore.toast('Cannot apply board settings — the target board was deleted.', 'warning', 5000);
      return;
    }
    const current = (cached.board.settings ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...current, ...patch };
    for (const k of deleteKeys) delete merged[k];
    boardCacheStore.updateBoardSettings(this.targetBoardId, merged);
  }

  execute() {
    this.applyToTarget(this.patch, []);
  }

  undo() {
    if (this.inversePatch && Object.keys(this.inversePatch).length === 0 && this.deleteOnUndo.length === 0) {
      return;
    }
    this.applyToTarget(this.inversePatch, this.deleteOnUndo);
  }
}
