/**
 * Where each item this session brought back from Filo's trash landed, by its
 * trash id: its old path, beside it as `… (restored)`, or under a folder
 * renamed since. A delete's undo whose item was already restored some other
 * way (Settings → Trash while its board wasn't open) puts its tile back on
 * that file, never on whatever another program or a new note put at the old
 * path meanwhile.
 *
 * Follows renames; a vault swap forgets them.
 */
import { vaultSwapResettable } from '../../core/vaultLifecycle';
import { rebasePath, registerPathRenamable } from './renamePathKeys';

const landed = new Map<string, string>();

vaultSwapResettable('restoredItems', () => {
  landed.clear();
});

registerPathRenamable('restoredItems', (oldRel, newRel) => {
  for (const [trashId, path] of landed) {
    const next = rebasePath(path, oldRel, newRel);
    if (next !== null) landed.set(trashId, next);
  }
});

/** The item in trash entry `trashId` is back, at `restoredPath`. */
export function noteRestored(trashId: string, restoredPath: string): void {
  landed.set(trashId, restoredPath);
}

/** Where the item in trash entry `trashId` was restored to this session, if it was. */
export function whereRestored(trashId: string): string | undefined {
  return landed.get(trashId);
}
