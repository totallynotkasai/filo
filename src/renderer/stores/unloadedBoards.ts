/**
 * unloadedBoards — board files this session knows but couldn't load (at open,
 * or at a later adoption), and the renames they missed meanwhile.
 *
 * A rename rewrites the links of every loaded board; an unloaded one isn't in
 * the cache, so its links would keep pointing at the old paths. Every rename
 * (in-app or by another program, via `renameAllPathKeys`) goes in a journal,
 * and when such a board loads later this session, the renames made since it
 * failed are replayed on it before it joins the cache. Links to files deleted
 * meanwhile are left as they are: the board shows them as missing, where the
 * user can re-link or remove them.
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import type { BoardFileData } from '../lib/boards/boardSaver';
import { rewriteRenameInBoard } from '../lib/vault/fileRefIntegrity';
import { rebasePath, registerPathRenamable } from '../lib/vault/renamePathKeys';
import { vaultSwapResettable } from '../core/vaultLifecycle';
import { uiStore } from './ui.svelte';

interface UnloadedBoard {
  relPath: string;
  /** The journal length when it failed: the renames it missed come after. */
  since: number;
  /** Why it didn't load, as the loader put it (its tab shows it). */
  message?: string;
}

const unloaded = new Map<VaultPath, UnloadedBoard>();
const journal: Array<{ oldRel: string; newRel: string }> = [];
/** Boards already named in a notice, per kind of change: each is named once a session. */
const told = new Set<string>();

vaultSwapResettable('unloadedBoards', () => {
  unloaded.clear();
  journal.length = 0;
  told.clear();
});

registerPathRenamable('unloadedBoards', (oldRel, newRel) => {
  journal.push({ oldRel, newRel });
  // An unloaded board moved with the rename (its folder, or its own file).
  for (const [key, entry] of [...unloaded]) {
    const moved = rebasePath(entry.relPath, oldRel, newRel);
    if (moved === null) continue;
    unloaded.delete(key);
    unloaded.set(vaultPath(moved), { ...entry, relPath: moved });
  }
});

/** A board file at `relPath` couldn't be loaded (`message`: why). */
export function markBoardUnloaded(relPath: string, message?: string): void {
  const key = vaultPath(relPath);
  const entry = unloaded.get(key);
  if (!entry) unloaded.set(key, { relPath, since: journal.length, ...(message ? { message } : {}) });
  else if (message) entry.message = message;
}

/** Why the board at `relPath` didn't load, when it is unloaded and that is known. */
export function unloadedBoardMessage(relPath: string): string | undefined {
  return unloaded.get(vaultPath(relPath))?.message;
}

/** The unloaded boards' paths. */
export function unloadedBoardPaths(): string[] {
  return [...unloaded.values()].map((e) => e.relPath);
}

/**
 * The board at `relPath` loaded: replays on `data` the renames made since it
 * failed, and forgets it. Returns how many links were rewritten (the caller
 * saves the board when there are any).
 */
export function catchUpLoadedBoard(relPath: string, data: BoardFileData): number {
  const key = vaultPath(relPath);
  const entry = unloaded.get(key);
  if (!entry) return 0;
  unloaded.delete(key);
  let rewritten = 0;
  for (const { oldRel, newRel } of journal.slice(entry.since)) rewritten += rewriteRenameInBoard(data, oldRel, newRel);
  return rewritten;
}

/**
 * After a rename, move or delete: names the boards that aren't loaded, so
 * the user knows their links weren't updated. `extra` adds boards a sweep
 * just failed to load.
 */
export function noticeUnloadedBoards(change: 'moved' | 'deleted', extra: string[] = []): void {
  const paths = [...new Set([...unloadedBoardPaths(), ...extra])].filter((p) => {
    const key = `${change}|${vaultPath(p)}`;
    if (told.has(key)) return false;
    told.add(key);
    return true;
  });
  if (paths.length === 0) return;
  const names = paths.map((p) => `"${p}"`).join(', ');
  const one = paths.length === 1;
  uiStore.pushToast({
    text: change === 'moved'
      ? `${names} ${one ? "isn't" : "aren't"} loaded, so ${one ? 'its' : 'their'} links to the moved files weren't updated. ` +
        `If ${one ? 'it loads' : 'they load'} this session, Filo updates them then; otherwise re-link them.`
      : `${names} ${one ? "isn't" : "aren't"} loaded, so ${one ? 'its' : 'their'} tiles for the deleted files weren't removed. ` +
        'They show as missing once the board loads.',
    type: 'warning',
    duration: 10000,
    dedupeKey: `unloaded-boards:${change}`,
  });
}
