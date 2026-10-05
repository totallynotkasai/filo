/**
 * The notes Filo made in this session for a new tile, card or task. Undoing
 * that add may move such a note to Filo's trash while it is still empty
 * (`commands/newNoteUndo.ts`); a note the user made, dropped or brought in
 * some other way is never one of them, so an undo never trashes it.
 *
 * Kept by vault path, following renames; a vault swap forgets them.
 */
import { vaultSwapResettable } from '../../core/vaultLifecycle';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { rebasePath, registerPathRenamable } from '../vault/renamePathKeys';

/** Each note's key, and its path as spelled. */
const made = new Map<VaultPath, string>();

vaultSwapResettable('madeForNewItems', () => {
  made.clear();
});

registerPathRenamable('madeForNewItems', (oldRel, newRel) => {
  for (const [key, path] of [...made]) {
    const next = rebasePath(path, oldRel, newRel);
    if (next === null) continue;
    made.delete(key);
    made.set(vaultPath(next), next);
  }
});

/** The note at `relPath` was just made for a new tile, card or task. */
export function noteMadeForNewItem(relPath: string): void {
  if (relPath) made.set(vaultPath(relPath), relPath);
}

/** Whether Filo made the note at `relPath` for a new tile, card or task in this session. */
export function isNoteMadeForNewItem(relPath: string): boolean {
  return !!relPath && made.has(vaultPath(relPath));
}
