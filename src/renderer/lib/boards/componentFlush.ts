/**
 * componentFlush — changes a mounted component holds that no writer has seen
 * yet: a title typed but not committed, a filter change inside its debounce,
 * a camera move inside its idle window, a running timer's progress.
 *
 * Each such component also saves on unmount, but leaving the vault checks for
 * unsaved work before the views unmount, and the swap then cancels whatever
 * their teardown queued. So every holder registers a flush here, and the save
 * (Ctrl+S, close, open-another-vault, quit) runs them all first: the changes
 * reach the writers while the save can still see them.
 *
 * A flush hands its change to a writer (a command, the board cache, the note
 * store); it doesn't wait for the disk. One that throws is reported and the
 * others still run.
 */
import { reportError } from '../utils/errorBus';

type Flush = () => Promise<void> | void;

// allow-module-state: holds mounted components only; each removes itself on unmount, which a vault swap causes
const flushes = new Map<symbol, { id: string; flush: Flush }>();

/** Registers a mounted component's flush; the returned function removes it. */
export function registerComponentFlush(id: string, flush: Flush): () => void {
  const key = Symbol(id);
  flushes.set(key, { id, flush });
  return () => {
    flushes.delete(key);
  };
}

/** Hands every registered component's held change to its writer. */
export async function flushAllComponents(): Promise<void> {
  for (const { id, flush } of [...flushes.values()]) {
    try {
      await flush();
    } catch (err) {
      reportError('componentFlush', err, `Couldn't save a change held by ${id}`);
    }
  }
}

/**
 * Leaving and quitting first take focus off a text field, so a field that
 * saves on blur (a task's notes box or title, a column title) hands its text
 * over. Quitting from the window unmounts nothing and fires no blur by itself.
 * Not for Ctrl+S, which mustn't take the caret away from someone typing.
 */
export function releaseFocusedField(): void {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.blur();
}

/** Test-only: forget every registered flush. */
export function __resetComponentFlushesForTests(): void {
  flushes.clear();
}
