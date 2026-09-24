/**
 * noteIds — the session id that keys a note in the open-document store.
 *
 * A board file names a note only by its vault path. The document store is
 * still keyed by an opaque id, so every view of one path must agree on one id
 * or two views of the same file edit two separate documents. This registry
 * hands out that id: the first request for a path mints it, every later
 * request (any board, the sidebar, a Document tab) gets the same one, and a
 * rename carries it to the new path. It is never written to disk and is
 * dropped on a vault swap.
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { createId } from '../lib/utils/ids';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';

// Deliberately not reactive: ids are minted while tiles are derived, and a
// path's id never changes except through a rename, which rebuilds the views.
const idsByPath = new Map<VaultPath, string>();

/** The session id for the note at `path`, minted on first use. */
export function noteIdFor(path: string): string {
  const key = vaultPath(path);
  let id = idsByPath.get(key);
  if (id === undefined) {
    id = createId();
    idsByPath.set(key, id);
  }
  return id;
}

/**
 * Records `id` for `path` when the path has none yet, so a document opened
 * under an id of its own is the one later views of that path find.
 */
export function bindNoteId(path: string, id: string): void {
  if (!path || !id) return;
  const key = vaultPath(path);
  if (!idsByPath.has(key)) idsByPath.set(key, id);
}

function renameNoteIds(oldRel: string, newRel: string): void {
  const oldKey = vaultPath(oldRel);
  const newKey = vaultPath(newRel);
  const exact = idsByPath.get(oldKey);
  if (exact !== undefined) {
    idsByPath.delete(oldKey);
    idsByPath.set(newKey, exact);
  }
  // A folder rename carries every note under it.
  const oldPrefix = `${oldKey}/`;
  const moved: Array<[VaultPath, VaultPath, string]> = [];
  for (const [key, id] of idsByPath) {
    if (key.startsWith(oldPrefix)) moved.push([key, vaultPath(`${newKey}/${key.slice(oldPrefix.length)}`), id]);
  }
  for (const [from] of moved) idsByPath.delete(from);
  for (const [, to, id] of moved) idsByPath.set(to, id);
}

registerPathRenamable('noteIds.idsByPath', renameNoteIds);

vaultSwapResettable('noteIds', () => {
  idsByPath.clear();
});
