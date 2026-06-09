/**
 * Pre-read .md bodies for tiles about to be deleted so `DeleteTilesCommand`
 * can restore them on undo. Cap matches the destructive-undo P0 phase: a
 * 25 MB limit per file keeps a runaway image-paste in an .md from blowing
 * the undo stack. Oversized files are still deleted on execute, but undo
 * only restores their placement — the file body is gone.
 *
 * Shared between AppShell's multi-tile delete dialog and TileHeader's
 * single-tile trash icon so both surface the same undo behaviour and the
 * same "oversized — undo can't restore the body" toast.
 */

import type { Tile } from '../../schema/index';
import { resolveTextTileVaultPath } from '../boards/textTilePath';

export const TILE_DELETE_SNAPSHOT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Phase 2 / 2.5 — separate, smaller cap for media bodies captured by
 * `captureCascadeFileSnapshots` (image/video/audio/pdf). Media at 5 MB+
 * gets oversized-toasted and is not restorable on undo. The cap is
 * deliberately tighter than the .md text snapshot ceiling because a
 * single folder delete can sweep many media files and the in-memory
 * undo stack should not balloon past hundreds of megabytes.
 */
export const TILE_DELETE_MEDIA_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Phase 2 / 2.5 — extensions captured as binary (base64) in cascade-delete
 * snapshots. Mirrors the main-process watcher's `MEDIA_EXTENSIONS` so the
 * renderer-side walker and the OS-level rename correlator stay in sync.
 */
// Audit-14 6.5 — de-exported: referenced only by `isCascadeMediaPath` below.
const MEDIA_SNAPSHOT_EXTENSIONS = new Set<string>([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.heic', '.heif', '.avif',
  // Video
  '.mp4', '.webm', '.ogv', '.mov',
  // Audio
  '.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a',
  '.opus', '.mid', '.midi',
  // PDF
  '.pdf',
]);

/**
 * Phase 2 / 2.5 — returns true when the given vault-relative path has an
 * extension recognised as media by the cascade-delete snapshot walker.
 */
export function isCascadeMediaPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return MEDIA_SNAPSHOT_EXTENSIONS.has(lower.slice(dot));
}

export interface DeleteSnapshotResult {
  fileSnapshots: { rel: string; content: string }[];
  oversizedPaths: string[];
}

/**
 * Reads every text-tile's backing `.md` content into `fileSnapshots` so the
 * caller can pass them to `boardStore.removeTilesWithHistory({ fileSnapshots,
 * vaultRoot })`. Skips non-text tiles. Skips tiles whose `resolveTextTileVaultPath`
 * returns null (no backing file). Read failures (ENOENT race, EACCES) drop
 * out silently — `DeleteTilesCommand` already handles missing files on undo
 * by surfacing a toast.
 */
export async function buildDeleteSnapshots(
  tiles: Tile[],
  vaultRoot: string,
): Promise<DeleteSnapshotResult> {
  const fileSnapshots: { rel: string; content: string }[] = [];
  const oversizedPaths: string[] = [];
  for (const tile of tiles) {
    if (tile.type !== 'text') continue;
    const relPath = resolveTextTileVaultPath(tile, tile.boardId);
    if (!relPath) continue;
    // Phase 37 / 37.6 — canonical two-arg form.
    const result = await window.filo.invoke('vault:read-file-text', vaultRoot, relPath);
    if (result.success) {
      if (result.content.length > TILE_DELETE_SNAPSHOT_MAX_BYTES) {
        oversizedPaths.push(relPath);
      } else {
        fileSnapshots.push({ rel: relPath, content: result.content });
      }
    }
  }
  return { fileSnapshots, oversizedPaths };
}
