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
 */

import { scheduleMiscWrite } from './miscWriteScheduler';
import { registerResetCallback, registerTestResetCallback } from './writeStateTracking';
import { invokeOk } from '../utils/invokeOk';
import { setActiveVaultPath } from '../vault/activeVaultPath';

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

// Vault-swap and test resets clear the cache.
registerResetCallback(() => clearViewportsCache());
registerTestResetCallback(() => clearViewportsCache());

export function seedViewportsCache(
  vaultRoot: string,
  map: Record<string, ViewportEntry>,
): void {
  viewportsCache.clear();
  viewportsVaultRoot = vaultRoot;
  // Publish the committed vault root for cross-vault guards (audit 3.3). This
  // is the single commit-time call that receives the candidate path, so it
  // doubles as the renderer's "active vault" signal for stores that must not
  // import vaultStore (would form an import cycle).
  setActiveVaultPath(vaultRoot);
  for (const [boardId, vp] of Object.entries(map ?? {})) {
    if (!vp || typeof vp !== 'object') continue;
    if (
      typeof vp.x !== 'number' ||
      typeof vp.y !== 'number' ||
      typeof vp.scale !== 'number' ||
      !Number.isFinite(vp.x) ||
      !Number.isFinite(vp.y) ||
      !Number.isFinite(vp.scale)
    ) {
      continue;
    }
    viewportsCache.set(boardId, { x: vp.x, y: vp.y, scale: vp.scale, updatedAt: vp.updatedAt });
  }
}

export function clearViewportsCache(): void {
  viewportsCache.clear();
  viewportsVaultRoot = null;
  // Swap/close drops the active-vault signal too, so a cross-vault guard sees
  // no committed vault during the swap window (audit 3.3).
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
  scheduleViewportsWrite();
}

/**
 * Drops `boardId` from the viewports cache and schedules a debounced write
 * so the disk file reflects the deletion. Called on board delete.
 */
export function removeViewport(boardId: string): void {
  if (!viewportsCache.has(boardId)) return;
  viewportsCache.delete(boardId);
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
        write: async () => {
          await invokeOk('config:save', vaultRoot, 'viewports.json', payload);
        },
      };
    },
    VIEWPORTS_DEBOUNCE_MS,
  );
}
