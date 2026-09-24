import type { Tile } from '../../schema/index';
import { assembleMarkdownFile } from '../editor/markdownSync';
import { resolveTextTileVaultPath } from './textTilePath';
import { createMdFileExclusive } from '../vault/createMdExclusive';
import { documentStore } from '../../stores/document.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { reportError } from '../utils/errorBus';

/**
 * Seeds the backing `.md` file for a new
 * text tile and registers the in-memory `DocumentState`. Shared between
 * every per-type `BoardTileOps.addTile` so the side-effect is identical
 * regardless of which board the new text tile lands on (today MindMap is
 * the only caller; Kanban + Task List currently route via their own
 * `persistAdd*Placement` paths which seed the .md upstream).
 *
 * Mutates `tile.filePath` in place when the caller didn't pre-pin a path,
 * so the live `boardStore.tiles` entry shows the resolved filename before
 * the caller continues. The same path is then read off the tile by the
 * caller when building the persisted `TileDefinition`.
 *
 * `options.skipEmptySeed` is the cascade-delete-undo flag — when set, an
 * absent file is left absent (the broken-ref UX surfaces it) instead of
 * being silently materialised as a blank document.
 */
/**
 * Pure sync helper that resolves and stamps the seed `.md` path on
 * a text tile *without* touching disk. Per-type tile ops call this before
 * writing the def into the cache so the cached definition sees the resolved
 * `filePath`, then call `seedTextFileForNewTile` for the deferred I/O.
 *
 * Returns the resolved filename when the tile was stamped, or `null` for
 * non-text tiles / no vault open / seed-skipped scenarios.
 */
export function stampTextTileSeedPath(tile: Tile, resolvedBoardId: string): string | null {
  if (tile.type !== 'text') return null;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return null;

  const textTile = tile as Tile & { filePath?: string };
  const title = tile.title || 'Untitled';
  const explicitPath = textTile.filePath;
  const filename =
    explicitPath && explicitPath.length > 0
      ? explicitPath
      : (resolveTextTileVaultPath(tile, resolvedBoardId) ?? `${title}.md`);

  textTile.filePath = filename;
  return filename;
}

export async function seedTextFileForNewTile(
  tile: Tile,
  resolvedBoardId: string,
  options?: { skipEmptySeed?: boolean },
): Promise<void> {
  if (tile.type !== 'text') return;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;

  const textTile = tile as Tile & Record<string, unknown>;
  const docId = (textTile.contentId as string) || tile.id;
  const title = tile.title || 'Untitled';
  const initialBody = (textTile.content as string) || '';
  const filename = stampTextTileSeedPath(tile, resolvedBoardId) ?? `${title}.md`;

  try {
    // Cascade-delete undo passes `skipEmptySeed: true`
    // because the file was already gone before the cascade ran. Writing
    // an empty `.md` here would resurrect the user's deleted file as a
    // blank document, silently destroying any out-of-band recovery
    // attempt (e.g. restoring from trash). With the flag set we leave
    // the placement pointing at a missing file; the broken-ref badge
    // tells the user what happened.
    if (!options?.skipEmptySeed) {
      // ONE create-exclusive call (no exists-probe → write TOCTOU window).
      // `'exists'` means "adopt the existing file".
      const fileText = assembleMarkdownFile({}, initialBody);
      const outcome = await createMdFileExclusive(vaultRoot, filename, fileText);
      if (outcome === 'created') {
        // Refresh the file tree so the newly-written path joins
        // `knownVaultPaths` BEFORE broken-ref recompute runs. The main
        // process suppresses the watcher event for renderer-initiated
        // writes, so without this the file lands on disk but the tree
        // snapshot stays stale and the tile gets a "Backing File
        // Missing" badge until the next manual refresh.
        await vaultStore.refreshTree();
      }
    }
    if (!documentStore.getDocument(docId)) {
      documentStore.loadDocument({
        docId,
        filename,
        title,
        body: initialBody,
        htmlContent: initialBody,
        richText:
          (textTile._richText as Parameters<typeof documentStore.loadDocument>[0]['richText']) ??
          [],
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
