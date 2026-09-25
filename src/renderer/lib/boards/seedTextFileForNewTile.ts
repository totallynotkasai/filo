import type { Tile } from '../../schema/index';
import { newNoteText } from '../notes/noteFile';
import { fileNameSafe, getActiveContentFolder, nextFreeMdPath } from '../vault/conventionPaths';
import { noteStore } from '../../stores/notes.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { reportError } from '../utils/errorBus';

/**
 * Text tiles whose note was allocated by `stampTextTileSeedPath` (a brand-new
 * note) rather than named by the caller (a dropped or restored note). Only a
 * new note is created with `title:`; an existing path is adopted as it is.
 */
// allow-module-state: a per-call handoff between the stamp and the seed of one tile object
const freshNotes = new WeakSet<Tile>();

/**
 * Picks and stamps a text tile's note path *without* touching disk, so the
 * cached def sees its `filePath` immediately. A tile that already names a
 * note keeps it. A new tile gets `fileNameSafe(title)` in the board's content
 * folder, bumped to ` (n)` past any path already on a board or on disk;
 * `seedTextFileForNewTile` then creates the file exclusively.
 *
 * Returns the path, or `null` for non-text tiles / no vault open.
 */
export function stampTextTileSeedPath(tile: Tile, resolvedBoardId: string): string | null {
  if (tile.type !== 'text') return null;
  if (!vaultStore.path) return null;
  if (tile.filePath) return tile.filePath;
  const board = boardCacheStore.cache[resolvedBoardId]?.board ?? null;
  const folder = getActiveContentFolder(board);
  const filename = nextFreeMdPath(boardCacheStore.cache, folder, fileNameSafe(tile.title || 'Untitled'));
  tile.filePath = filename;
  freshNotes.add(tile);
  return filename;
}

/**
 * Creates the backing `.md` for a new text tile. Shared by every per-type
 * `BoardTileOps.addTile`. The note writer reports the create to the note
 * store, so a tile editor that mounted before the file existed fills in.
 *
 * - A new note (path allocated by the stamp) is created exclusively with
 *   `title: <tile title>`. If another file took the name meanwhile, the next
 *   free ` (n)` wins and the def follows it.
 * - A named note that doesn't exist yet is created with its title; one that exists is
 *   adopted untouched.
 *
 * `options.skipEmptySeed` is the cascade-delete-undo flag: an absent file is
 * left absent (the broken-ref UX surfaces it) instead of being silently
 * materialised as a blank document.
 */
export async function seedTextFileForNewTile(
  tile: Tile,
  resolvedBoardId: string,
  options?: { skipEmptySeed?: boolean },
): Promise<void> {
  if (tile.type !== 'text') return;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;

  const title = tile.title || 'Untitled';
  // A new tile may bring its first body (a Markdown template's text).
  const body = tile.content || '';
  let filename = stampTextTileSeedPath(tile, resolvedBoardId);
  if (!filename) return;
  const fresh = freshNotes.has(tile);
  freshNotes.delete(tile);

  try {
    if (fresh) {
      const result = await noteStore.createUnique(filename, () => newNoteText({ title }, body));
      if (result.relPath !== filename) {
        filename = result.relPath;
        tile.filePath = filename;
        boardCacheStore.persistUpdateTile(tile.id, { filePath: filename }, resolvedBoardId);
      }
      // The main process suppresses the watcher event for renderer writes, so
      // refresh the tree for the new path to join `knownVaultPaths` before the
      // broken-ref recompute runs.
      await vaultStore.refreshTree();
    } else if (!options?.skipEmptySeed) {
      // ONE create-exclusive call (no exists-probe → write TOCTOU window).
      // `'exists'` means "adopt the existing file" (a dropped or restored
      // note); a note that has to be created here is new, so it gets its
      // title like any other new note.
      const outcome = await noteStore.createExclusive(filename, newNoteText({ title }, body));
      if (outcome === 'created') await vaultStore.refreshTree();
    }
  } catch (err) {
    reportError(
      'boardCache.create-text-md',
      err,
      `Failed to create backing file ${filename} for new text tile`,
    );
  }
}
