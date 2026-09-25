/**
 * Undo for the vault-wide tag actions in the Tags browser (delete a tag,
 * rename a tag).
 *
 * These change many files at once and belong to no single board, so they
 * aren't on a board's Ctrl+Z stack (that would file them under whichever
 * board happened to be active). Instead each one offers Undo on the toast
 * that reports it.
 *
 * A removal records exactly what it changed: the notes it rewrote, the tag's
 * registry definition, the attachments that carried it (`.filo/tags.json`),
 * the board-only tiles that carried it and where in their tag lists, and the
 * Kanban / Task List filter chips that named it. Undo puts the tag back in
 * those places only. Each note gets the tag re-added to a fresh read of the
 * file inside its write queue, so an edit made to the note in between is
 * kept. A tag that wasn't last in a note's list comes back at the end.
 *
 * Undoing a rename is the reverse rename. A rename into an existing tag
 * merges the two, which can't be split again, so it offers no Undo.
 */
import { fileTagsStore } from './fileTags.svelte';
import { noteStore } from './notes.svelte';
import { uiStore } from './ui.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { iterateBoardOnlyTiles, flushTagRewriteBoardWrites } from './fileTagsCascade.svelte';
import { addTagToMarkdown } from '../lib/vault/tagRewriter';
import { isMarkdownExtension } from '../lib/vault/extension';
import { isMissingFileError } from '../lib/notes/noteWriter';
import { reportError } from '../lib/utils/errorBus';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';

/** How long the Undo stays on offer. */
export const TAG_UNDO_TOAST_MS = 15_000;

interface FilterChip {
  boardId: string;
  /** Index into `settings.savedViews`, or `'lastView'`. */
  slot: number | 'lastView';
  index: number;
}

export interface TagRemovalSnapshot {
  identity: VaultIdentity;
  tagName: string;
  color: string | undefined;
  writtenPaths: string[];
  mediaPaths: string[];
  tiles: Array<{ boardId: string; id: string; index: number }>;
  chips: FilterChip[];
}

interface FilterTagsCarrier {
  filterTags?: string[];
}

interface ViewSettings {
  savedViews?: FilterTagsCarrier[];
  lastView?: FilterTagsCarrier;
}

function isNotePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && isMarkdownExtension(path.slice(dot));
}

function viewSettings(boardId: string): ViewSettings | null {
  const board = boardCacheStore.cache[boardId]?.board;
  return board ? ((board.settings ?? {}) as ViewSettings) : null;
}

function carrierAt(settings: ViewSettings, slot: FilterChip['slot']): FilterTagsCarrier | undefined {
  return slot === 'lastView' ? settings.lastView : settings.savedViews?.[slot];
}

/** Every filter chip naming `tagName`, with its position. */
function findFilterChips(tagName: string): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const boardId of Object.keys(boardCacheStore.cache)) {
    const settings = viewSettings(boardId);
    if (!settings) continue;
    const slots: Array<FilterChip['slot']> = [...(settings.savedViews ?? []).map((_, i) => i), 'lastView'];
    for (const slot of slots) {
      const index = carrierAt(settings, slot)?.filterTags?.indexOf(tagName) ?? -1;
      if (index >= 0) chips.push({ boardId, slot, index });
    }
  }
  return chips;
}

function insertAt(list: readonly string[], tagName: string, index: number): string[] {
  const next = [...list];
  next.splice(Math.min(index, next.length), 0, tagName);
  return next;
}

/**
 * Deletes `tagName` everywhere (the caller has confirmed) and, once the
 * delete has committed, offers Undo on a toast. Resolves true when it committed.
 */
export async function removeTagWithUndo(tagName: string): Promise<boolean> {
  const identity = captureVaultIdentity();
  // The sweep loads every board before it runs; do it first so the snapshot
  // sees the same tiles and chips the delete will touch.
  await boardCacheStore.ensureAllLoaded();
  if (!isStillSameVault(identity)) return false;
  const snapshot: TagRemovalSnapshot = {
    identity,
    tagName,
    color: fileTagsStore.getDefinition(tagName)?.color,
    writtenPaths: [],
    mediaPaths: fileTagsStore.filesForTag(tagName).filter((p) => !isNotePath(p)),
    tiles: [...iterateBoardOnlyTiles()]
      .filter((t) => t.tags.includes(tagName))
      .map((t) => ({ boardId: t.boardId, id: t.id, index: t.tags.indexOf(tagName) })),
    chips: findFilterChips(tagName),
  };
  const outcome = await fileTagsStore.removeTagEverywhere(tagName);
  if (!outcome.committed || !isStillSameVault(identity)) return outcome.committed;
  snapshot.writtenPaths = outcome.writtenPaths;
  const touched = outcome.writtenPaths.length + snapshot.mediaPaths.length + snapshot.tiles.length;
  uiStore.pushToast({
    text: `Deleted tag "#${tagName}"${touched > 0 ? ` from ${touched} item${touched === 1 ? '' : 's'}` : ''}.`,
    type: 'success',
    duration: TAG_UNDO_TOAST_MS,
    actions: [{ label: 'Undo', handler: () => undoRemoval(snapshot) }],
  });
  return true;
}

/** Puts a deleted tag back exactly where the delete took it from. */
export async function undoRemoval(snapshot: TagRemovalSnapshot): Promise<void> {
  const { identity, tagName } = snapshot;
  if (!isStillSameVault(identity)) return;

  fileTagsStore.ensureTag(tagName, snapshot.color);
  if (snapshot.color) fileTagsStore.setTagColor(tagName, snapshot.color);
  for (const path of snapshot.mediaPaths) fileTagsStore.addTagToFile(path, tagName);

  // A local lookup, never read reactively.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const boardOnly = new Map<string, { boardId: string; tags: string[] }>();
  for (const t of iterateBoardOnlyTiles()) boardOnly.set(`${t.boardId}\u0000${t.id}`, t);
  for (const t of snapshot.tiles) {
    const live = boardOnly.get(`${t.boardId}\u0000${t.id}`);
    if (!live || live.tags.includes(tagName)) continue;
    boardCacheStore.persistUpdateTile(t.id, { tags: insertAt(live.tags, tagName, t.index) }, t.boardId);
  }

  for (const chip of snapshot.chips) {
    const settings = viewSettings(chip.boardId);
    const carrier = settings ? carrierAt(settings, chip.slot) : undefined;
    if (!carrier || carrier.filterTags?.includes(tagName)) continue;
    carrier.filterTags = insertAt(carrier.filterTags ?? [], tagName, chip.index);
    boardCacheStore.markDirty(chip.boardId);
  }

  // Re-add to exactly the notes the delete rewrote, each on its fresh bytes.
  const failed: string[] = [];
  for (const path of snapshot.writtenPaths) {
    if (!isStillSameVault(identity)) return;
    try {
      await noteStore.transform(path, (fresh) => addTagToMarkdown(fresh.raw, tagName), { notifyOnError: false });
    } catch (err) {
      // A note deleted since has nothing to restore the tag to.
      if (isMissingFileError(err)) continue;
      reportError('tagUndo', err, `Couldn't restore tag "#${tagName}" in ${path}`);
      failed.push(path);
    }
  }
  if (!isStillSameVault(identity)) return;

  await fileTagsStore.flushPendingSave();
  if (!isStillSameVault(identity)) return;
  await flushTagRewriteBoardWrites('Tag restore');
  if (failed.length > 0) {
    uiStore.pushToast({
      text: `Tag "#${tagName}" is back, but ${failed.length} note${failed.length === 1 ? '' : 's'} couldn't be updated: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`,
      type: 'error',
      duration: 0,
    });
  }
}

/**
 * Renames `oldName` to `newName` everywhere (the caller has confirmed any
 * merge) and offers Undo when the rename can be reversed: only when
 * `newName` didn't exist before, since a merge can't be split again.
 */
export async function renameTagWithUndo(oldName: string, newName: string): Promise<boolean> {
  const identity = captureVaultIdentity();
  const merging = fileTagsStore.allTagNames().includes(newName);
  const color = fileTagsStore.getDefinition(oldName)?.color;
  const outcome = await fileTagsStore.renameTagEverywhere(oldName, newName);
  if (!outcome.committed || !isStillSameVault(identity)) return outcome.committed;
  if (merging) return true;
  uiStore.pushToast({
    text: `Renamed "#${oldName}" to "#${newName}".`,
    type: 'success',
    duration: TAG_UNDO_TOAST_MS,
    actions: [{ label: 'Undo', handler: () => undoRename(identity, oldName, newName, color) }],
  });
  return true;
}

/** Renames the tag back, unless that would now merge it into another. */
export async function undoRename(
  identity: VaultIdentity,
  oldName: string,
  newName: string,
  color: string | undefined,
): Promise<void> {
  if (!isStillSameVault(identity)) return;
  if (fileTagsStore.allTagNames().includes(oldName)) {
    uiStore.toast(`Can't undo: a tag named "#${oldName}" exists again, and renaming back would merge them.`, 'warning', 5000);
    return;
  }
  const outcome = await fileTagsStore.renameTagEverywhere(newName, oldName);
  if (!outcome.committed || !isStillSameVault(identity)) return;
  if (color) fileTagsStore.setTagColor(oldName, color);
}

