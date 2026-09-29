/**
 * A "Board save failed" toast is about particular board files. Once each of
 * them is saved (a Retry, the next save, the lock gone) or nothing is owed for
 * it any more (the board was deleted, its kept write dropped), the toast would
 * only say something that is no longer true, so it closes.
 *
 * Only board failures are tracked: their toast names the board files, which
 * are the keys the write ledger knows them by.
 */
import { isPathPending } from './writeStateTracking';

// allow-module-state: toast ids of the open failure toasts; a vault swap settles them (nothing is pending then)
const covered = new Map<string, Set<string>>();

/** The toast `toastId` now also reports a failed write of the board at `path`. */
export function trackBoardFailureToast(toastId: string, path: string): void {
  const paths = covered.get(toastId) ?? new Set<string>();
  paths.add(path);
  covered.set(toastId, paths);
}

/**
 * Closes each tracked toast whose boards all have nothing owed any more
 * (neither failed nor waiting to be written). Run on every write-state change.
 */
export function settleBoardFailureToasts(dismiss: (toastId: string) => void): void {
  for (const [toastId, paths] of [...covered]) {
    if ([...paths].some((p) => isPathPending(p))) continue;
    covered.delete(toastId);
    dismiss(toastId);
  }
}
