import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { uiStore } from '../stores/ui.svelte';
import type { CascadeStyleClears } from '../stores/boardCacheFrontmatter';
import type { Tile, Connection, TileGroup } from '../schema/index';
import { cloneTile } from '../lib/utils/cloneTile';
import { reportError } from '../lib/utils/errorBus';
import { trackComponentWrite } from '../lib/boards/boardSaver';
import { invokeOk } from '../lib/utils/invokeOk';
import { noteStore } from '../stores/notes.svelte';

/**
 * Opens the inconsistent-state modal when one or more rollback children threw
 * inside `BatchCommand`. A toast is too easy to miss for a half-applied state,
 * so a danger modal forces acknowledgement; the user should typically close
 * without saving.
 */
function openBatchRollbackFailureModal(
  batchDescription: string,
  failures: { description: string; phase: 'execute' | 'undo' }[],
): void {
  const summary = failures
    .map((f) => `• ${f.description} (${f.phase})`)
    .join('\n');
  const direction = failures[0]?.phase === 'undo' ? 'undo' : 'forward';
  uiStore.openConfirm({
    title: 'Inconsistent state',
    body:
      `"${batchDescription}" was partially applied and could not be fully rolled back during ${direction}.\n\n` +
      `Failed steps:\n${summary}\n\n` +
      'Consider closing without saving to avoid persisting the half-applied state.',
    confirmLabel: 'Acknowledge',
    danger: true,
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

/**
 * Cascade-delete: a vault file was removed (in OS Explorer, by git, or in
 * the in-app sidebar) and every dependent placement across every board has
 * to follow. Snapshots tiles per-board so undo restores cache state for
 * inactive boards as well as runtime state for the active one.
 *
 * Notes:
 *   - The backing file is already gone, so this command does NOT restore
 *     file bodies (that's `DeleteTilesCommand`'s file-snapshot branch,
 *     which only applies to in-app "delete with files" gestures).
 *   - The undo entry lands on whatever board is active at cascade time. A
 *     truly cross-board undo isn't possible with the current per-board
 *     history model — but restoring placements on inactive boards is still
 *     correct, and switching to that board after undo will show them.
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
  /**
   * Vault-relative .md path → file body captured BEFORE the delete removed
   * the file. Undo writes each back so restored placements point at content
   * instead of a broken-ref badge. Files over the 25 MB cap (enforced in
   * `vaultFolderOps.delete`) are absent; the user was already warned.
   */
  private fileSnapshots: Record<string, string>;
  /**
   * Vault-relative media path → base64 body captured BEFORE the delete,
   * written back on undo via `vault:write-file-binary`. Capped at
   * `TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES` (5 MB) per file upstream;
   * oversized media are absent and the user was already warned.
   */
  private mediaSnapshots: Record<string, string>;
  private vaultRoot: string;
  /**
   * Style-clears applied when the cascade ran (Kanban `coverImage`, frame
   * `style.backgroundImage`, mindmap `defaults.frame.backgroundImage` that
   * pointed at the file), each with its `matchedPath`. Without this, undo
   * restores the placements but the style fields stay wiped.
   */
  private styleClears: CascadeStyleClears;

  constructor(
    byBoard: Record<string, Tile[]>,
    connections: Connection[],
    fileSnapshots: Record<string, string> = {},
    vaultRoot: string = '',
    styleClears: CascadeStyleClears = { coverImage: {}, columnCoverImage: {}, frameBackground: {}, boardSettings: {} },
    mediaSnapshots: Record<string, string> = {},
  ) {
    super();
    // Board-spanning command; empty string skips the history-store guard.
    this.targetBoardId = '';
    this.byBoard = {};
    for (const [boardId, tiles] of Object.entries(byBoard)) {
      // cloneTile shares large string references for body content but
      // detaches every nested object — the snapshot contract we want here.
      this.byBoard[boardId] = tiles.map((t) => cloneTile(t));
    }
    this.connections = this.snapshot(connections);
    // allow-shallow: file/media snapshot maps hold primitive strings.
    this.fileSnapshots = { ...fileSnapshots };
    this.mediaSnapshots = { ...mediaSnapshots };
    // Capture the vault root so undo/redo can refuse to run against a
    // different vault. Falls back to the live store path so callers that omit
    // the arg still anchor the command to the active vault.
    this.vaultRoot = vaultRoot || vaultStore.path || '';
    // Deep-clone via `this.snapshot(...)` so a later mutation against the
    // originating styleClears object (or its plain-data subfields) can't
    // leak through the reference and corrupt the undo plan.
    this.styleClears = this.snapshot(styleClears);
    const totalTiles = Object.values(byBoard).reduce((sum, t) => sum + t.length, 0);
    this.description = `Cascade-delete ${totalTiles} tile(s)`;
  }

  execute() {
    // Vault-swap guard (mirrors `undo()`): replaying the delete against a
    // different vault would target unrelated boards/files. `historyStore.clear()`
    // fires on vault open but not on close-without-reopen.
    //
    // A path-STRING compare (not the generation-aware `isStillSameVault`) is
    // enough: a same-path new generation requires a vault OPEN, whose pre-swap
    // hook clears history, so this command can never observe one.
    if (this.vaultRoot && vaultStore.path && vaultStore.path !== this.vaultRoot) {
      uiStore.toast(
        'Cannot redo cascade-delete: the vault has changed since the delete ran.',
        'warning',
        5000,
      );
      return;
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
    // Re-apply style clears on redo. First-execute path
    // (initial dispatch) is a no-op because the caller already applied
    // them before history.execute; subsequent redo calls go through
    // applyCascadeStyleClears so the cache state stays consistent.
    boardCacheStore.applyCascadeStyleClears(this.styleClears);
  }

  async undo() {
    // Vault-swap guard (see `execute()`): writing file bodies into the
    // captured path after a swap would resurrect them in the OLD vault while
    // the user is looking at a different one.
    if (this.vaultRoot && vaultStore.path && vaultStore.path !== this.vaultRoot) {
      uiStore.toast(
        'Cannot undo cascade-delete: the vault has changed since the delete ran.',
        'warning',
        5000,
      );
      return;
    }

    // Restore the file bodies BEFORE the placements so a restored tile that
    // reads frontmatter / body during persistAddTile sees the resurrected file.
    // Each restore goes through `trackComponentWrite` (directly or via the
    // helper) so it joins the inflight counter, `.filo/.dirty` sentinel and
    // self-write registry — otherwise the watcher would classify our own
    // resurrection as an external edit.
    const restorePromises: Promise<unknown>[] = [];
    for (const [relPath, content] of Object.entries(this.fileSnapshots)) {
      if (!this.vaultRoot) break;
      restorePromises.push(
        // Through the note writer, which recreates the file; an editor still
        // mounted on the same path follows the restored bytes.
        noteStore.restore(relPath, content).catch((err) => {
          // The writer already reported the failure and marked the path
          // failed; this puts the undo in the error log too.
          reportError('CascadeDeleteCommand', err, `Failed to restore ${relPath}`);
        }),
      );
    }
    // Restore captured media (base64) via the binary write channel.
    for (const [relPath, base64] of Object.entries(this.mediaSnapshots)) {
      if (!this.vaultRoot) break;
      const vaultRoot = this.vaultRoot;
      restorePromises.push(
        trackComponentWrite(
          vaultRoot,
          relPath,
          async () => {
            await invokeOk('vault:write-file-binary', vaultRoot, relPath, base64);
          },
        ).catch((err) => {
          reportError('CascadeDeleteCommand', err, `Failed to restore media ${relPath}`);
        }),
      );
    }
    await Promise.all(restorePromises);

    // Restore the style fields BEFORE the placements so a
    // restored kanban card sees its coverImage back at the same time as
    // the rest of its placement. Frames are board-scope and survive the
    // cascade, so order doesn't strictly matter for them — but doing all
    // restores together keeps a single dirty-batch and a single redraw.
    boardCacheStore.restoreCascadeStyleClears(this.styleClears);

    // `skipEmptySeed: true` so a text tile whose body was NOT snapshotted (the
    // file is truly gone) doesn't get a blank `.md` seeded under it; the
    // placement comes back pointing at a missing file and the broken-ref UX
    // kicks in.
    // allow-board-store-current: active-vs-cache pivot, mirror of execute()
    const activeId = boardStore.current?.id ?? null;
    for (const [boardId, tiles] of Object.entries(this.byBoard)) {
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

  /**
   * Opts the command into the escalated history-truncation
   * toast. True when this command holds the only copy of one or more
   * deleted file bodies (text OR media), so dropping the command off the
   * undo stack means those file contents become irrecoverable.
   */
  hasFileSnapshots(): boolean {
    return (
      Object.keys(this.fileSnapshots).length > 0
      || Object.keys(this.mediaSnapshots).length > 0
    );
  }
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
   * `updateBoardSettings` bumps that board's `settingsVersionByBoard`, so the
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
