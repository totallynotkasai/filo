import { Command } from './Command';
import { toastMissingUndoRedoTarget } from './missingTargetToast';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import { framesStore } from '../stores/frames.svelte';
import type { Tile, Connection } from '../schema/index';
import { cloneTile } from '../lib/utils/cloneTile';
import { DeleteCardCommand } from './kanbanCommands';
import { reportError } from '../lib/utils/errorBus';
import { writeMarkdownAndReconcile } from '../lib/vault/syncOpenEditorsAfterDiskMutation';
import { deleteVaultPath } from '../lib/vault/vaultOperations';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';

/**
 * Snapshot of a single backing file captured at delete time so a subsequent
 * `undo()` can write the content back to disk before re-resolving placements.
 * `rel` is vault-relative. Snapshots are only captured for tiles whose
 * "Delete associated files" path runs — out-of-band file deletes are still
 * surfaced via the broken-ref toast at the bottom of `undo()`.
 */
export interface DeletedFileSnapshot {
  rel: string;
  content: string;
}

/**
 * Returns the vault-relative file path a tile is backed by, if any.
 * Text tiles use `filePath` (with `${title}.md` fallback); image / video /
 * audio tiles use `src`; file tiles use `filePath`.
 */
function getTileFileRef(tile: Tile): string | null {
  const t = tile as Tile & Record<string, unknown>;
  if (tile.type === 'text') {
    const explicit = t.filePath as string | undefined;
    if (explicit && explicit.length > 0) return explicit;
    return tile.title ? `${tile.title}.md` : null;
  }
  if (tile.type === 'file') {
    const fp = t.filePath as string | undefined;
    return fp && fp.length > 0 ? fp : null;
  }
  if (tile.type === 'image' || tile.type === 'video' || tile.type === 'audio') {
    const src = t.src as string | undefined;
    if (!src || src.length === 0) return null;
    // External URLs aren't vault refs; skip them.
    if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return null;
    return src;
  }
  return null;
}

// ── Tile Commands ──

export class AddTileCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tile: Tile;

  constructor(tile: Tile, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // Deep-clone so a later mutation of the caller-side object (e.g. nested
    // position / size / tags) can't poison the snapshot used by undo.
    this.tile = this.snapshot(tile);
    this.description = `Add tile "${tile.title}"`;
  }

  execute() {
    boardStore.addTile(this.tile);
  }

  undo() {
    boardStore.removeTile(this.tile.id);
  }
}

/**
 * Re-link command. Rebinds a broken-ref tile's backing
 * file path. The field depends on the tile type:
 *  - text / file → `filePath`
 *  - image / video / audio → `src`
 *
 * Both old and new values are captured at construction so undo restores
 * the previous binding (typically the original broken path so the user
 * can re-attempt the re-link without losing the breadcrumb).
 */
export class UpdateTilePathCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private oldPath: string;
  private newPath: string;

  constructor(tileId: string, oldPath: string, newPath: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    this.oldPath = oldPath;
    this.newPath = newPath;
    this.description = 'Re-link tile';
  }

  private apply(path: string): void {
    const tile = boardStore.getTile(this.tileId);
    if (!tile) return;
    const type = tile.type;
    if (type === 'text' || type === 'file') {
      boardStore.updateTile(this.tileId, { filePath: path } as Partial<Tile>);
    } else if (type === 'image' || type === 'video' || type === 'audio') {
      boardStore.updateTile(this.tileId, { src: path } as Partial<Tile>);
    }
  }

  /**
   * Re-run broken-ref detection after a relink (via `refreshTree`, the
   * cheapest path to `recomputeBrokenRefs`). Without this the badge stays
   * put until the next watcher event.
   */
  private async refreshBrokenRefs(): Promise<void> {
    try {
      await vaultStore.refreshTree();
    } catch (err) {
      // refreshTree already routes its own failures through reportError;
      // swallow here so the command's execute/undo don't reject on a
      // tree-refresh failure unrelated to the relink itself.
      void err;
    }
  }

  async execute() {
    this.apply(this.newPath);
    await this.refreshBrokenRefs();
  }

  async undo() {
    this.apply(this.oldPath);
    await this.refreshBrokenRefs();
  }
}

export class AddTilesCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tiles: Tile[];

  constructor(tiles: Tile[], description?: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // Deep-clone each tile for the same reason as AddTileCommand above.
    this.tiles = tiles.map((t) => this.snapshot(t));
    this.description = description ?? `Insert ${this.tiles.length} tile(s)`;
  }

  execute() {
    for (const tile of this.tiles) {
      boardStore.addTile(tile);
    }
  }

  undo() {
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const t = this.tiles[i];
      if (t) boardStore.removeTile(t.id);
    }
  }
}

export interface DeleteTilesOptions {
  /**
   * Pre-read snapshots of backing files. Provided only when the user opted
   * into "Delete associated files from vault" — the dialog reads file
   * contents before the command is constructed so undo can write them back.
   */
  fileSnapshots?: DeletedFileSnapshot[];
  /** Required if `fileSnapshots` is non-empty. */
  vaultRoot?: string;
}

export class DeleteTilesCommand extends Command {
  description: string;
  /**
   * `restorePlacements` calls `boardStore.addTile(tile)`, which targets the
   * active board, so the history guard must refuse an undo/redo after the
   * user switched boards. Other-board connections go through the cache path
   * and don't need it.
   */
  readonly targetBoardId: string;
  private tiles: Tile[] = [];
  private connections: Connection[] = [];
  private fileSnapshots: DeletedFileSnapshot[];
  private vaultRoot: string | undefined;
  /**
   * On a Kanban board, one card snapshot per tile (column, neighbour anchor,
   * card style). Kanban's addTile restores only the definition, so undo goes
   * through these to put each card back where it was.
   */
  private kanbanCards: DeleteCardCommand[] = [];

  constructor(tileIds: string[], options: DeleteTilesOptions = {}) {
    super();
    this.description = `Delete ${tileIds.length} tile(s)`;
    // allow-shallow: DeletedFileSnapshot is flat { rel, content }; nested
    // fields are primitives so the per-entry spread is sufficient.
    this.fileSnapshots = options.fileSnapshots ? options.fileSnapshots.map((s) => ({ ...s })) : [];
    this.vaultRoot = options.vaultRoot;
    this.targetBoardId = boardStore.current?.id ?? '';
    // Snapshot tiles using cloneTile (shares large string references to save memory)
    for (const id of tileIds) {
      const tile = boardStore.getTile(id);
      if (tile) this.tiles.push(cloneTile(tile));
    }
    if (boardCacheStore.cache[this.targetBoardId]?.board.type === 'kanban') {
      this.kanbanCards = this.tiles.map((t) => new DeleteCardCommand(this.targetBoardId, t.id));
    }
    // Snapshot connections that reference any of these tiles, across EVERY
    // loaded board's cache — not just the active board. `this.snapshot(...)`
    // (JSON round-trip, NOT structuredClone — Svelte 5 $state Proxies throw
    // DataCloneError) detaches the nested `label` so later label.text /
    // label.textColor mutations don't leak into the snapshot.
    const tileIdSet = new Set(tileIds);
    const seen = new Set<string>();
    for (const data of Object.values(boardCacheStore.cache)) {
      for (const conn of Object.values(data.connections ?? {})) {
        const c = conn as Connection;
        if (seen.has(c.id)) continue;
        if (tileIdSet.has(c.fromTileId) || tileIdSet.has(c.toTileId)) {
          this.connections.push(this.snapshot(c));
          seen.add(c.id);
        }
      }
    }
  }

  async execute() {
    // Placement removal stays synchronous (before the first `await`), so
    // callers that immediately assert on `boardStore.getTile(...)` still work.
    for (const tile of this.tiles) {
      boardStore.removeTile(tile.id);
    }

    // Remove the snapshotted connections symmetrically with `undo()`.
    // `removeTile` only sweeps the tile's OWN board cache, so a cross-board
    // edge would otherwise be re-added by undo and never re-removed by redo.
    // Same routing as undo; both paths no-op if the edge is already gone.
    // allow-board-store-current: active-vs-cache pivot for cross-board connections
    const activeId = boardStore.current?.id ?? null;
    for (const conn of this.connections) {
      if (conn.boardId === activeId) {
        boardStore.removeConnection(conn.id);
      } else {
        boardCacheStore.persistRemoveConnection(conn.id, conn);
      }
    }

    // File deletes are owned by the command so the snapshot stored on the
    // instance is the same one that gets restored by undo(). Sequenced after
    // the synchronous placement removal so a write-error mid-execute can't
    // leave the board referencing a half-deleted file. The combined promise is
    // stored on `lastExecuteCompletion` so callers can await completion.
    //
    // Queue behind any prior execute()/undo() IPC still in flight: a rapid
    // Ctrl+Y / Ctrl+Z could otherwise let the prior undo's restore write land
    // after this delete and resurrect the file. Both priors are allSettled
    // wrappers, so awaiting them never rejects.
    if (this.vaultRoot && this.fileSnapshots.length > 0) {
      const vaultRoot = this.vaultRoot;
      const prior = Promise.allSettled([this.lastExecuteCompletion, this.lastUndoCompletion]);
      this.lastExecuteCompletion = prior.then(() => this.executeFileDeletes(vaultRoot));
    } else {
      this.lastExecuteCompletion = Promise.resolve();
    }
    await this.lastExecuteCompletion;
  }

  private async executeFileDeletes(vaultRoot: string): Promise<void> {
    const promises = this.fileSnapshots.map((snap) => {
      // vault:delete takes (vaultRoot, absoluteItemPath).
      const absPath = `${vaultRoot}/${snap.rel}`;
      // `deleteVaultPath` drains pending writers first so a debounced editor
      // write can't fire against `snap.rel` after the delete (a no-op here if
      // the caller already drained).
      return deleteVaultPath(vaultRoot, absPath)
        .then(
          (result) => {
            // `deleteVaultPath` returns the success envelope verbatim;
            // ENOENT is reported as `{ success: false, code: 'ENOENT' }`
            // — desired state, suppress.
            if (!result.success && result.code !== 'ENOENT') {
              reportError(
                'deleteTiles.execute',
                new Error(result.error ?? 'vault:delete returned !success'),
                `Failed to delete ${snap.rel}`,
              );
            }
          },
          (err) => {
            if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') return;
            reportError('deleteTiles.execute', err, `Failed to delete ${snap.rel}`);
          },
        );
    });
    await Promise.allSettled(promises);
  }

  async undo(): Promise<void> {
    // Snapshots-present path: write file bodies BEFORE restoring placements.
    // boardStore.addTile routes through `persistAddTile`, which seeds an
    // empty `.md` when the backing file isn't on disk. If we restored
    // placements first, the seed would race with (or overwrite) our snapshot
    // write. Awaiting snapshot writes first guarantees `vault:file-exists`
    // returns true by the time the seed-check runs. The cost is a ~50-200 ms
    // delay before the tile reappears — better than corrupting the content
    // the user pressed Ctrl+Z to recover.
    //
    // Snapshots-absent path: restore placements synchronously.
    //
    // `await command.undo()` covers the full restore (BatchCommand rollback
    // relies on it); `lastUndoCompletion` also lets a redo sequence behind a
    // pending undo.
    if (this.vaultRoot && this.fileSnapshots.length > 0) {
      this.lastUndoCompletion = this.undoWithSnapshot(this.vaultRoot);
      await this.lastUndoCompletion;
    } else {
      this.restorePlacements();
      this.surfaceMissingFileToast();
      this.lastUndoCompletion = Promise.resolve();
    }
  }

  private async undoWithSnapshot(vaultRoot: string): Promise<void> {
    const writePromises: Promise<unknown>[] = [];
    for (const snap of this.fileSnapshots) {
      const rel = snap.rel;
      const content = snap.content;
      // Route through the coupled write+reconcile helper: the restored `.md`
      // may be open in an editor elsewhere whose stale cache would invert this
      // restore on its next save. `mode: 'full'` reloads that editor for the
      // SAME path; `create: true` recreates the deleted file.
      const writeP = writeMarkdownAndReconcile({
        vaultRoot,
        path: rel,
        content,
        mode: 'full',
        create: true,
      }).catch((err) => {
        uiStore.toast(
          `Tile restored but file content could not be recovered: ${rel}`,
          'error',
          6000,
        );
        reportError('deleteTiles.undo', err, `Failed to restore ${rel}`);
      });
      writePromises.push(writeP);
    }
    await Promise.allSettled(writePromises);
    // Snapshot writes are done (or settled with failure). Restore the
    // placements now — persistAddTile's file-exists check will see the
    // file we just wrote and skip the empty-seed path.
    this.restorePlacements();
  }

  private restorePlacements(): void {
    if (this.kanbanCards.length > 0) {
      // Last card first: each card's anchor is the sibling that followed it,
      // which may itself be one of the deleted cards.
      for (const card of [...this.kanbanCards].reverse()) card.undo();
    } else {
      for (const tile of this.tiles) {
        boardStore.addTile(tile);
      }
    }
    for (const conn of this.connections) {
      // Skip a restored connection whose endpoint tile no
      // longer exists — it was independently deleted between this delete and
      // the undo, so re-adding the edge would leave a dangling connection.
      // The tile-restore loop above has already mutated the cache synchronously,
      // so `findTileBoardId` reflects both restored and pre-existing endpoints.
      if (
        !boardCacheStore.findTileBoardId(conn.fromTileId)
        || !boardCacheStore.findTileBoardId(conn.toTileId)
      ) {
        console.warn(
          `[DeleteTilesCommand.undo] Skipping connection ${conn.id}: endpoint tile missing (dangling edge avoided)`,
        );
        continue;
      }
      // Connections on the active board flow through the active-state path;
      // connections on other boards need the cache-only persist path so they
      // don't accidentally land on the currently focused board's runtime
      // state.
      // allow-board-store-current: active-vs-cache pivot for restored connections
      const activeId = boardStore.current?.id ?? null;
      if (conn.boardId === activeId) {
        boardStore.addConnection(conn);
      } else {
        boardCacheStore.persistAddConnection(conn);
      }
    }
  }

  private surfaceMissingFileToast(): void {
    // Detect restored tiles whose backing files no longer exist. The user
    // probably deleted the file out-of-band between the delete and the
    // undo; we surface a single toast so the silent-restore-with-broken-ref
    // doesn't go unnoticed. Only fires on the no-snapshot path — when
    // snapshots are provided the body has already been restored (or the
    // write-failure toast has fired), so re-flagging here would be noise.
    const missing: string[] = [];
    for (const tile of this.tiles) {
      const ref = getTileFileRef(tile);
      if (!ref) continue;
      if (!vaultIndexStore.getMetadata(ref) && !boardStore.isBrokenTile(tile.id)) {
        // For non-.md refs the index won't know; fall back to broken-ref
        // tracking already maintained by boardRefIntegrity on the next
        // tree refresh.
        if (ref.toLowerCase().endsWith('.md')) {
          missing.push(tile.title || tile.id);
        }
      }
    }
    if (missing.length > 0) {
      const sample = missing.slice(0, 3).join(', ');
      const more = missing.length > 3 ? `, +${missing.length - 3} more` : '';
      uiStore.toast(
        `${missing.length} restored tile(s) reference missing files (${sample}${more}). Check the broken-ref badge or Recovery Files.`,
        'warning',
        6000,
      );
    }
  }

  /**
   * Last `undo()`'s combined completion promise. Tests await this to
   * observe `failedVaultPaths` / toast effects and the post-await
   * placement restore. Settled when every snapshot's IPC has resolved
   * (success or failure) and the placements have been re-added. Resolves
   * immediately when no snapshots existed.
   */
  lastUndoCompletion: Promise<unknown> = Promise.resolve();
  /**
   * Last `execute()`'s combined delete-IPC promise. Tests
   * await this to observe that every `vault:delete` settled (success or
   * failure surfaced through reportError) before redo/undo runs again.
   * Resolves immediately when no snapshots were provided.
   */
  lastExecuteCompletion: Promise<unknown> = Promise.resolve();

  /**
   * Opts the command into the escalated history-truncation
   * toast. True when this command holds the only copy of one or more
   * deleted file bodies, so dropping the command off the undo stack means
   * those file contents become irrecoverable.
   */
  hasFileSnapshots(): boolean {
    return this.fileSnapshots.length > 0;
  }
}

export class MoveTilesCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private positions: Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>;
  /**
   * Pre-move snapshot of frame containment for every frame
   * that held one of the moved tiles. `tileDrag.ts` pushes the command
   * BEFORE running its post-drag `framesStore.syncTileMembership`, so this
   * read still sees the BEFORE state. On undo we restore those entries and
   * re-run sync per moved tile so containment matches the restored
   * positions.
   */
  private frameTileIdsBefore: Map<string, string[]>;

  constructor(
    positions: Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: Map values are `{ before: {x,y}, after: {x,y} }` —
    // primitives all the way down, so the Map copy detaches enough.
    this.positions = new Map(positions);
    this.description = `Move ${positions.size} tile(s)`;
    const movedIds = new Set(positions.keys());
    this.frameTileIdsBefore = new Map();
    for (const f of boardStore.frames) {
      if (f.tileIds.some((id) => movedIds.has(id))) {
        this.frameTileIdsBefore.set(f.id, [...f.tileIds]);
      }
    }
  }

  execute() {
    let missing = 0;
    for (const [id, { after }] of this.positions) {
      if (!boardStore.getTile(id)) { missing++; continue; }
      boardStore.updateTile(id, { position: { ...after } });
    }
    if (missing > 0) {
      console.warn(`[MoveTilesCommand.execute] Skipped ${missing} tile(s) that no longer exist`);
      // Symmetric with the undo toast: tell the user the redo didn't fully
      // restore the move because some tiles were deleted out-of-band.
      uiStore.toast(
        `Redo skipped ${missing} tile(s) that were deleted out-of-band.`,
        'warning',
        4000,
      );
    }
    // Keep frame containment in sync on redo. The initial
    // drag's external syncTileMembership covered the first commit, but
    // redo doesn't replay that external pass.
    for (const id of this.positions.keys()) {
      framesStore.syncTileMembership(id);
    }
  }

  undo() {
    let missing = 0;
    for (const [id, { before }] of this.positions) {
      if (!boardStore.getTile(id)) { missing++; continue; }
      boardStore.updateTile(id, { position: { ...before } });
    }
    if (missing > 0) {
      console.warn(`[MoveTilesCommand.undo] Skipped ${missing} tile(s) that no longer exist`);
      uiStore.toast(
        `Undo skipped ${missing} tile(s) that were deleted out-of-band.`,
        'warning',
        4000,
      );
    }
    // Restore the pre-move frame containment snapshot,
    // then re-run syncTileMembership for each moved tile so any tile
    // deleted out-of-band (filtered above) is also pruned from frames.
    const existingFrameIds = new Set(boardStore.frames.map((f) => f.id));
    for (const [frameId, tileIds] of this.frameTileIdsBefore) {
      if (!existingFrameIds.has(frameId)) continue;
      // Filter out tile IDs whose tiles no longer exist so the restore
      // doesn't resurrect stale refs.
      const filtered = tileIds.filter((id) => !!boardStore.getTile(id));
      boardStore.updateFrame(frameId, { tileIds: filtered });
    }
    for (const id of this.positions.keys()) {
      framesStore.syncTileMembership(id);
    }
  }
}

export class ResizeTileCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private beforeSize: { width: number; height: number };
  private afterSize: { width: number; height: number };

  constructor(
    tileId: string,
    beforeSize: { width: number; height: number },
    afterSize: { width: number; height: number },
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    // allow-shallow: { width, height } are primitives.
    this.beforeSize = { ...beforeSize };
    this.afterSize = { ...afterSize };
    this.description = `Resize tile`;
  }

  execute() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('redo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, { size: { ...this.afterSize } });
  }

  undo() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('undo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, { size: { ...this.beforeSize } });
  }
}

export class UpdateTileStyleCommand extends Command {
  description: string;
  /**
   * Style popups capture this at popup-mount time: the popup's destroy effect
   * can fire after a board switch, and without it the command would mutate
   * whichever board is active at that point.
   */
  readonly targetBoardId: string;
  private tileId: string;
  private beforeUpdates: Partial<Tile>;
  private afterUpdates: Partial<Tile>;

  constructor(
    tileId: string,
    beforeUpdates: Partial<Tile>,
    afterUpdates: Partial<Tile>,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    // Deep-clone so nested style objects (background, border)
    // can't be mutated through the original reference after the command
    // is pushed.
    this.beforeUpdates = this.snapshot(beforeUpdates);
    this.afterUpdates = this.snapshot(afterUpdates);
    this.description = `Update tile style`;
  }

  execute() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('redo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, this.afterUpdates);
  }

  undo() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('undo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, this.beforeUpdates);
  }
}

/**
 * Undoable alt-text edits on image tiles. The field affects screen-reader
 * output, so an accidental edit must be recoverable with Ctrl+Z.
 */
export class UpdateImageAltCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private before: string | undefined;
  private after: string | undefined;

  constructor(
    tileId: string,
    before: string | undefined,
    after: string | undefined,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    // Primitive string snapshot — no nested references to clone.
    // allow-shallow: alt is a primitive string | undefined.
    this.before = before;
    this.after = after;
    this.description = 'Update image alt text';
  }

  execute() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('redo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, { alt: this.after } as Partial<Tile>);
  }

  undo() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('undo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, { alt: this.before } as Partial<Tile>);
  }
}

/**
 * Undoable timer mode + duration edits (`cycleMode`, `setDuration`,
 * `applyCustomInput`). The transient `remaining` countdown and `isRunning`
 * toggle are deliberately NOT wrapped (they fire on every tick / play / pause
 * and would blow through MAX_HISTORY); only configuration changes are.
 */
export type TimerMode = 'hms' | 'ms' | 's' | 'clock';
export interface TimerConfigSnapshot {
  mode: TimerMode;
  duration: number;
  remaining: number;
  isRunning: boolean;
}

export class UpdateTimerConfigCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private before: TimerConfigSnapshot;
  private after: TimerConfigSnapshot;

  constructor(
    tileId: string,
    before: TimerConfigSnapshot,
    after: TimerConfigSnapshot,
    description?: string,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    // allow-shallow: snapshot is a flat object of primitives.
    this.before = { ...before };
    this.after = { ...after };
    this.description = description ?? 'Update timer';
  }

  execute() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('redo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, {
      mode: this.after.mode,
      duration: this.after.duration,
      remaining: this.after.remaining,
      isRunning: this.after.isRunning,
    } as Partial<Tile>);
  }

  undo() {
    if (!boardStore.getTile(this.tileId)) { toastMissingUndoRedoTarget('undo', 'the tile'); return; }
    boardStore.updateTile(this.tileId, {
      mode: this.before.mode,
      duration: this.before.duration,
      remaining: this.before.remaining,
      isRunning: this.before.isRunning,
    } as Partial<Tile>);
  }
}

// ── Align / Layout Commands ──

export class AlignTilesCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private positionMap: Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>;

  constructor(
    positionMap: Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: Map values are `{ before: {x,y}, after: {x,y} }` —
    // primitives only.
    this.positionMap = new Map(positionMap);
    this.description = `Align ${positionMap.size} tile(s)`;
  }

  execute() {
    boardStore.batchUpdateTiles(
      [...this.positionMap.entries()]
        .filter(([id]) => boardStore.getTile(id))
        .map(([id, { after }]) => ({ id, changes: { position: { ...after } } })),
    );
  }

  undo() {
    boardStore.batchUpdateTiles(
      [...this.positionMap.entries()]
        .filter(([id]) => boardStore.getTile(id))
        .map(([id, { before }]) => ({ id, changes: { position: { ...before } } })),
    );
  }
}

export class LayoutTilesCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private positionMap: Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>;

  constructor(
    positionMap: Map<string, { before: { x: number; y: number }; after: { x: number; y: number } }>,
    description?: string,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: Map values are primitives-only `{ before: {x,y}, after: {x,y} }`.
    this.positionMap = new Map(positionMap);
    this.description = description || `Layout ${positionMap.size} tile(s)`;
  }

  execute() {
    boardStore.batchUpdateTiles(
      [...this.positionMap.entries()]
        .filter(([id]) => boardStore.getTile(id))
        .map(([id, { after }]) => ({ id, changes: { position: { ...after } } })),
    );
  }

  undo() {
    boardStore.batchUpdateTiles(
      [...this.positionMap.entries()]
        .filter(([id]) => boardStore.getTile(id))
        .map(([id, { before }]) => ({ id, changes: { position: { ...before } } })),
    );
  }
}

// ── Tag Fade Command ──

/**
 * Generic "fade these tiles" undoable. Snapshots each
 * tile's prior `faded` flag so undo restores the mixed state exactly even
 * if the caller mixed already-faded and unfaded tiles into the same call.
 * Used by `SideToolbar.svelte`'s "Fade Selected" action.
 *
 * The tag-name variant (`ToggleTagFadeCommand`) wraps this with a
 * descriptive label that mentions the tag — keep both for the existing
 * "Fade by tag" UX, but route the bare "Fade Selected" gesture through
 * this generic class.
 */
export class ToggleFadeCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileIds: string[];
  private targetFaded: boolean;
  private previousStates: Map<string, boolean>;

  constructor(tileIds: string[], targetFaded: boolean, description?: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: tileIds are primitive strings.
    this.tileIds = [...tileIds];
    this.targetFaded = targetFaded;
    this.description = description
      ?? `${targetFaded ? 'Fade' : 'Unfade'} ${tileIds.length} tile(s)`;
    this.previousStates = new Map();
    for (const id of tileIds) {
      const tile = boardStore.getTile(id);
      if (tile) this.previousStates.set(id, tile.faded);
    }
  }

  execute() {
    boardStore.batchUpdateTiles(
      this.tileIds
        .filter((id) => boardStore.getTile(id))
        .map((id) => ({ id, changes: { faded: this.targetFaded } })),
    );
  }

  undo() {
    boardStore.batchUpdateTiles(
      this.tileIds
        .filter((id) => boardStore.getTile(id))
        .map((id) => ({ id, changes: { faded: this.previousStates.get(id) ?? false } })),
    );
  }
}

/**
 * Toggles `locked` on a set of tiles. Snapshots each tile's prior lock state
 * so undo restores per-tile state, not a flat boolean — important when the
 * selection contains a mix of locked and unlocked tiles (in which case the
 * forward action locks them all, and undo must restore the mixed state).
 */
export class ToggleLockCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private previousStates: Map<string, boolean>;
  private nextLocked: boolean;

  constructor(previousStates: Map<string, boolean>, nextLocked: boolean, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: Map values are primitive booleans.
    this.previousStates = new Map(previousStates);
    this.nextLocked = nextLocked;
    this.description = nextLocked
      ? `Lock ${previousStates.size} tile(s)`
      : `Unlock ${previousStates.size} tile(s)`;
  }

  execute() {
    const updates: Array<{ id: string; changes: Partial<Tile> }> = [];
    for (const id of this.previousStates.keys()) {
      updates.push({ id, changes: { locked: this.nextLocked } });
    }
    boardStore.batchUpdateTiles(updates);
  }

  undo() {
    const updates: Array<{ id: string; changes: Partial<Tile> }> = [];
    for (const [id, prev] of this.previousStates.entries()) {
      updates.push({ id, changes: { locked: prev } });
    }
    boardStore.batchUpdateTiles(updates);
  }
}

/**
 * Toggles `frameless` (media-only display) on a set of tiles. Snapshots each
 * tile's prior frameless flag so undo restores a mixed selection exactly —
 * same contract as `ToggleFadeCommand`.
 *
 * Only meaningful for media tile types (image / video / audio / file); the
 * "Hide frame" button in TileHeader is gated to those types, but the command
 * stays type-agnostic so a future multi-select gesture can route through it
 * unchanged.
 */
export class ToggleFramelessCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileIds: string[];
  private targetFrameless: boolean;
  private previousStates: Map<string, boolean>;

  constructor(tileIds: string[], targetFrameless: boolean, description?: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: tileIds are primitive strings.
    this.tileIds = [...tileIds];
    this.targetFrameless = targetFrameless;
    this.description = description
      ?? `${targetFrameless ? 'Hide frame on' : 'Show frame on'} ${tileIds.length} tile(s)`;
    this.previousStates = new Map();
    for (const id of tileIds) {
      const tile = boardStore.getTile(id);
      if (tile) this.previousStates.set(id, tile.frameless === true);
    }
  }

  execute() {
    boardStore.batchUpdateTiles(
      this.tileIds
        .filter((id) => boardStore.getTile(id))
        .map((id) => ({ id, changes: { frameless: this.targetFrameless } })),
    );
  }

  undo() {
    boardStore.batchUpdateTiles(
      this.tileIds
        .filter((id) => boardStore.getTile(id))
        .map((id) => ({ id, changes: { frameless: this.previousStates.get(id) ?? false } })),
    );
  }
}
