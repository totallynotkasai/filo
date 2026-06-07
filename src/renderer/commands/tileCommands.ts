import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import { framesStore } from '../stores/frames.svelte';
import type { Tile, Connection } from '../schema/index';
import { cloneTile } from '../lib/utils/cloneTile';
import { trackComponentWrite } from '../lib/boards/writeStateTracking';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
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
    // Phase 31 B4.4 — `this.snapshot(...)` deep-clones the tile so a later
    // mutation of the caller-side object (e.g. PropertiesPopup mutating
    // `tile.tags` after the command has been pushed) doesn't poison the
    // snapshot used by undo. Shallow `{...tile}` would keep nested fields
    // (position, size, tags array) shared by reference, breaking undo for
    // any mutation that touches those nested slots.
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
 * Phase 31 B5.1 — re-link command. Rebinds a broken-ref tile's backing
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
   * D.3 — re-run broken-ref detection after a relink. The tree itself
   * didn't change, but `boardStore.recomputeBrokenRefs` runs inside
   * `vaultStore.refreshTree` against the current tree snapshot, which
   * is the cheapest way to clear / set the broken-ref badge for the
   * just-rebound tile. Without this, the user's "Re-link" choice
   * succeeds at the data layer but the badge stays put until the next
   * watcher event.
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
    // Phase 31 B4.4 — deep-clone each tile for the same reason as
    // AddTileCommand above. The original `.map(t => ({...t}))` was a
    // shallow per-tile clone that left every nested object aliased.
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
   * Phase 3 / 3.1 (polish plan 2026-05-25) — `restorePlacements` calls
   * `boardStore.addTile(tile)` which targets the currently-active board.
   * Without the guard, a redo after the user switched boards would re-add
   * tiles on the wrong board (or, worse, no-op if a placeholder with the
   * same ID exists). Connections snapshotted from other boards still flow
   * through `boardCacheStore.persistAddConnection`, so they keep working —
   * only the active-board mutations require the originating board match.
   */
  readonly targetBoardId: string;
  private tiles: Tile[] = [];
  private connections: Connection[] = [];
  private fileSnapshots: DeletedFileSnapshot[];
  private vaultRoot: string | undefined;

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
    // Phase 3 / 3.2 — placement removal stays synchronous from the caller's
    // perspective (code before the first `await` runs in the same tick), so
    // existing call sites and tests that immediately assert on
    // `boardStore.getTile(...)` after `execute()` continue to work.
    for (const tile of this.tiles) {
      boardStore.removeTile(tile.id);
    }

    // Audit 4.1 — remove the snapshotted connections symmetrically with
    // `undo()`'s `restorePlacements`. `removeTile`'s cache-side sweep only
    // touches the deleted tile's OWN board cache (and the project mirror),
    // so a cross-board edge (one parked in another board's cache while
    // referencing a deleted tile) — exactly what the all-boards snapshot
    // scan in the constructor captures — would otherwise be re-added by
    // undo and never re-removed by redo, leaving a dangling connection in
    // the inactive board's `.board.json`. Mirror the undo routing: same-
    // board edges through the active facade, other-board edges through the
    // cache-only persist path. Both are safe no-ops when `removeTile`
    // already swept the edge.
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
    // leave the board referencing a half-deleted file.
    //
    // Phase 37 / 37.1 — mirror the undo() shape: collect every delete's
    // promise and surface failures via reportError, but store the combined
    // Promise.allSettled on `lastExecuteCompletion` so tests (and any caller
    // that needs to observe completion before re-execute or redo) can await
    // it.
    //
    // Phase 3 / 3.2 — queue this command's new delete IPC behind any prior
    // delete-IPC or snapshot-write IPC still in flight from an earlier
    // execute()/undo(). A rapid Ctrl+Y / Ctrl+Z would otherwise re-enter
    // execute() with a `vault:write-file-text` from the prior undo still
    // pending on the same path; the new `vault:delete` could win the race
    // and the snapshot restore would resurrect a file the redo just deleted.
    // Both prior promises are `Promise.allSettled` wrappers so awaiting them
    // never rejects.
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
      // Phase 25 L6 — vault:delete takes (vaultRoot, absoluteItemPath).
      // All other callers (vaultFolderOps, dirtyFlagRecovery,
      // tagRewriteSentinel, renameCascadeSentinel) compose the absolute
      // path the same way; keep parity rather than re-shaping just this one.
      const absPath = `${vaultRoot}/${snap.rel}`;
      // Phase R2 — `deleteVaultPath` drains pending writers before the
      // IPC so a debounced editor write can't fire against `snap.rel`
      // after we delete it. The upstream `performDeleteSelected` /
      // `performDeleteTile` already drained when reading the snapshot;
      // the re-entrancy guard inside `withDrainedWrites` collapses this
      // inner drain to a no-op.
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
    // returns true by the time the seed-check runs, so no double-write.
    //
    // The trade-off is a ~50-200 ms delay between Ctrl+Z and the tile
    // reappearing. That's acceptable — the alternative is silent
    // corruption of the very content the user pressed Ctrl+Z to recover.
    //
    // Snapshots-absent path: skip the await; restore placements
    // synchronously to preserve the pre-P0-18 zero-latency feel.
    //
    // Polish phase 2.1 — `undo()` was previously sync and assigned the
    // `undoWithSnapshot` Promise to `lastUndoCompletion` without awaiting
    // it. That left the snapshot-restore race-prone for any caller that
    // assumed `await command.undo()` covered the full restore — notably
    // BatchCommand's rollback (Phase 2.2) and a tab-close racing against
    // an in-flight undo. Marking the method `async` and awaiting the
    // inner promise makes the contract honest; `lastUndoCompletion` is
    // still tracked so a redo can sequence behind a pending undo
    // independently of the caller.
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
      const writeP = trackComponentWrite(vaultRoot, rel, async () => {
        // allow-direct-write: one-shot snapshot-restore on tile-delete
        // undo — the file no longer exists on disk, mkdir -p semantics
        // are required, and the tile will mount + hydrate the gateway
        // immediately after.
        return invokeOk('vault:write-file-text', vaultRoot, rel, content);
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
    for (const tile of this.tiles) {
      boardStore.addTile(tile);
    }
    for (const conn of this.connections) {
      // DI-2 (2026-05-29): skip a restored connection whose endpoint tile no
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
   * Phase 37 / 37.1 — last `execute()`'s combined delete-IPC promise. Tests
   * await this to observe that every `vault:delete` settled (success or
   * failure surfaced through reportError) before redo/undo runs again.
   * Resolves immediately when no snapshots were provided.
   */
  lastExecuteCompletion: Promise<unknown> = Promise.resolve();

  /**
   * Phase 3 / 3.8 — opts the command into the escalated history-truncation
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
   * Phase 6 / 6.1 — pre-move snapshot of frame containment for every frame
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
      // Sprint C / C22 — symmetric with the undo toast at the bottom of
      // this class. Redo'ing a move after the user deleted one of the
      // moved tiles out-of-band silently no-ops on the missing tiles
      // pre-Sprint-C; the toast surfaces the divergence so the user
      // knows their redo didn't fully restore the move.
      uiStore.toast(
        `Redo skipped ${missing} tile(s) that were deleted out-of-band.`,
        'warning',
        4000,
      );
    }
    // Phase 6 / 6.1 — keep frame containment in sync on redo. The initial
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
    // Phase 6 / 6.1 — restore the pre-move frame containment snapshot,
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
    boardStore.updateTile(this.tileId, { size: { ...this.afterSize } });
  }

  undo() {
    boardStore.updateTile(this.tileId, { size: { ...this.beforeSize } });
  }
}

export class UpdateTileStyleCommand extends Command {
  description: string;
  /**
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — flagged as a P1-5 site by
   * the audit. Style popups capture this at popup-mount time and thread
   * it through to the command; the popup's destroy effect fires after a
   * board switch, and without the guard the command would mutate
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
    // Phase R3 — deep-clone so nested style objects (background, border)
    // can't be mutated through the original reference after the command
    // is pushed.
    this.beforeUpdates = this.snapshot(beforeUpdates);
    this.afterUpdates = this.snapshot(afterUpdates);
    this.description = `Update tile style`;
  }

  execute() {
    boardStore.updateTile(this.tileId, this.afterUpdates);
  }

  undo() {
    boardStore.updateTile(this.tileId, this.beforeUpdates);
  }
}

/**
 * Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — undoable alt-text edits on
 * image tiles. Pre-Phase-7 the ImageTile commit handler called
 * `boardStore.updateTile` directly, so Ctrl+Z silently no-op'd over an
 * alt-text change. The field affects screen-reader output, so losing it
 * to an accidental edit is a real a11y regression — wrap it in a
 * command exactly like the src/url/filePath swaps already wrapped via
 * `UpdateAttachmentSrcCommand`.
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
    boardStore.updateTile(this.tileId, { alt: this.after } as Partial<Tile>);
  }

  undo() {
    boardStore.updateTile(this.tileId, { alt: this.before } as Partial<Tile>);
  }
}

/**
 * Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — undoable timer mode +
 * duration edits. `cycleMode`, `setDuration`, and `applyCustomInput`
 * all rewrote the tile's `mode` / `duration` / `remaining` / `isRunning`
 * fields directly via `boardStore.updateTile`, silently no-op'ing
 * Ctrl+Z. The transient `remaining` countdown and `isRunning` toggle
 * are deliberately NOT wrapped (they fire on every tick / play / pause
 * and would blow through MAX_HISTORY); only the *configuration* changes
 * — switching modes, setting durations — pass through this command.
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
    boardStore.updateTile(this.tileId, {
      mode: this.after.mode,
      duration: this.after.duration,
      remaining: this.after.remaining,
      isRunning: this.after.isRunning,
    } as Partial<Tile>);
  }

  undo() {
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
 * Phase 7 / 7.7 — generic "fade these tiles" undoable. Snapshots each
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
