import { newNoteText } from './noteFile';
import { noteStore } from '../../stores/notes.svelte';
import { fileNameSafe, nextFreeMdPath } from '../vault/conventionPaths';
import { boardCacheStore } from '../../stores/boardCache.svelte';

/**
 * Creates a brand-new note titled `title` in `folder` (vault-relative, `''`
 * for the root).
 *
 * - The frontmatter carries `title: <title>` exactly as given, first, ahead
 *   of any `frontmatter` keys the caller adds (template or task fields).
 * - The filename is `fileNameSafe(title)`, bumped to ` (n)` past any path
 *   already on a board, in the tree, or found on disk at create time. The
 *   create is exclusive, so an existing file is never overwritten.
 *
 * `body` may be a function of the final file stem for a template that
 * interpolates it. Returns the note's path and the text written.
 */
export async function createNoteFile(args: {
  vaultRoot: string;
  folder: string;
  title: string;
  frontmatter?: Record<string, unknown>;
  body?: string | ((finalStem: string) => string);
}): Promise<{ relPath: string; content: string }> {
  const baseName = fileNameSafe(args.title);
  const { title: _ignored, ...rest } = args.frontmatter ?? {};
  void _ignored;
  const fm = { title: args.title, ...rest };
  const created = await noteStore.createUnique(
    nextFreeMdPath(boardCacheStore.cache, args.folder, baseName),
    (stem) => newNoteText(fm, typeof args.body === 'function' ? args.body(stem) : (args.body ?? '')),
  );
  return { relPath: created.relPath, content: created.text };
}
