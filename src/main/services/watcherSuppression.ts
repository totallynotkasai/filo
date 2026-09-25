import { vaultPath, type VaultPath } from '../../shared/vaultPath';

/**
 * The watcher's self-write suppression windows: paths (and folder trees) whose
 * events Filo expects as the echo of its own operation, each until an expiry.
 *
 * Every key goes through `vaultPath()`, which case-folds, so a suppression of
 * `Notes.md` matches an OS event spelled `notes.md`. Every call only ever
 * EXTENDS a window: a shorter later call (a post-write re-suppress) must not
 * shrink it and let a late echo through on a slow disk.
 */
export class SuppressionWindows {
  /** Path -> expiry for moves, deletes and other non-write operations. */
  private paths = new Map<VaultPath, number>();

  /**
   * Path -> expiry for Filo's own file WRITES. Only events for a file that is
   * still there are dropped: an atomic write never leaves its destination
   * missing, so a missing file inside this window was deleted or moved by
   * another program.
   */
  private writes = new Map<VaultPath, number>();

  /**
   * Folder prefix -> expiry, set before a recursive folder delete so each
   * descendant's unlink isn't a "deleted externally" prompt. Keys keep a
   * trailing slash so `notes/old/` never matches `notes/old-archive/`.
   */
  private prefixes = new Map<VaultPath, number>();

  private static extend(map: Map<VaultPath, number>, key: VaultPath, durationMs: number): void {
    map.set(key, Math.max(map.get(key) ?? 0, Date.now() + durationMs));
  }

  /** Drops every event for the path until the window ends. */
  suppress(relativePath: string, durationMs: number): void {
    const key = vaultPath(relativePath);
    if (key) SuppressionWindows.extend(this.paths, key, durationMs);
  }

  /** Drops events for the path only while the file exists (see `writes`). */
  suppressWrite(relativePath: string, durationMs: number): void {
    const key = vaultPath(relativePath);
    if (key) SuppressionWindows.extend(this.writes, key, durationMs);
  }

  /** Drops every event for the folder itself and everything under it. */
  suppressTree(relativePath: string, durationMs: number): void {
    const key = vaultPath(relativePath).replace(/\/+$/, '') as VaultPath;
    if (!key) return;
    // The folder entry itself can emit an event on some platforms.
    SuppressionWindows.extend(this.paths, key, durationMs);
    SuppressionWindows.extend(this.prefixes, (key + '/') as VaultPath, durationMs);
  }

  /** `present` says whether the file exists now; a write window only covers a file that does. */
  isSuppressed(relativePath: string, present = true): boolean {
    const key = vaultPath(relativePath);
    const now = Date.now();
    const expiry = this.paths.get(key);
    if (expiry !== undefined) {
      if (now > expiry) this.paths.delete(key);
      else return true;
    }
    const writeExpiry = this.writes.get(key);
    if (writeExpiry !== undefined) {
      if (now > writeExpiry) this.writes.delete(key);
      else if (present) return true;
    }
    // Typically one entry per in-flight folder delete, so a scan is cheapest.
    for (const [prefix, exp] of this.prefixes) {
      if (now > exp) {
        this.prefixes.delete(prefix);
        continue;
      }
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /**
   * True under an active folder-delete prefix. The reconcile carry-forward
   * uses it to keep an intentional folder delete from re-surfacing as an
   * external one once the window lifts.
   */
  isTreeSuppressed(relativePath: string): boolean {
    const key = vaultPath(relativePath);
    const now = Date.now();
    for (const [prefix, exp] of this.prefixes) {
      if (now <= exp && key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** True when any window is (or was, until the next gc) open. */
  any(): boolean {
    return this.paths.size > 0 || this.prefixes.size > 0 || this.writes.size > 0;
  }

  /** Forgets expired windows. */
  gc(): void {
    const now = Date.now();
    for (const map of [this.paths, this.prefixes, this.writes]) {
      for (const [key, expiry] of map) if (now > expiry) map.delete(key);
    }
  }

  clear(): void {
    this.paths.clear();
    this.prefixes.clear();
    this.writes.clear();
  }
}
