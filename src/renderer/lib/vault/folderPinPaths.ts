/**
 * Folder-pin path rules, kept free of store imports so `board.svelte.ts` can
 * use them. A pin (the Root Directory or a board's `defaultFolder`) names a
 * folder by vault-relative path. Every compare is case-folded: Windows and
 * macOS don't tell `Notes` from `notes`, and a watcher event can arrive in
 * either spelling.
 */

import { normalizePath, normalizeVaultRelative, stripLeadingSlash } from '../utils/path';

/** A pin as a vault-relative folder: forward slashes, no leading or trailing slash. */
function cleanFolder(p: string): string {
  return stripLeadingSlash(normalizePath(p)).replace(/\/+$/, '');
}

/** True when `pin` is `folder` or sits inside it (case-folded). */
export function pinIsUnder(pin: string, folder: string): boolean {
  const p = normalizeVaultRelative(cleanFolder(pin));
  const f = normalizeVaultRelative(cleanFolder(folder));
  if (!p || !f) return false;
  return p === f || p.startsWith(`${f}/`);
}

/**
 * Where `pin` goes when `oldFolder` becomes `newFolder`: the new prefix plus
 * the pin's own remainder, spelled as it was. `''` when `newFolder` is `''`
 * (the folder was deleted). `null` when the pin isn't under `oldFolder`.
 */
export function rebasePin(pin: string, oldFolder: string, newFolder: string): string | null {
  if (!pinIsUnder(pin, oldFolder)) return null;
  if (!newFolder) return '';
  const rest = cleanFolder(pin).slice(cleanFolder(oldFolder).length);
  return cleanFolder(newFolder) + rest;
}

/**
 * The folder move a single file rename reveals. The watcher's reconcile walk
 * reports a folder renamed by another program as one rename per file
 * (`Old/a.md` → `New/a.md`), so a pin on `Old` only follows if the folder is
 * read off the file paths: drop the trailing segments both paths share.
 *
 * `null` when the paths share no trailing segment (the file itself was
 * renamed) or when either side is left empty (a move out of, or into, the
 * vault root reveals no folder). The caller must still confirm on disk that
 * the old folder is gone: moving one file between folders looks the same.
 */
export function folderMoveOfFileRename(
  oldRel: string,
  newRel: string,
): { oldFolder: string; newFolder: string } | null {
  const a = cleanFolder(oldRel).split('/');
  const b = cleanFolder(newRel).split('/');
  let shared = 0;
  while (
    shared < a.length - 1 &&
    shared < b.length - 1 &&
    normalizeVaultRelative(a[a.length - 1 - shared] ?? '') === normalizeVaultRelative(b[b.length - 1 - shared] ?? '')
  ) {
    shared += 1;
  }
  if (shared === 0) return null;
  const oldFolder = a.slice(0, a.length - shared).join('/');
  const newFolder = b.slice(0, b.length - shared).join('/');
  if (!oldFolder || !newFolder) return null;
  return { oldFolder, newFolder };
}
