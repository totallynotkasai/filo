/**
 * notePrompts — the questions the note store asks the user.
 *
 * - Conflict: an unsaved body edit met a body change made by another program.
 *   "Reload" shows the file's version; "Keep mine" backs the file's version
 *   up to `.filo/recovery/` and then writes the local one.
 * - Deleted: a note with an unsaved edit was deleted by another program.
 *   "Keep mine" writes it back (only if nothing is at the path again);
 *   "Discard" lets it go.
 * - Can't save: a queued change met a file that is gone. "Save as new file"
 *   writes it back (only if nothing is at the path again); "Discard change"
 *   drops it.
 * - Reload shrank: a clean note reloaded from a much shorter version on disk
 *   (a sync client's truncation looks like this); "Undo reload" writes the
 *   previous body back after backing the short version up.
 *
 * Each prompt is sticky and keyed per note, so one note never shows two.
 */
import { uiStore } from './ui.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { promptClosedBoardFileMissing } from './vaultExternalPrompts';
import { noteStore, setNotePromptHandlers, type NoteModel } from './notes.svelte';
import { noteTitle } from './noteMeta';
import { getActiveVaultPath } from '../lib/vault/activeVaultPath';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { backupExternalVersion } from '../lib/vault/keepLocalBackup';
import { localNoteText } from '../lib/notes/noteFile';
import { reportError } from '../lib/utils/errorBus';

const conflictKey = (rel: string): string => `ext-mod:${rel}`;
const deletedKey = (rel: string): string => `ext-deleted:${rel}`;

/** The text to write back for a note deleted on disk: its last frontmatter over the local body. */
function recreatedText(m: NoteModel): string {
  return localNoteText(m.base, m.frontmatter, m.body);
}

function promptConflict(m: NoteModel): void {
  const rel = m.relPath;
  uiStore.pushToast({
    text: `"${noteTitle(rel)}" was changed by another program while you were editing it. Reload that version, or keep yours?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: conflictKey(rel),
    actions: [
      {
        label: 'Reload',
        handler: () => {
          void noteStore.resolveConflict(m.relPath, 'reload').catch((err) =>
            reportError('notePrompts.reload', err, `Couldn't reload "${m.relPath}"`),
          );
        },
      },
      {
        label: 'Keep mine',
        // allow-keep-local-no-backup: resolveConflict backs up the very bytes it then overwrites
        handler: async () => {
          try {
            await noteStore.resolveConflict(m.relPath, 'keep-mine');
          } catch (err) {
            reportError('notePrompts.keepMine', err, `Couldn't keep your version of "${m.relPath}"`);
          }
        },
      },
    ],
  });
}

function promptDeleted(m: NoteModel): void {
  const rel = m.relPath;
  uiStore.pushToast({
    text: `"${noteTitle(rel)}" was deleted by another program, but it has edits that weren't saved. Keep your version, or discard it?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: deletedKey(rel),
    actions: [
      {
        label: 'Keep mine',
        handler: async () => {
          const vaultRoot = getActiveVaultPath();
          const identity = captureVaultIdentity();
          // Nothing to back up when the path is empty; if a file came back,
          // its version is backed up before it's compared with ours.
          if (!vaultRoot || !(await backupExternalVersion(vaultRoot, m.relPath))) return;
          if (!isStillSameVault(identity)) return;
          const outcome = await noteStore.recreate(m.relPath, recreatedText(m));
          if (outcome === 'exists') void noteStore.onDiskChanged(m.relPath);
        },
      },
      {
        label: 'Discard',
        handler: () => {
          // The deletion is accepted: forget the note, its tags entry, and offer
          // to remove the tiles that now point at nothing.
          const rel = m.relPath;
          noteStore.discardDeleted(rel);
          fileTagsStore.dropFile(rel);
          const tiles = boardCacheStore.findCascadeDeleteTargets(rel).tileIds.length;
          const vaultRoot = getActiveVaultPath();
          if (tiles > 0 && vaultRoot) promptClosedBoardFileMissing(rel, tiles, vaultRoot);
        },
      },
    ],
  });
}

/**
 * A change couldn't be saved because its file is gone. Until the user picks,
 * the change stays queued and failed (save and quit report it, and disk
 * operations on that path wait). Shares the deleted prompt's key, so a note
 * never shows both.
 */
function promptWriteTargetMissing(rel: string, m: NoteModel | undefined): void {
  const saveAsNew = m
    ? [
        {
          label: 'Save as new file',
          handler: async () => {
            const vaultRoot = getActiveVaultPath();
            const identity = captureVaultIdentity();
            // Something may be at the path again: back it up before comparing.
            if (!vaultRoot || !(await backupExternalVersion(vaultRoot, m.relPath))) return;
            if (!isStillSameVault(identity)) return;
            const outcome = await noteStore.recreate(m.relPath, recreatedText(m));
            if (outcome === 'exists') void noteStore.onDiskChanged(m.relPath);
          },
        },
      ]
    : [];
  uiStore.pushToast({
    text: `Couldn't save changes to "${noteTitle(rel)}": the file no longer exists.`,
    type: 'error',
    duration: 0,
    sticky: true,
    dedupeKey: deletedKey(rel),
    actions: [
      ...saveAsNew,
      {
        label: 'Discard change',
        handler: () => {
          noteStore.discardQueued(m?.relPath ?? rel);
        },
      },
    ],
  });
}

function promptReloadShrank(m: NoteModel, priorBody: string): void {
  uiStore.pushToast({
    text: `"${noteTitle(m.relPath)}" was reloaded from disk and is much shorter than before.`,
    type: 'warning',
    dedupeKey: conflictKey(m.relPath),
    actions: [
      {
        label: 'Undo reload',
        handler: async () => {
          const vaultRoot = getActiveVaultPath();
          const identity = captureVaultIdentity();
          if (!vaultRoot || !(await backupExternalVersion(vaultRoot, m.relPath))) return;
          if (!isStillSameVault(identity)) return;
          noteStore.restoreBody(m.relPath, priorBody);
        },
      },
      { label: 'Keep reloaded', handler: () => undefined },
    ],
  });
}

/** Installs the prompts. Called once at startup (App.svelte). */
export function registerNotePrompts(): void {
  setNotePromptHandlers({
    conflict: promptConflict,
    deletedWithUnsavedBody: promptDeleted,
    writeTargetMissing: promptWriteTargetMissing,
    reloadShrank: promptReloadShrank,
    dismiss: (rel) => {
      uiStore.dismissToastsByKey(conflictKey(rel), { silent: true });
      uiStore.dismissToastsByKey(deletedKey(rel), { silent: true });
    },
  });
}
