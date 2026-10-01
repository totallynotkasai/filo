/**
 * migratedBoards — boards read from an older board format, whose file Filo
 * keeps before it first writes over it.
 *
 * Opening a vault never writes a board, so a board carried forward by the
 * migration steps (`schema/migrations.ts`) stays in its old format on disk
 * until the board changes. Its first save copies the file as it is to
 * `.filo/recovery/<ts>-keep/`, which the recovery prunes never remove, and
 * only then writes the current format. A copy that can't be made refuses the
 * save, kept for Retry: the file is the only record of the old format (and
 * the Filo that wrote it can't read the new one), so it is never written over
 * uncopied.
 *
 * The record follows renames (the copy is of the file wherever it now is),
 * goes once the copy is made or when its path is next loaded in the current
 * format, and is reset on vault swap.
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { registerPathRenamable, rebasePath } from '../vault/renamePathKeys';
import { notifyWriteError, registerResetCallback, registerTestResetCallback } from './writeStateTracking';
import { boardNameFromPath } from './boardNaming';
import { uiStore } from '../../stores/ui.svelte';

interface OlderFormatFile {
  /** The board file, in its latest spelling. */
  path: string;
  /** The board format the file is in. */
  version: number;
}

// allow-module-state: reset via registerResetCallback (vault swap)
const uncopied = new Map<VaultPath, OlderFormatFile>();

/**
 * Records the format of the board file a load just put in the cache: an
 * older `version` until its first save copies it, the current one (undefined)
 * clears any record left for the path.
 */
export function noteLoadedBoardFormat(path: string, olderFormat: number | undefined): void {
  const key = vaultPath(path);
  if (olderFormat === undefined) uncopied.delete(key);
  else uncopied.set(key, { path, version: olderFormat });
}

/** True while the board file at `path` is in an older format that hasn't been copied yet. */
export function hasUncopiedOlderFormat(path: string): boolean {
  return uncopied.has(vaultPath(path));
}

/** The save was refused because the older-format file couldn't be copied first. */
export class BoardOriginalNotKeptError extends Error {
  readonly code = 'BOARD_ORIGINAL_NOT_KEPT';
  /** The copy's own failure code (`ENOSPC`, `RECOVERY_SNAPSHOT_TOO_LARGE`…), when it had one. */
  readonly reason: string | undefined;
  constructor(boardPath: string, cause: unknown) {
    const reason = cause instanceof IpcEnvelopeError ? cause.code : undefined;
    super(`Couldn't keep a copy of "${boardPath}" (in an older board format) before saving it: ${String(cause)}`);
    this.name = 'BoardOriginalNotKeptError';
    this.reason = reason;
  }
}

/**
 * The board writer's step just before it writes `path`: a file still in an
 * older format is copied to `.filo/recovery/<ts>-keep/` first, and the user is
 * told where. Throws `BoardOriginalNotKeptError` (retained for Retry) when the
 * copy can't be made, so the file is never written over uncopied.
 */
export async function keepOlderFormatFile(vaultRoot: string, path: string): Promise<void> {
  const entry = uncopied.get(vaultPath(path));
  if (!entry) return;
  let copy: string;
  try {
    copy = (await invokeOk('recovery:snapshot', vaultRoot, path, 'keep')).path;
  } catch (err) {
    // Nothing there to copy: the file is gone, and the save puts it back
    // where it was ("Save at original location").
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
      forget(entry);
      return;
    }
    const error = new BoardOriginalNotKeptError(path, err);
    notifyWriteError({ kind: 'board', path, error });
    throw error;
  }
  forget(entry);
  uiStore.pushToast({
    text:
      `"${boardNameFromPath(entry.path)}" is now saved in this version's board format. ` +
      'A copy of the file as it was is in .filo/recovery.',
    type: 'info',
    duration: 10000,
    dedupeKey: `board-format-kept:${vaultPath(entry.path)}`,
    actions: [
      {
        label: 'Show in folder',
        handler: () => {
          void window.filo.invoke('shell:show-item-in-folder', copy);
        },
      },
    ],
  });
}

/** Drops `entry`, unless a load meanwhile recorded the path afresh. */
function forget(entry: OlderFormatFile): void {
  const key = vaultPath(entry.path);
  if (uncopied.get(key) === entry) uncopied.delete(key);
}

/** How many board names a notice lists before "and N more". */
const NAMES_SHOWN = 3;

function listNames(paths: readonly string[]): string {
  const names = paths.map((p) => `"${boardNameFromPath(p)}"`);
  if (names.length > NAMES_SHOWN) return `${names.slice(0, NAMES_SHOWN).join(', ')} and ${names.length - NAMES_SHOWN} more`;
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface OlderFormatNotice {
  text: string;
  type: 'info';
  duration: number;
  dedupeKey: string;
}

/**
 * The notice for boards read from an older format: they open as they are,
 * and each file changes only when its board does, after a copy is kept.
 * `null` when there are none.
 */
export function olderFormatBoardsNotice(paths: readonly string[]): OlderFormatNotice | null {
  if (paths.length === 0) return null;
  const text =
    paths.length === 1
      ? `The board ${listNames(paths)} was made by an older version of Filo and opens in this version's board format. ` +
        'Its file changes to the new format only when you change the board, and Filo keeps a copy of the file as it was in .filo/recovery first.'
      : `${paths.length} boards were made by an older version of Filo and open in this version's board format: ${listNames(paths)}. ` +
        'Each file changes to the new format only when you change its board, and Filo keeps a copy of the file as it was in .filo/recovery first.';
  return {
    text,
    type: 'info',
    duration: 15000,
    dedupeKey: `boards-older-format:${paths.map((p) => vaultPath(p)).join('|')}`,
  };
}

/** Shows the notice for a board loaded after the vault opened (found, retried or reloaded). */
export function announceOlderFormatBoard(path: string): void {
  const notice = olderFormatBoardsNotice([path]);
  if (notice) uiStore.pushToast(notice);
}

registerPathRenamable('migratedBoards', (oldRel, newRel) => {
  for (const [key, entry] of [...uncopied]) {
    const next = rebasePath(entry.path, oldRel, newRel);
    if (next === null) continue;
    uncopied.delete(key);
    entry.path = next;
    uncopied.set(vaultPath(next), entry);
  }
});

registerResetCallback(() => uncopied.clear());
registerTestResetCallback(() => uncopied.clear());
