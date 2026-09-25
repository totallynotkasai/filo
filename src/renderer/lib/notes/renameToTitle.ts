import { vaultStore } from '../../stores/vault.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { historyStore } from '../../stores/history.svelte';
import { RenameFileCommand } from '../../commands/renameFileCommand';
import { noteStem, noteTitle } from '../../stores/noteMeta';
import { fileNameSafe, nextFreeMdPath } from '../vault/conventionPaths';
import { normalizePath } from '../utils/path';

/**
 * The path "Rename file to match title" would give the note at `relPath`, or
 * `null` when its filename already matches. The stem comes from the title
 * the same way a new note's does; a name another file already has gets the
 * next free ` (n)`. A case-only difference renames in place.
 */
export function pathMatchingTitle(relPath: string): string | null {
  const slash = relPath.lastIndexOf('/');
  const folder = slash >= 0 ? relPath.slice(0, slash) : '';
  const ext = /\.markdown$/i.test(relPath) ? '.markdown' : '.md';
  const current = noteStem(relPath);
  const wanted = fileNameSafe(noteTitle(relPath));
  if (wanted === current) return null;
  const prefix = folder ? `${folder}/` : '';
  if (wanted.toLowerCase() === current.toLowerCase()) return `${prefix}${wanted}${ext}`;
  const picked = nextFreeMdPath(boardCacheStore.cache, folder, wanted);
  return ext === '.md' ? picked : picked.replace(/\.md$/, ext);
}

/**
 * Renames the note at `relPath` so its filename follows its title. Titles
 * and filenames are otherwise independent: a title edit never renames the
 * file, so this is the explicit way to line them up. Goes through the vault
 * rename, so every board that shows the note follows the new path. Board undo
 * renames it back.
 */
export async function renameNoteFileToTitle(relPath: string): Promise<void> {
  const root = vaultStore.path;
  if (!root) return;
  const target = pathMatchingTitle(relPath);
  if (!target) {
    uiStore.toast('The file name already matches the title', 'info', 2000);
    return;
  }
  const base = normalizePath(root);
  const result = await vaultStore.rename(`${base}/${relPath}`, `${base}/${target}`);
  if (result.success) {
    historyStore.pushWithoutExecute(new RenameFileCommand(relPath, target));
    return;
  }
  uiStore.toast(
    result.code === 'ENOENT' ? `"${relPath}" is no longer on disk` : 'Failed to rename the file',
    result.code === 'ENOENT' ? 'warning' : 'error',
    3500,
  );
}
