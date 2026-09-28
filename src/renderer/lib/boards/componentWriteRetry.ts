/**
 * Failed component writes that Retry can fire again.
 *
 * A write wrapped in `trackComponentWrite` (a theme or layout-template save)
 * has no scheduler behind it, so without this a failed one left its path
 * failed for the session: Retry had nothing to fire, save() stayed false and
 * every leave asked about it. A write that passes a `retry` is kept here when
 * its failure is transient; Retry fires it again, and its text goes into a
 * rescue copy if the vault is left first.
 */
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { registerRetryHook } from './writeSchedulerFailures';

interface RetainedWrite {
  /** The path as written, for messages and rescue copies. */
  relPath: string;
  /** Fires the write again (through `trackComponentWrite`). */
  run: () => Promise<unknown>;
  /** The whole file the write puts on disk, for a rescue copy. */
  rescueText?: () => string;
}

// allow-module-state: cleared by clearComponentRetries from resetWriteTracking (vault swap)
const retained = new Map<VaultPath, RetainedWrite>(); // allow-no-rename-transfer: only .filo/ theme and template files, which vault renames never move

export function retainComponentWrite(entry: RetainedWrite): void {
  retained.set(vaultPath(entry.relPath), entry);
}

/** A newer write of the path (or its success) supersedes the kept one. */
export function releaseComponentWrite(relPath: string): void {
  retained.delete(vaultPath(relPath));
}

export function clearComponentRetries(): void {
  retained.clear();
}

/** The kept writes' files, for rescue copies when the vault is left unsaved. */
export function unsavedComponentPayloads(): Array<{ relPath: string; text: string }> {
  const out: Array<{ relPath: string; text: string }> = [];
  for (const entry of retained.values()) {
    if (!entry.rescueText) continue;
    try {
      out.push({ relPath: entry.relPath, text: entry.rescueText() });
    } catch (err) {
      console.error(`[componentWriteRetry] rescue text for ${entry.relPath} threw:`, err);
    }
  }
  return out;
}

/** Fires every kept write once; the ones that fail again are kept again by `trackComponentWrite`. */
async function retryComponentWrites(): Promise<{ failed: string[] }> {
  const entries = [...retained.values()];
  retained.clear();
  const failed: string[] = [];
  for (const entry of entries) {
    try {
      await entry.run();
    } catch {
      failed.push(entry.relPath);
    }
  }
  return { failed };
}

registerRetryHook(retryComponentWrites);
