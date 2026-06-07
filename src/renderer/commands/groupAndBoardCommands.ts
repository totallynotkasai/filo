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
import { writeMarkdownAndReconcile } from '../lib/vault/syncOpenEditorsAfterDiskMutation';

/**
 * D.5 — opens the inconsistent-state modal when one or more rollback
 * children threw inside `BatchCommand`. A single failed rollback child
 * still flows through `reportError` (toast), but when the *rollback
 * path itself* leaves the state half-applied, a toast is too easy to
 * miss — surfacing a danger-tinted modal forces the user to acknowledge
 * the inconsistency before continuing. The user should typically close
 * without saving to avoid persisting the half-applied state.
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
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — A batch's effective board
   * is determined by its children. We use the first child that declares a
   * non-empty targetBoardId; if none do, the field stays empty (the
   * historyStore guard skips empty strings, matching the prior optional
   * behaviour for a board-agnostic batch).
   */
  readonly targetBoardId: string;
  private commands: Command[];

  constructor(description: string, commands: Command[], boardId?: string) {
    super();
    this.description = description;
    // Phase 31 B4.6 — allow-shallow: snapshot of the array so the caller
    // can't mutate the input post-construction (push another command,
    // sort, splice) and corrupt the batch's execute / undo sequence.
    // The commands themselves are immutable references — they carry their
    // own internal snapshots — so we don't deep-clone.
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
   * Phase C / C.7 — atomic-ish execute. If child #N throws, every child
   * 0..N-1 has already mutated state; without rollback those mutations
   * persist while the user sees an error toast for the failed batch.
   * The previous "fire and forget per child" loop made "BatchCommand"
   * a misnomer — a half-applied batch is exactly the corruption hazard
   * an undoable command pattern is supposed to prevent.
   *
   * On any child failure we undo the already-executed children in
   * reverse order (LIFO — matches the natural inverse of the forward
   * sequence) and rethrow so the historyStore wrapper / caller sees the
   * original failure. Rollback errors are best-effort: we don't want a
   * secondary throw from `undo()` to mask the primary failure, but we
   * do surface them via `reportError` so they're not silent.
   */
  async execute(): Promise<void> {
    // Polish phase 2.2 — every child call (forward + rollback) is now
    // awaited via `await Promise.resolve(...)`. Children returning sync
    // `void` flow through the await unchanged (Promise.resolve unwraps
    // immediately); children returning a Promise (e.g. async undo on
    // `DeleteTilesCommand` after polish 2.1, async writes on
    // `UpdateTilePathCommand`) now sequence properly. Without the await,
    // an async child's rejection would escape the surrounding try/catch
    // as an unhandled rejection and the rollback would proceed on
    // half-applied state.
    const executed: Command[] = [];
    for (const cmd of this.commands) {
      try {
        await Promise.resolve(cmd.execute());
        executed.push(cmd);
      } catch (err) {
        // 6.4.M14 — log the ORIGINAL child failure that triggered the
        // rollback. Previously only rollback failures were reported; when the
        // rollback itself succeeded the root-cause error was swallowed past the
        // rollback (rethrown to a fire-and-forget historyStore caller as an
        // unhandled rejection, with no breadcrumb pinpointing which child or
        // why). The user-facing toast comes from historyStore's catch (6.4.M15);
        // this is the diagnostic detail that toast can't carry.
        console.error(
          `[BatchCommand] Child "${cmd.description}" failed in batch "${this.description}"; rolling back ${executed.length} applied child/children.`,
          err,
        );
        // D.5 — track rollback failures so the user gets a danger modal
        // instead of (or in addition to) per-child toasts. A toast for a
        // half-applied batch is too easy to dismiss; the modal forces
        // acknowledgement of the inconsistency.
        const rollbackFailures: { description: string; phase: 'undo' }[] = [];
        for (let i = executed.length - 1; i >= 0; i--) {
          const ex = executed[i];
          if (!ex) continue;
          try {
            // Polish phase 2.2 — `Promise.resolve(...)` wraps the child's
            // return value so a sync `void` still works (Promise.resolve()
            // is awaitable) and an async `Promise<void>` is properly
            // sequenced before the next rollback child. Without the
            // await, snapshot-write commands (DeleteTilesCommand) would
            // race their .md restores against subsequent rollback steps
            // and against the outer rethrow — exactly the silent-failure
            // window we're closing.
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
    //
    // Polish phase 2.2 — child calls are awaited (see execute() above
    // for the rationale).
    const undone: Command[] = [];
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const cmd = this.commands[i];
      if (!cmd) continue;
      try {
        await Promise.resolve(cmd.undo());
        undone.push(cmd);
      } catch (err) {
        // 6.4.M14 — log the original child-undo failure that triggered the
        // re-apply (see execute() for the rationale); the toast comes from
        // historyStore (6.4.M15), this is the per-child diagnostic.
        console.error(
          `[BatchCommand] Child "${cmd.description}" undo failed in batch "${this.description}"; re-applying ${undone.length} undone child/children.`,
          err,
        );
        // D.5 — same logic as execute(): if the rollback path itself
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
    // Phase R3 — deep-clone via `this.snapshot(...)` so a later mutation
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
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — board-spanning by design.
   * The cascade restores placements across every board's cache (not just
   * the active one), so a single targetBoardId would either block legitimate
   * cross-board work or pick an arbitrary board. The field is set to ''
   * in the constructor so the history dispatcher's truthy guard skips it
   * (matching the prior `optional` semantics for this specific command).
   *
   * Tracked decision: the command's docstring above already notes
   * "The undo entry lands on whatever board is active at cascade time …
   * but restoring placements on inactive boards is still correct" — Phase 2
   * preserves that contract.
   */
  readonly targetBoardId: string;
  private byBoard: Record<string, Tile[]>;
  private connections: Connection[];
  /**
   * Phase 31 A3.5 — vault-relative .md path → file body bytes captured
   * BEFORE the sidebar / external delete removed the file. On undo, each
   * entry is written back via `vault:write-file-text` so the restored
   * placements point at content again instead of a broken-ref badge.
   *
   * The 25 MB cap from `deleteTileSnapshots.ts` is enforced upstream in
   * `vaultFolderOps.delete`; oversized files arrive here absent from this
   * map and the user has already seen the "undo can't restore body" toast.
   */
  private fileSnapshots: Record<string, string>;
  /**
   * Phase 2 / 2.5 — vault-relative media path → base64-encoded body bytes
   * captured BEFORE the cascade delete. On undo, each entry is written
   * back via `vault:write-file-binary` so the restored image/video/audio
   * tiles point at content again instead of broken-refs.
   *
   * Capped at `TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES` (5 MB) per file
   * upstream in `vaultFolderOps.delete`. Oversized media never reach
   * this map; the user has already seen the "undo can't restore body"
   * toast for them.
   */
  private mediaSnapshots: Record<string, string>;
  private vaultRoot: string;
  /**
   * Sprint 35.2 — snapshot of style-clears applied to the cache when the
   * cascade ran. Includes Kanban placement `coverImage`, frame
   * `style.backgroundImage`, and mindmap `defaults.frame.backgroundImage`
   * fields that pointed at the cascaded file. Each clear records the
   * `matchedPath` so undo can restore the exact value. Without this
   * snapshot the placements come back on Ctrl+Z but the dependent style
   * fields stay wiped, and the next debounce persists the loss.
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
    // Phase 2 — board-spanning command; empty string skips the
    // history-store guard (see readonly targetBoardId doc above).
    this.targetBoardId = '';
    this.byBoard = {};
    for (const [boardId, tiles] of Object.entries(byBoard)) {
      // cloneTile shares large string references for body content but
      // detaches every nested object — exactly the snapshot contract we
      // want for cascade-delete (per existing audit fix).
      this.byBoard[boardId] = tiles.map((t) => cloneTile(t));
    }
    this.connections = this.snapshot(connections);
    // allow-shallow: file/media snapshot maps hold primitive strings.
    this.fileSnapshots = { ...fileSnapshots };
    this.mediaSnapshots = { ...mediaSnapshots };
    // Phase 1 / 1.3 — capture vault root at construction time so undo/redo
    // can refuse to run against a different vault. Empty-string fallback
    // is preserved for legacy callers; the execute/undo guards now treat
    // an empty captured root as "unknown vault" and refuse to operate, so
    // a default-constructed cascade can never restore into the wrong tree.
    // Prefer the passed value, fall back to the live store path so callers
    // that omit the arg still anchor the command to the active vault.
    this.vaultRoot = vaultRoot || vaultStore.path || '';
    // Deep-clone via `this.snapshot(...)` so a later mutation against the
    // originating styleClears object (or its plain-data subfields) can't
    // leak through the reference and corrupt the undo plan.
    this.styleClears = this.snapshot(styleClears);
    const totalTiles = Object.values(byBoard).reduce((sum, t) => sum + t.length, 0);
    this.description = `Cascade-delete ${totalTiles} tile(s)`;
  }

  execute() {
    // Phase 6 / 6.5 — vault-swap guard. Mirrors the guard in `undo()`.
    // If the user swapped vaults between the original cascade and a
    // redo, replaying the delete against the NEW vault would target
    // unrelated boards/files. `historyStore.clear()` fires on opening
    // a new vault, but the close-without-reopen edge case still leaves
    // the redo accessible against the wrong (empty / different) vault
    // root.
    //
    // Phase 1 / 1.3 — the constructor now captures `vaultStore.path` when
    // the caller omits an explicit `vaultRoot`, so this guard fires on
    // every real cascade rather than silently passing through when the
    // legacy default-empty argument was used. The mismatch check itself
    // is unchanged so the existing in-memory-only test scenarios (where
    // both paths are empty) continue to exercise the un-guarded path.
    //
    // Audit-11 VS-6 — deliberately a path-STRING compare, NOT the
    // generation-aware `isStillSameVault`. The only divergence between the two
    // (same path, new generation — a close→reopen of the same path, or an
    // A→B→A round-trip) requires a vault OPEN, which fires the `pre-swap` hook
    // that runs `historyStore.clear()` (history.svelte.ts), so this command is
    // off every undo/redo stack before it could observe a same-path-new-gen
    // vault. The blind spot is therefore unreachable here.
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
    // Sprint 35.2 — re-apply style clears on redo. First-execute path
    // (initial dispatch) is a no-op because the caller already applied
    // them before history.execute; subsequent redo calls go through
    // applyCascadeStyleClears so the cache state stays consistent.
    boardCacheStore.applyCascadeStyleClears(this.styleClears);
  }

  async undo() {
    // Phase 3 / 3.1 — vault-swap guard. The captured `vaultRoot` is the
    // vault active at execute time. If the user swapped vaults between
    // execute and undo, writing file bodies into the captured path would
    // resurrect them in the OLD vault while the user is staring at a
    // different one. `historyStore.clear()` fires on open of a new vault
    // but not on close, so this guard catches the close-without-reopen
    // edge case and the in-flight redo on a different vault than execute.
    //
    // Phase 1 / 1.3 — the constructor now captures `vaultStore.path` when
    // the caller omits an explicit `vaultRoot`, so a legacy
    // default-constructed cascade still has a non-empty `this.vaultRoot`
    // to compare against. The original bug — empty arg + later swap
    // restoring bodies into the WRONG vault — is closed at construction
    // time; the guard form here is intentionally identical to
    // `execute()`'s.
    //
    // Audit-11 VS-6 — see `execute()`: the path-STRING compare is sufficient
    // because the generation-only divergence (same path, new instance) is
    // unreachable for a history-stack command (vault open clears the stack).
    if (this.vaultRoot && vaultStore.path && vaultStore.path !== this.vaultRoot) {
      uiStore.toast(
        'Cannot undo cascade-delete: the vault has changed since the delete ran.',
        'warning',
        5000,
      );
      return;
    }

    // Phase 31 A3.5 — restore the file bodies BEFORE the placements so a
    // restored tile that reads frontmatter / body during persistAddTile
    // sees the resurrected file, not a missing one. The atomic write
    // helper (vault:write-file-text) creates the file if absent, which
    // is exactly what we want — the cascade already deleted it.
    //
    // Phase C / C.6 — wrap each restore through `trackComponentWrite` so
    // the resurrected file participates in the inflight counter +
    // sentinel + recent-self-write registry. Previously the raw IPC
    // call bypassed all three: a watcher event for the recreated file
    // could leak into the external-edit pipeline (classifying our own
    // resurrection as an external change), the save indicator stayed
    // "saved" even mid-restore, and an in-flight crash mid-undo wouldn't
    // surface the restored paths in the recovery sentinel.
    const restorePromises: Promise<unknown>[] = [];
    for (const [relPath, content] of Object.entries(this.fileSnapshots)) {
      if (!this.vaultRoot) break;
      const vaultRoot = this.vaultRoot;
      restorePromises.push(
        // Phase 6.6 — coupled write+reconcile. `create: true` restores the file
        // the cascade deleted (mkdir -p, the placement re-binds immediately
        // after), and `mode: 'full'` reloads any editor still mounted on it with
        // the restored bytes for the SAME path so a still-armed debounce can't
        // clobber the restoration ~300 ms later (applyReloadFromDisk
        // self-cancels, 6.0.C2). Keying the reconcile to the just-written path
        // replaces the post-Promise.all batch sync that used to follow.
        writeMarkdownAndReconcile({
          vaultRoot,
          path: relPath,
          content,
          mode: 'full',
          create: true,
        }).catch((err) => {
          // trackComponentWrite (inside the helper) already reports via
          // notifyWriteError + marks the path failed. We still log a topical
          // message so the restored-undo path surfaces in errorBus alongside
          // the toast.
          reportError('CascadeDeleteCommand', err, `Failed to restore ${relPath}`);
        }),
      );
    }
    // Phase 2 / 2.5 — restore captured media (base64) via the binary
    // write channel. Same trackComponentWrite wrapper as the text path
    // so the watcher's self-write registry treats the resurrection as
    // a Filo-initiated write, not an external edit.
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

    // Phase 6.6 — the open-editor reconcile now happens inside each
    // writeMarkdownAndReconcile above (write-path == reconcile-path by
    // construction), so the post-Promise.all batch syncOpenEditorsAfterDiskMutation
    // is gone. Media restorations have no document state to sync, as before.

    // Sprint 35.2 — restore the style fields BEFORE the placements so a
    // restored kanban card sees its coverImage back at the same time as
    // the rest of its placement. Frames are board-scope and survive the
    // cascade, so order doesn't strictly matter for them — but doing all
    // restores together keeps a single dirty-batch and a single redraw.
    boardCacheStore.restoreCascadeStyleClears(this.styleClears);

    // Phase B / B.2 — pass `skipEmptySeed: true` so a text tile whose backing
    // file body was NOT snapshotted (the file is truly gone, e.g. the
    // "Mark broken refs" toast on an external delete) doesn't get an empty
    // `.md` seeded under it on undo. The snapshot-restore loop above already
    // resurrected the file for the entries we did capture; without this flag
    // the no-snapshot tiles would silently materialise a blank file in the
    // user's vault. With the flag the placement comes back pointing at a
    // missing file and the existing broken-ref UX kicks in.
    // allow-board-store-current: active-vs-cache pivot, mirror of execute()
    const activeId = boardStore.current?.id ?? null;
    for (const [boardId, tiles] of Object.entries(this.byBoard)) {
      for (const tile of tiles) {
        if (boardId === activeId) {
          void boardStore.addTile(tile, { skipEmptySeed: true });
        } else {
          // 6.4.M20 — pass the known boardId so the re-add doesn't depend on
          // findBoardIdForTile resolving a tile that isn't in the cache yet.
          void boardCacheStore.persistAddTile(tile, { skipEmptySeed: true }, boardId);
        }
      }
    }
    for (const conn of this.connections) {
      // DI-2 (2026-05-29): skip a restored connection whose endpoint tile no
      // longer exists — e.g. a tile outside the deleted frame that was
      // independently removed after this cascade. The tile-restore loop above
      // mutated the cache synchronously, so `findTileBoardId` reflects both
      // restored and surviving endpoints; a null result means the edge is
      // dangling and must not persist.
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
   * Phase 3 / 3.8 — opts the command into the escalated history-truncation
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
   * Phase 31 A6.3 — capture the originating board ID so the history
   * dispatcher can refuse to redo this against a different board. The
   * `boardStore.updateSettings` call inside execute/undo always targets
   * `boardStore.current`, which means a redo with a different active
   * board would silently mutate the wrong target. The `targetBoardId`
   * guard in historyStore.undo/redo surfaces a toast instead.
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
    // Phase R3 — deep-clone via `this.snapshot(...)` so nested settings
    // sub-objects (e.g. `style.background`, `defaults.frame`) can't be
    // mutated through the caller-side reference after the command is
    // pushed.
    this.patch = this.snapshot(patch);
    this.inversePatch = this.snapshot(inversePatch);
    // allow-shallow: deleteOnUndo is an array of primitive strings.
    this.deleteOnUndo = [...deleteOnUndo];
    this.description = description ?? `Update board settings (${Object.keys(patch).join(', ')})`;
  }

  /**
   * Audit2 2.4 — apply settings to THIS command's board (`targetBoardId`) via
   * the cache, not through the global `boardStore` facade. The facade mutates
   * whatever board the active pane shows, and on a cross-board undo the pane
   * pivot (`boardActivator`) is `$effect`-driven (async) while `undo()` runs
   * synchronously, so the facade could still point at the previously-active
   * board — landing the mutation on the wrong board. `updateBoardSettings`
   * merges by board id and bumps that board's `settingsVersionByBoard`, so the
   * target re-renders whether or not it is the active pane (matching how the
   * Kanban/Task commands already self-target).
   */
  private applyToTarget(patch: Record<string, unknown>, deleteKeys: string[]): void {
    const cached = boardCacheStore.cache[this.targetBoardId];
    if (!cached) {
      // L10 (Audit-7) — the target board was closed/evicted. Undo stacks file by
      // the GLOBAL active board, so this command can sit on a still-live board's
      // stack while its OWN target board is gone; a bare return would silently
      // drop the user's undo/redo. Surface it like the cascade/Move* commands.
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
