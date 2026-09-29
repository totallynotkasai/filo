/**
 * tagSweepProgress — what the user sees while a vault-wide tag rename or
 * delete rewrites notes, which can take minutes in a large vault.
 *
 * While a sweep runs, a sticky toast says what it is doing and how far it has
 * got ("n of N notes"), updated a few times a second at most, and
 * `tagSweepStatus.running` lets the Tags Browser disable Rename and Delete,
 * and every other way into a sweep (a double-click rename, the Tags popup, a
 * toast's Undo or Retry) waits for the running one (`whenTagSweepsIdle`):
 * two sweeps over the same notes would interleave their rewrites.
 * When it ends the progress toast goes; the caller's own toast (the done
 * toast with its Undo, or the failure toast with Retry) takes its place.
 *
 * DECISION: there is no Cancel. A half-done sweep would need its own undo,
 * and the tag-rewrite sentinel already finishes one a crash interrupted.
 */
import { SvelteSet } from 'svelte/reactivity';
import { uiStore } from './ui.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import type { TagSweepProgress } from '../lib/vault/tagRewriteSweep';

/** The shortest gap between two updates of the progress toast. */
export const TAG_SWEEP_UPDATE_MS = 250;

const TOAST_KEY = 'tag-sweep-progress';

/** One token per sweep running. A sweep of the vault being left writes nothing more, so a swap forgets it. */
const running = new SvelteSet<symbol>();
/** Callers waiting for every running sweep to end. */
let idleWaiters: Array<() => void> = [];

function wakeIdleWaiters(): void {
  if (running.size > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const wake of waiters) wake();
}

onVaultSwap('pre-swap', 'tagSweepProgress', () => {
  running.clear();
  wakeIdleWaiters();
});

/** Resolves once no tag sweep is running (at once when none is). */
export function whenTagSweepsIdle(): Promise<void> {
  if (running.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

export const tagSweepStatus = {
  /** True while a tag rename, delete or restore is rewriting notes. */
  get running(): boolean {
    return running.size > 0;
  },
};

/** What the sweep is, for its progress toast: `Renaming tag "#a" to "#b"`. */
export function tagSweepLabel(oldName: string, newName: string | null): string {
  return newName === null ? `Deleting tag "#${oldName}"` : `Renaming tag "#${oldName}" to "#${newName}"`;
}

/** The progress toast's text. */
export function tagSweepProgressText(label: string, progress: TagSweepProgress | null): string {
  if (!progress || progress.total === 0) return `${label}…`;
  const notes = progress.total === 1 ? 'note' : 'notes';
  return progress.phase === 'reading'
    ? `${label}… checking ${progress.done} of ${progress.total} ${notes}`
    : `${label}… ${progress.done} of ${progress.total} ${notes}`;
}

/**
 * Runs `sweep` under a progress toast. `sweep` reports through the callback
 * it is given; the toast is updated at most every {@link TAG_SWEEP_UPDATE_MS}
 * (the latest count is never dropped, only delayed) and removed when the
 * sweep settles, however it settles.
 */
export async function withTagSweepProgress<T>(
  label: string,
  sweep: (onProgress: (progress: TagSweepProgress) => void) => Promise<T>,
): Promise<T> {
  const token = Symbol('tag-sweep');
  running.add(token);
  const toastId = uiStore.pushToast({
    text: tagSweepProgressText(label, null),
    type: 'info',
    sticky: true,
    dedupeKey: TOAST_KEY,
  });
  let lastShown = 0;
  let latest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const show = (): void => {
    timer = null;
    if (latest === null) return;
    uiStore.updateToastText(toastId, latest);
    latest = null;
    lastShown = Date.now();
  };
  const onProgress = (progress: TagSweepProgress): void => {
    latest = tagSweepProgressText(label, progress);
    if (timer !== null) return;
    const wait = TAG_SWEEP_UPDATE_MS - (Date.now() - lastShown);
    if (wait <= 0) show();
    else timer = setTimeout(show, wait);
  };
  try {
    return await sweep(onProgress);
  } finally {
    if (timer !== null) clearTimeout(timer);
    running.delete(token);
    uiStore.dismissToast(toastId, { silent: true });
    wakeIdleWaiters();
  }
}
