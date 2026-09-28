/**
 * viewportCache — unified `.filo/viewports.json` model.
 *
 * Every mind-map board's pan/zoom is stored in a single
 * `.filo/viewports.json` file keyed by `boardId`. The map is held in memory
 * between flushes so a 1500ms debounced write captures the whole shape at
 * once — chatty pan/zoom streams don't write per-board files, they update
 * an in-memory entry that flushes together with every other board's saved
 * camera.
 *
 * Lifecycle:
 *   - `seedViewportsCache` (vault open) populates the map from disk.
 *   - `setViewport` / `removeViewport` mutate the map and queue a debounced flush.
 *   - `clearViewportsCache` (vault swap) drops the map and cancels the pending flush.
 *
 * Another copy of the file (a sync client, another machine) is merged in, not
 * written over: per board, the camera saved last wins (`updatedAt`), and a
 * board removed here stays removed.
 */

import { scheduleMiscWrite } from './miscWriteScheduler';
import { registerResetCallback, registerTestResetCallback } from './writeStateTracking';
import { setActiveVaultPath } from '../vault/activeVaultPath';
import { objectEntries, readOutsideVersion, saveMiscConfig } from './miscConfigDrift';

export interface ViewportEntry {
  x: number;
  y: number;
  scale: number;
  updatedAt?: number;
}

const VIEWPORTS_DEBOUNCE_MS = 1500;
const VIEWPORTS_KEY = 'viewports';
const VIEWPORTS_PATH = '.filo/viewports.json';

// allow-module-state: cleared via registerResetCallback below (fires on vault swap and per-test)
const viewportsCache = new Map<string, ViewportEntry>();
let viewportsVaultRoot: string | null = null;
/** Boards whose camera was removed this session: a merge doesn't bring them back. */
// allow-module-state: cleared via registerResetCallback below (fires on vault swap and per-test)
const removedBoardIds = new Set<string>();

// Vault-swap and test resets clear the cache.
registerResetCallback(() => clearViewportsCache());
registerTestResetCallback(() => clearViewportsCache());

export function seedViewportsCache(
  vaultRoot: string,
  map: Record<string, ViewportEntry>,
): void {
  viewportsCache.clear();
  removedBoardIds.clear();
  viewportsVaultRoot = vaultRoot;
  // Publish the committed vault root for cross-vault guards. This
  // is the single commit-time call that receives the candidate path, so it
  // doubles as the renderer's "active vault" signal for stores that must not
  // import vaultStore (would form an import cycle).
  setActiveVaultPath(vaultRoot);
  for (const [boardId, vp] of objectEntries(map, isViewportEntry)) {
    viewportsCache.set(boardId, { x: vp.x, y: vp.y, scale: vp.scale, updatedAt: vp.updatedAt });
  }
}

function isViewportEntry(vp: unknown): vp is ViewportEntry {
  if (!vp || typeof vp !== 'object') return false;
  const { x, y, scale } = vp as Partial<ViewportEntry>;
  return [x, y, scale].every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Takes another copy of `viewports.json` into the cache: per board, the entry
 * saved last wins (ties keep this session's), and removed boards stay removed.
 */
export function mergeViewportsFromDisk(disk: unknown): void {
  for (const [boardId, vp] of objectEntries(disk, isViewportEntry)) {
    if (removedBoardIds.has(boardId)) continue;
    const local = viewportsCache.get(boardId);
    if (local && (local.updatedAt ?? 0) >= (vp.updatedAt ?? 0)) continue;
    viewportsCache.set(boardId, { x: vp.x, y: vp.y, scale: vp.scale, updatedAt: vp.updatedAt });
  }
}

export function clearViewportsCache(): void {
  viewportsCache.clear();
  removedBoardIds.clear();
  viewportsVaultRoot = null;
  // Swap/close drops the active-vault signal too, so a cross-vault guard sees
  // no committed vault during the swap window.
  setActiveVaultPath('');
}

export function getViewportFromCache(boardId: string): ViewportEntry | null {
  return viewportsCache.get(boardId) ?? null;
}

/**
 * Stages a viewport for `boardId` and schedules a debounced write of the
 * full `.filo/viewports.json` file. The in-memory map is the source of
 * truth between flushes — readers should use `getViewportFromCache`.
 */
export function setViewport(boardId: string, vp: ViewportEntry): void {
  viewportsCache.set(boardId, { ...vp, updatedAt: Date.now() });
  removedBoardIds.delete(boardId);
  scheduleViewportsWrite();
}

/**
 * Drops `boardId` from the viewports cache and schedules a debounced write
 * so the disk file reflects the deletion. Called on board delete.
 */
export function removeViewport(boardId: string): void {
  if (!viewportsCache.has(boardId)) return;
  viewportsCache.delete(boardId);
  removedBoardIds.add(boardId);
  scheduleViewportsWrite();
}

/**
 * Schedules a debounced write of the full viewports cache to
 * `.filo/viewports.json`. Reuses `scheduleMiscWrite` so the write
 * participates in the inflight / sentinel / error pipeline and gets
 * drained by `flushAllMisc`.
 *
 * The debounce window is 1500ms — long enough that an exploratory
 * pan/zoom session coalesces into a single write, short enough that the
 * user's last position is captured before they normally quit.
 */
function scheduleViewportsWrite(): void {
  if (!viewportsVaultRoot) return;
  scheduleMiscWrite(
    VIEWPORTS_KEY,
    () => {
      if (!viewportsVaultRoot) return null;
      const payload = JSON.stringify(Object.fromEntries(viewportsCache), null, 2);
      const vaultRoot = viewportsVaultRoot;
      return {
        vaultRoot,
        path: VIEWPORTS_PATH,
        json: payload,
        droppable: true,
        write: async () => {
          const outside = await readOutsideVersion(vaultRoot, 'viewports.json');
          if (outside.kind === 'changed') mergeViewportsFromDisk(outside.disk);
          if (viewportsVaultRoot !== vaultRoot) return;
          await saveMiscConfig(vaultRoot, 'viewports.json', JSON.stringify(Object.fromEntries(viewportsCache), null, 2));
        },
      };
    },
    VIEWPORTS_DEBOUNCE_MS,
  );
}
