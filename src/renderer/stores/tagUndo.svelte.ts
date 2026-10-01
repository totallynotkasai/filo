/**
 * Undo for the vault-wide tag actions in the Tags browser (delete a tag,
 * rename a tag).
 *
 * These change many files at once and belong to no single board, so they
 * aren't on a board's Ctrl+Z stack (that would file them under whichever
 * board happened to be active). Instead each one offers Undo on the toast
 * that reports it, until the toast is dismissed or the next vault-wide tag
 * action's toast replaces it.
 *
 * A removal records exactly what it changed: the notes it rewrote, the tag's
 * registry definition, the attachments that carried it (`.filo/tags.json`),
 * the board-only tiles that carried it and where in their tag lists, and the
 * Kanban / Task List filter chips that named it. Undo puts the tag back in
 * those places only. Each note gets the tag re-added to a fresh read of the
 * file inside its write queue, so an edit made to the note in between is
 * kept. A tag that wasn't last in a note's list comes back at the end.
 *
 * Undoing a rename renames back only what the rename changed: a note tagged
 * with the new name since keeps it. A rename into an existing tag (in any
 * spelling, registered or not) merges the two, which can't be split again,
 * so it offers no Undo.
 */
import { SvelteSet } from 'svelte/reactivity';
import { fileTagsStore } from './fileTags.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { sameTag } from '../lib/vault/sidebarTagFilter';
import { noteStore } from './notes.svelte';
import { uiStore } from './ui.svelte';
import { boardCacheStore } from './boardCache.svelte';
import {
  iterateBoardOnlyTiles,
  flushTagRewriteBoardWrites,
  pushTagRewriteFailureToast,
  runTagRewriteSweep,
} from './fileTagsCascade.svelte';
import { bumpBoardViewRevision } from './boardViewRevision.svelte';
import { addTagToMarkdown } from '../lib/vault/tagRewriter';
import { isMarkdownExtension } from '../lib/vault/extension';
import { isMissingFileError } from '../lib/notes/noteWriter';
import type { TagRewriteSentinelPayload } from '../lib/vault/tagRewriteSentinel';
import { reportError } from '../lib/utils/errorBus';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { tagSweepStatus, whenTagSweepsIdle, withTagSweepProgress } from './tagSweepProgress.svelte';

/**
 * The key every vault-wide tag action's toast shares, so a newer one replaces
 * the older and its Undo. The Undo stays until then (or until dismissed): it
 * checks what it finds when it runs. Kept beside a newer action's toast, it
 * would undo the older action under the newer one.
 */
const TAG_ACTION_TOAST_KEY = 'vault-tag-action';

/** Reports a vault-wide tag action, with its Undo when it has one. */
function pushTagActionToast(text: string, undo?: () => Promise<void>): void {
  uiStore.pushToast({
    text,
    type: 'success',
    dedupeKey: TAG_ACTION_TOAST_KEY,
    ...(undo ? { sticky: true, actions: [{ label: 'Undo', handler: undo }] } : {}),
  });
}

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
 * Puts a filter chip back. The board's settings get a new object holding the
 * chip, and its view revision moves on: a mounted Kanban / Task List hydrated
 * its filters from `lastView` after the delete and writes them back on its
 * next save, so without the bump it would write the chip away again.
 */
function restoreFilterChip(chip: FilterChip, tagName: string): void {
  const board = boardCacheStore.cache[chip.boardId]?.board;
  if (!board) return;
  const settings = (board.settings ?? {}) as ViewSettings;
  const carrier = carrierAt(settings, chip.slot);
  if (!carrier || carrier.filterTags?.includes(tagName)) return;
  const restored = { ...carrier, filterTags: insertAt(carrier.filterTags ?? [], tagName, chip.index) };
  const slot = chip.slot;
  const next: ViewSettings = slot === 'lastView'
    ? { ...settings, lastView: restored }
    : { ...settings, savedViews: (settings.savedViews ?? []).map((v, i) => (i === slot ? restored : v)) };
  board.settings = next as typeof board.settings;
  boardCacheStore.markDirty(chip.boardId);
  bumpBoardViewRevision(chip.boardId);
}

/**
 * Waits for a running tag sweep to end before another starts: two sweeps
 * would rewrite the same notes in turns. Says so when it has to wait.
 * Resolves false when the vault was left meanwhile.
 */
async function afterRunningSweeps(identity: VaultIdentity): Promise<boolean> {
  if (tagSweepStatus.running) {
    uiStore.toast('Waiting for the tag change that is running to finish…', 'info', 2500);
    await whenTagSweepsIdle();
  }
  return isStillSameVault(identity);
}

/**
 * Deletes `tagName` everywhere (the caller has confirmed) and, once the
 * delete has committed, offers Undo on a toast. Resolves true when it committed.
 */
export async function removeTagWithUndo(tagName: string): Promise<boolean> {
  const identity = captureVaultIdentity();
  if (!(await afterRunningSweeps(identity))) return false;
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
  pushTagActionToast(
    `Deleted tag "#${tagName}"${touched > 0 ? ` from ${touched} item${touched === 1 ? '' : 's'}` : ''}.`,
    () => undoRemoval(snapshot),
  );
  return true;
}

/** Puts a deleted tag back exactly where the delete took it from. */
export async function undoRemoval(snapshot: TagRemovalSnapshot): Promise<void> {
  const { identity, tagName } = snapshot;
  if (!(await afterRunningSweeps(identity))) return;

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

  for (const chip of snapshot.chips) restoreFilterChip(chip, tagName);

  // Re-add to exactly the notes the delete rewrote, each on its fresh bytes.
  const failed: string[] = [];
  const total = snapshot.writtenPaths.length;
  await withTagSweepProgress(`Restoring tag "#${tagName}"`, async (onProgress) => {
    let done = 0;
    for (const path of snapshot.writtenPaths) {
      if (!isStillSameVault(identity)) return;
      onProgress({ phase: 'writing', done: done++, total });
      try {
        await noteStore.transform(path, (fresh) => addTagToMarkdown(fresh.raw, tagName), { notifyOnError: false });
      } catch (err) {
        // A note deleted since has nothing to restore the tag to.
        if (isMissingFileError(err)) continue;
        reportError('tagUndo', err, `Couldn't restore tag "#${tagName}" in ${path}`);
        failed.push(path);
      }
    }
  });
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
 * True when renaming `oldName` to `newName` would merge it into a tag that
 * already exists, in any spelling, anywhere: the registry, a note (even one
 * whose tag was never registered), an attachment or a board-only tile. A
 * different spelling of the tag itself (`draft` → `Draft`) is not a merge.
 */
export function isMergingRename(oldName: string, newName: string): boolean {
  if (sameTag(oldName, newName)) return false;
  return fileTagsStore.tagExists(newName);
}

/**
 * What a vault-wide rename changed, so its Undo changes back only that: the
 * notes it rewrote, the attachments and board-only tiles that carried the
 * old name, and the filter chips that named it. Anything tagged with the new
 * name after the rename keeps it.
 */
export interface TagRenameSnapshot {
  identity: VaultIdentity;
  oldName: string;
  newName: string;
  color: string | undefined;
  writtenPaths: string[];
  mediaPaths: string[];
  tiles: Array<{ boardId: string; id: string }>;
  chips: FilterChip[];
}

/**
 * Renames `oldName` to `newName` everywhere (the caller has confirmed any
 * merge) and offers Undo when the rename can be reversed: only when
 * `newName` didn't exist before, since a merge can't be split again.
 */
export async function renameTagWithUndo(oldName: string, newName: string): Promise<boolean> {
  const identity = captureVaultIdentity();
  if (!(await afterRunningSweeps(identity))) return false;
  await vaultIndexStore.whenBuildComplete();
  // The rename loads every board before it runs; do it first so the snapshot
  // sees the same tiles and chips the rename will touch.
  await boardCacheStore.ensureAllLoaded();
  if (!isStillSameVault(identity)) return false;
  const merging = isMergingRename(oldName, newName);
  const snapshot: TagRenameSnapshot = {
    identity,
    oldName,
    newName: newName.trim(),
    color: fileTagsStore.getDefinition(oldName)?.color,
    writtenPaths: [],
    mediaPaths: fileTagsStore.filesForTag(oldName).filter((p) => !isNotePath(p)),
    tiles: [...iterateBoardOnlyTiles()]
      .filter((t) => t.tags.includes(oldName))
      .map((t) => ({ boardId: t.boardId, id: t.id })),
    chips: findFilterChips(oldName),
  };
  const outcome = await fileTagsStore.renameTagEverywhere(oldName, newName);
  if (!outcome.committed || !isStillSameVault(identity)) return outcome.committed;
  if (merging) {
    // A merge can't be split again, so it has no Undo; it still says it's done.
    pushTagActionToast(`Merged "#${oldName}" into "#${newName}".`);
    return true;
  }
  snapshot.writtenPaths = outcome.writtenPaths;
  pushTagActionToast(`Renamed "#${oldName}" to "#${newName}".`, () => undoRename(snapshot));
  return true;
}

function renamedIn(tags: readonly string[], from: string, to: string): string[] | null {
  if (!tags.includes(from)) return null;
  return Array.from(new SvelteSet(tags.map((t) => (t === from ? to : t))));
}

/**
 * Renames the tag back in exactly the places the rename changed, unless the
 * old name exists again (renaming back would then merge the two). The notes
 * go first, each rewritten on a fresh read; the registry, attachments, tiles
 * and chips follow only once every note is back, as in the rename itself.
 * `retrying`: a Retry of the notes that failed, whose siblings already carry
 * the old name again.
 */
export async function undoRename(snapshot: TagRenameSnapshot, retrying = false): Promise<void> {
  const { identity, oldName, newName } = snapshot;
  if (!(await afterRunningSweeps(identity))) return;
  if (!retrying && fileTagsStore.tagExists(oldName)) {
    uiStore.toast(`Can't undo: a tag named "#${oldName}" exists again, and renaming back would merge them.`, 'warning', 5000);
    return;
  }

  if (snapshot.writtenPaths.length > 0) {
    const { failed: unflushed } = await noteStore.flushAll();
    if (!isStillSameVault(identity)) return;
    if (unflushed.length > 0) {
      uiStore.pushToast({
        text: `Couldn't undo the rename: pending edits to ${unflushed.length} file${unflushed.length === 1 ? '' : 's'} couldn't be saved. Resolve those errors and try again.`,
        type: 'error',
        duration: 0,
      });
      return;
    }
    const result = await runTagRewriteSweep(newName, oldName, identity.path, new SvelteSet(snapshot.writtenPaths), {
      mediaPaths: snapshot.mediaPaths,
      tiles: snapshot.tiles,
      chips: snapshot.chips,
      ...(snapshot.color ? { color: snapshot.color } : {}),
    });
    if (!isStillSameVault(identity)) return;
    if (result.failed.length > 0) {
      pushTagRewriteFailureToast({
        verb: 'Undo of the tag rename',
        failedCount: result.failed.length,
        attempted: result.attempted,
        retry: () => undoRename({ ...snapshot, writtenPaths: result.failed }, true),
      });
      return;
    }
  }

  for (const path of snapshot.mediaPaths) {
    const next = renamedIn(fileTagsStore.tagsForFile(path), newName, oldName);
    if (next) fileTagsStore.setFileTags(path, next);
  }
  const wanted = new SvelteSet(snapshot.tiles.map((t) => `${t.boardId}/${t.id}`));
  for (const t of iterateBoardOnlyTiles()) {
    if (!wanted.has(`${t.boardId}/${t.id}`)) continue;
    const next = renamedIn(t.tags, newName, oldName);
    if (next) boardCacheStore.persistUpdateTile(t.id, { tags: next }, t.boardId);
  }
  for (const chip of snapshot.chips) renameFilterChip(chip, newName, oldName);

  fileTagsStore.ensureTag(oldName, snapshot.color);
  if (snapshot.color) fileTagsStore.setTagColor(oldName, snapshot.color);
  // The new name's definition goes too, unless something was tagged with it since.
  if (!fileTagsStore.tagInUse(newName)) fileTagsStore.deleteTag(newName);

  await fileTagsStore.flushPendingSave();
  if (!isStillSameVault(identity)) return;
  await flushTagRewriteBoardWrites('Undo of the tag rename');
}

/**
 * Finishes a tag sweep a crash cut short (the Resume of the recovery prompt).
 * A rename's Undo resumes as that Undo, so only the attachments, tiles and
 * chips it recorded are renamed back; any other sweep converges forward (a
 * limited one only over its planned notes).
 */
export async function resumeTagSweep(payload: TagRewriteSentinelPayload): Promise<void> {
  const { oldName, newName, plan, scoped, undoOfRename } = payload;
  if (newName !== null && undoOfRename) {
    // The Undo swept the rename's new name back to its old one.
    await undoRename({
      identity: captureVaultIdentity(),
      oldName: newName,
      newName: oldName,
      color: undoOfRename.color,
      writtenPaths: plan,
      mediaPaths: undoOfRename.mediaPaths,
      tiles: undoOfRename.tiles,
      chips: undoOfRename.chips,
    }, true);
    return;
  }
  if (newName === null) await fileTagsStore.removeTagEverywhere(oldName, scoped ? plan : undefined);
  else await fileTagsStore.renameTagEverywhere(oldName, newName, scoped ? plan : undefined);
}

/** Renames one filter chip back, if it still names the tag. See `restoreFilterChip`. */
function renameFilterChip(chip: FilterChip, from: string, to: string): void {
  const board = boardCacheStore.cache[chip.boardId]?.board;
  if (!board) return;
  const settings = (board.settings ?? {}) as ViewSettings;
  const carrier = carrierAt(settings, chip.slot);
  const next = carrier?.filterTags ? renamedIn(carrier.filterTags, from, to) : null;
  if (!carrier || !next) return;
  const renamed = { ...carrier, filterTags: next };
  const slot = chip.slot;
  board.settings = (slot === 'lastView'
    ? { ...settings, lastView: renamed }
    : { ...settings, savedViews: (settings.savedViews ?? []).map((v, i) => (i === slot ? renamed : v)) }) as typeof board.settings;
  boardCacheStore.markDirty(chip.boardId);
  bumpBoardViewRevision(chip.boardId);
}
