import type { Tile, TextTile, Board } from '../../schema/index';
import { documentStore } from '../../stores/document.svelte';
import { boardStore } from '../../stores/board.svelte';
import { stripLeadingSlash, toPosix } from '../utils/path';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { getActiveContentFolder } from '../vault/conventionPaths';

/**
 * Resolves a text tile's vault-relative `.md` path using the same priority
 * order as `TextTile.vaultRelativePath()`:
 *
 *   1. Explicit `filePath` on the tile def (set when the backing .md sits
 *      outside the active cascade folder).
 *   2. Live `DocumentState.filename` for the tile's `contentId` — kept in
 *      sync by the rename pipeline.
 *   3. Cascade fallback `${title}.md` at
 *      `getActiveContentFolder(scopeBoard)`: vault-wide pin →
 *      per-board pin → vault root.
 *
 * Returns `null` for non-text tiles. The cascade fallback uses
 * `'Untitled.md'` when `tile.title` is empty, matching TextTile's behaviour.
 *
 * Pass `boardId` (or the tile's `tile.boardId`) when the call site knows the
 * tile's home board — cross-board operations (cascade renames, vault-index
 * sweeps, multi-board persists) need that to anchor the per-board
 * `defaultFolder` cascade to the *owning* board rather than whichever board
 * happens to be active. With no scope, the helper falls back to
 * `boardStore.current` for backward compatibility.
 */
export function resolveTextTileVaultPath(tile: Tile, boardId?: string): string | null {
  if (tile.type !== 'text') return null;
  const t = tile as TextTile & { filePath?: string };
  if (typeof t.filePath === 'string' && t.filePath.length > 0) return t.filePath;
  const docState = t.contentId ? documentStore.getDocument(t.contentId) : null;
  if (docState?.filename) return docState.filename;
  const basename = `${tile.title || 'Untitled'}.md`;
  const scopeBoard = resolveScopeBoard(tile, boardId);
  const folder = getActiveContentFolder(scopeBoard);
  return folder ? `${folder}/${basename}` : basename;
}

/**
 * Pick the board whose `defaultFolder` should anchor the cascade. Priority:
 *   1. explicit `boardId` arg
 *   2. `tile.boardId` (stamped by boardStore.addTile / persistAddTile)
 *   3. `boardStore.current` (active board — legacy behaviour)
 *
 * Falls back to `null` (vault root) if no board can be resolved.
 */
function resolveScopeBoard(tile: Tile, boardId?: string): Board | null {
  const explicit = boardId ?? (tile as Tile & { boardId?: string }).boardId;
  if (explicit) {
    const entry = boardCacheStore.cache[explicit];
    if (entry?.board) return entry.board;
  }
  return boardStore.current;
}

/**
 * Replaces the basename of a vault-relative `.md` path with `${newTitle}.md`,
 * preserving the folder portion. Used by the tile-rename pipeline so a tile
 * whose backing file lives in a subfolder renames inside that subfolder
 * (e.g. `Notes/Old.md` → `Notes/NewTitle.md`).
 *
 * Normalises Windows separators to forward slashes; strips a leading slash.
 * If the input does not end in `.md`, the new basename still uses `.md`.
 */
export function replaceTitleInVaultPath(oldRel: string, newTitle: string): string {
  const norm = stripLeadingSlash(toPosix(oldRel));
  const slash = norm.lastIndexOf('/');
  const folder = slash >= 0 ? norm.slice(0, slash + 1) : '';
  return `${folder}${newTitle}.md`;
}
