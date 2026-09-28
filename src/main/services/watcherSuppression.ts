import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import { sha1Hex } from './fileWatcherHash';

/** The size and SHA-1 of bytes Filo wrote to a path. */
export interface OwnBytes {
  size: number;
  sha1: string;
}

/**
 * What the file at a path holds now, for comparing with Filo's own write.
 * `sha1` is lazy (only needed when a size matches) and null when the file
 * couldn't be hashed. The probe itself returns null when it couldn't stat.
 */
export type FileProbe = (relativePath: string) => { size: number; sha1: () => string | null } | null;

/** How many recent own writes per path are remembered (a burst of saves). */
const OWN_BYTES_KEPT = 4;

/** The size and SHA-1 of `content` as written to disk (UTF-8 for a string). */
export function ownBytesOf(content: string | Buffer): OwnBytes {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return { size: bytes.length, sha1: sha1Hex(bytes) };
}

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
   * Path -> the bytes of Filo's recent writes there. While a write window is
   * open, an event is dropped only when the file holds one of these, so a
   * sync client or editor saving the note inside the window still gets
   * through. A window with none recorded drops every event for the present
   * file (its caller didn't say what it wrote).
   */
  private ownBytes = new Map<VaultPath, OwnBytes[]>();

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

  /**
   * Drops events for the path only while the file exists (see `writes`) and,
   * once `content` or {@link recordOwnBytes} says what Filo wrote, only while
   * it holds those bytes.
   */
  suppressWrite(relativePath: string, durationMs: number, content?: string | Buffer): void {
    const key = vaultPath(relativePath);
    if (!key) return;
    SuppressionWindows.extend(this.writes, key, durationMs);
    if (content !== undefined) this.recordOwnBytes(relativePath, ownBytesOf(content));
  }

  /** Remembers `own` as bytes Filo wrote (or is about to write) to the path. */
  recordOwnBytes(relativePath: string, own: OwnBytes): void {
    const key = vaultPath(relativePath);
    if (!key) return;
    const list = (this.ownBytes.get(key) ?? []).filter((o) => o.size !== own.size || o.sha1 !== own.sha1);
    list.push(own);
    this.ownBytes.set(key, list.slice(-OWN_BYTES_KEPT));
  }

  /**
   * `own` has landed at the path. Filo's writes to one path run one at a
   * time, so its earlier bytes there are no echo any more: the file holding
   * them again is another program's doing (a restore, a sync) and must be
   * reported.
   */
  recordLandedBytes(relativePath: string, own: OwnBytes): void {
    const key = vaultPath(relativePath);
    if (key) this.ownBytes.set(key, [own]);
  }

  /** Drops every event for the folder itself and everything under it. */
  suppressTree(relativePath: string, durationMs: number): void {
    const key = vaultPath(relativePath).replace(/\/+$/, '') as VaultPath;
    if (!key) return;
    // The folder entry itself can emit an event on some platforms.
    SuppressionWindows.extend(this.paths, key, durationMs);
    SuppressionWindows.extend(this.prefixes, (key + '/') as VaultPath, durationMs);
  }

  /**
   * `present` says whether the file exists now; a write window only covers a
   * file that does. `probe` reads what the file holds, so a write window
   * only covers Filo's own bytes; without it the window covers any content.
   */
  isSuppressed(relativePath: string, present = true, probe?: FileProbe): boolean {
    const key = vaultPath(relativePath);
    const now = Date.now();
    const expiry = this.paths.get(key);
    if (expiry !== undefined) {
      if (now > expiry) this.paths.delete(key);
      else return true;
    }
    const writeExpiry = this.writes.get(key);
    if (writeExpiry !== undefined) {
      if (now > writeExpiry) {
        this.writes.delete(key);
        this.ownBytes.delete(key);
      } else if (present && this.holdsOwnBytes(relativePath, key, probe)) {
        return true;
      }
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

  /** Whether the file holds bytes Filo wrote (true when that can't be told). */
  private holdsOwnBytes(relativePath: string, key: VaultPath, probe: FileProbe | undefined): boolean {
    const own = this.ownBytes.get(key);
    if (!probe || !own || own.length === 0) return true;
    const now = probe(relativePath);
    if (!now) return true;
    const sameSize = own.filter((o) => o.size === now.size);
    if (sameSize.length === 0) return false;
    const sha1 = now.sha1();
    return sha1 === null || sameSize.some((o) => o.sha1 === sha1);
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
    for (const key of [...this.ownBytes.keys()]) if (!this.writes.has(key)) this.ownBytes.delete(key);
  }

  clear(): void {
    this.paths.clear();
    this.prefixes.clear();
    this.writes.clear();
    this.ownBytes.clear();
  }
}
