import type { Tile } from '../../schema/index';
import { assembleMarkdownFile } from '../editor/markdownSync';
import { createMdFileExclusive, createUniqueMdFile } from '../vault/createMdExclusive';
import { fileNameSafe, getActiveContentFolder, nextFreeMdPath } from '../vault/conventionPaths';
import { documentStore } from '../../stores/document.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { reportError } from '../utils/errorBus';
import { splitFrontmatterSource } from '../vault/frontmatterRead';

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
 * Creates the backing `.md` for a new text tile and registers its
 * `DocumentState`. Shared by every per-type `BoardTileOps.addTile`.
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

  // The text written when this call created the note; `null` when the note
  // already existed (adopted) or wasn't created.
  let created: string | null = null;
  try {
    if (fresh) {
      const slash = filename.lastIndexOf('/');
      const result = await createUniqueMdFile({
        vaultRoot,
        folder: slash >= 0 ? filename.slice(0, slash) : '',
        baseName: fileNameSafe(title),
        firstCandidate: filename,
        buildContent: () => assembleMarkdownFile({ title }, body),
      });
      created = result.content;
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
      const text = assembleMarkdownFile({ title }, body);
      const outcome = await createMdFileExclusive(vaultRoot, filename, text);
      if (outcome === 'created') {
        created = text;
        await vaultStore.refreshTree();
      }
    }
    if (created !== null) {
      // The tile's editor mounted with the tile and may have read the path
      // before this create landed (and found nothing). Record what was just
      // written so its first save keeps the new note's `title:`.
      documentStore.setFrontmatter(filename, { title }, splitFrontmatterSource(created).rawFrontmatter);
    }
    if (!documentStore.getDocument(filename)) {
      documentStore.loadDocument({
        filename,
        title,
        body,
        htmlContent: body,
        richText: [],
      });
    }
  } catch (err) {
    reportError(
      'boardCache.create-text-md',
      err,
      `Failed to create backing file ${filename} for new text tile`,
    );
  }
}
