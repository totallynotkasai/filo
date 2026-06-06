/**
 * boardSaver — facade aggregating the V7 write pipeline.
 *
 * Historical entry point for the renderer; the real implementations live in
 * sibling modules:
 *
 *   - `tileDefBuilder`     — pure builders + `V7BoardFileData`.
 *   - `writeStateTracking` — inflight counter, sentinel paths, listener
 *                            slots, `trackComponentWrite`, reset.
 *   - `boardWriteScheduler` — `.board.json` debounced writes.
 *   - `configWriteScheduler` — `.filo/` config-bundle debounced writes.
 *   - `miscWriteScheduler` — per-key one-off writes (tags, themes, viewports).
 *   - `viewportCache`      — `.filo/viewports.json` in-memory map.
 *
 * This file re-exports every public name from those modules and composes
 * the `flushAll` / `cancelAllPendingWrites` orchestrators that span them.
 */

import {
  flushAllScheduledBoards,
  cancelAllPendingBoardWrites,
  type BoardWriteArgs,
} from './boardWriteScheduler';
import {
  cancelPendingConfigWrite,
  flushScheduledConfig,
  type ConfigWriteArgs,
} from './configWriteScheduler';
import { cancelAllPendingMiscWrites } from './miscWriteScheduler';
import { syncSentinelIfIdle, resetWriteTracking } from './writeStateTracking';
import { onVaultSwap } from '../../core/vaultLifecycle';

// ── Re-exports of the public write-pipeline surface ──

export type { V7BoardFileData } from './tileDefBuilder';
export {
  isInlineTileType,
  buildTileDefinition,
  buildInlineTileFromTile,
} from './tileDefBuilder';
export {
  setWriteErrorListener,
  setWriteStateListener,
  trackComponentWrite,
  resetWriteTracking,
  markPathFailed,
  markRecentSelfWrite,
  isRecentSelfWrite,
  hasPendingWrite,
  isPathPending,
  hasFailedWrites,
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
  type WriteErrorInfo,
  type WriteStateInfo,
  type TrackComponentWriteOptions,
} from './writeStateTracking';
export {
  scheduleBoardWrite,
  writeBoardFile,
  cancelBoardWrite,
  flushBoardWrite,
} from './boardWriteScheduler';
export {
  scheduleConfigWrite,
  writeConfigs,
  seedConfigSnapshots,
  markCorruptConfigTarget,
  clearCorruptConfigTarget,
  isConfigTargetCorrupt,
  isConfigPathCorrupt,
} from './configWriteScheduler';
export {
  scheduleMiscWrite,
  flushAllMisc,
  flushMiscWrite,
  type MiscWriteArgs,
} from './miscWriteScheduler';
export {
  seedViewportsCache,
  clearViewportsCache,
  getViewportFromCache,
  setViewport,
  removeViewport,
  type ViewportEntry,
} from './viewportCache';
export { BOARD_WRITE_DEBOUNCE_MS } from './boardWriteDebounce';

// ── Cross-scheduler orchestration ──

/**
 * Cancels every queued debounced write across all schedulers (board,
 * config, misc) without firing them. Called from the vault-swap path so
 * a timer armed against the previous vault can't fire after a new vault
 * opens — its closure would otherwise write to the OLD vaultRoot.
 *
 * On the happy path (user accepts the "save before opening?" dialog),
 * `flushAll` already drained these maps, so this becomes a no-op. The
 * decline-save / dialog-throw branches are what this guards.
 *
 * Does not adjust inflightWriteCount because the cancelled timers never
 * incremented it — increments happen inside writeBoardFile / writeConfigs,
 * which only run when the timer actually fires.
 */
export function cancelAllPendingWrites(): void {
  cancelAllPendingBoardWrites();
  cancelPendingConfigWrite();
  cancelAllPendingMiscWrites();
}

/**
 * Flushes all pending V7 writes immediately. Called on manual save.
 *
 * Returns `{ boardFailed, configFailed }` so callers (notably
 * `vaultStore.save()`) can surface an honest pass/fail to the Ctrl+S toast.
 * Each entry in `boardFailed` is the .board.json path that failed; each
 * entry in `configFailed` is a config target identifier
 * (e.g. `appearance.json`).
 *
 * Phase 31 A1.1 — the previous `Promise<void>` signature swallowed all
 * failure context; later phases (vault swap, save indicator, sentinel
 * sync) depend on knowing exactly which writes did not land.
 */
export async function flushAll(
  getBoardWriteArgs: (boardId: string) => BoardWriteArgs | null,
  getConfigWriteArgs: () => ConfigWriteArgs | null,
): Promise<{ boardFailed: string[]; configFailed: string[] }> {
  const boardFlush = await flushAllScheduledBoards(getBoardWriteArgs);
  const configFlush = await flushScheduledConfig(getConfigWriteArgs);
  const trackedVault = configFlush?.vaultRoot ?? boardFlush.vaultRoot;
  // Defensive: if tracked state disagrees with reality, sync the sentinel.
  syncSentinelIfIdle(trackedVault);
  return {
    boardFailed: boardFlush.failed,
    configFailed: configFlush?.failed ?? [],
  };
}

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
//
// Two pre-swap handlers for the write pipeline:
//   - `boardWriteScheduler` cancels every queued debounced timer (board /
//     config / misc) so a timer armed against the outgoing vault can't
//     fire after the new vault opens (its closure would otherwise write
//     to the OLD vaultRoot).
//   - `writeStateTracking` resets the inflight counter + pending / failed
//     sets. Honours `event.saveOutgoing`: when the user confirmed a save
//     for the outgoing vault, the handler schedules a `markClean` against
//     the previous vault's `.filo/.dirty` sentinel. "Don't Save" preserves
//     the sentinel so a later reopen surfaces the Recovery modal.
//
// Scheduler cancellation runs before tracking reset so the in-flight
// counter on the tracking side reflects only writes that actually fired.
onVaultSwap('pre-swap', 'boardWriteScheduler', () => {
  cancelAllPendingWrites();
});

onVaultSwap(
  'pre-swap',
  'writeStateTracking',
  (event) => {
    resetWriteTracking(event.saveOutgoing ? (event.previousVault ?? undefined) : undefined);
  },
  { runAfter: ['boardWriteScheduler'] },
);
