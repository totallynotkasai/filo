import { normalizePath } from '../utils/path';

/**
 * Pure helper for `vaultStore.moveIntoFolder` — kept outside the store so it
 * can be unit-tested without mocking the IPC bridge or evaluating runes.
 *
 * Returns the composed destination path when the move is allowed, or `null`
 * when it should be refused (self-target, no-op, or moving a folder into one
 * of its own descendants).
 */
export function computeMoveIntoFolderTarget(
  sourcePath: string,
  folderPath: string,
): string | null {
  if (!sourcePath || !folderPath) return null;

  const srcNorm = normalizePath(sourcePath);
  const dstNorm = normalizePath(folderPath);

  if (srcNorm === dstNorm) return null;
  // Refuse moving a folder into its own descendant.
  if (dstNorm.startsWith(srcNorm + '/')) return null;

  const name = srcNorm.split('/').pop() ?? '';
  if (!name) return null;

  const currentParent = srcNorm.slice(0, Math.max(srcNorm.length - name.length - 1, 0));
  if (currentParent === dstNorm) return null; // already there

  // Preserve the platform-style separator of the input folderPath so the
  // result looks consistent. fs.rename in the main process is separator-
  // agnostic so either form works on disk.
  const sep = folderPath.includes('\\') ? '\\' : '/';
  return folderPath.replace(/[\\/]+$/, '') + sep + name;
}
