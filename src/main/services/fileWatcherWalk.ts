import { promises as fsPromises, type Dirent, type Stats } from 'fs';
import { join } from 'path';
import { WATCHER_HASH_MAX_BYTES, fnv1a32, sha1Hex } from './fileWatcherHash';
import { relativePosix } from '../utils/pathHelpers';
import { vaultPath, type VaultPath } from '../../shared/vaultPath';
import { shouldIgnorePath, classifyChange } from './fileWatcherClassify';
import type { FileChangeEvent } from './fileWatcherTypes';

/**
 * The watcher's reconcile walk: a stat (and, for notes and boards, a content
 * hash) of every file in the vault, which the 30 s reconcile pass diffs
 * against the previous walk. Kept apart from the watcher's event mechanics.
 */

export interface ReconcileEntry {
  mtimeMs: number;
  size: number;
  /**
   * FNV-1a 32-bit hash of the file content (the whole file under
   * {@link WATCHER_HASH_MAX_BYTES}, a 4 KB prefix above it). Catches the
   * FAT/SMB case where 2-second mtime granularity leaves both stat fields
   * unchanged across two writes. `undefined` for non-`.md`/`.board.json`
   * files (media isn't hashed, for cost) and for files we couldn't open.
   */
  hash?: number;
  /** Change time and inode: an atomic replace that keeps mtime and size still moves these. */
  ctimeMs: number;
  ino: number;
  /** When the walk (or Filo's own write) recorded this entry, on the local clock. */
  seenAt: number;
}

/** The watcher's caches the walk reads and refreshes. */
export interface WalkCaches {
  /** The previous walk's entries, or `null` before the first. */
  previous: Map<string, ReconcileEntry> | null;
  knownDirs: Set<VaultPath>;
  lastKnownSizes: Map<VaultPath, number>;
  lastKnownHashes: Map<VaultPath, string>;
}

/**
 * How far a file's mtime must lie before the moment its entry was recorded
 * for a later walk to trust an unchanged stat without reading the file again.
 * Any write after that moment gets an mtime at least that moment minus the
 * file system's timestamp granularity (2 s on FAT / exFAT / SMB), so with a
 * wider margin an equal mtime proves no write happened. A younger file is
 * re-read every walk, which is what catches a same-size rewrite inside one
 * coarse timestamp tick. (A program that sets an old mtime on purpose while
 * keeping the size, inode and change time is not caught until its next write.)
 */
const TRUST_STAT_AFTER_MS = 5000;

/** Whether `stat` is the file `prior` recorded, with its mtime already old when recorded. */
function statUnchangedSince(prior: ReconcileEntry, stat: Stats): boolean {
  return prior.hash !== undefined
    && prior.size === stat.size
    && prior.mtimeMs === stat.mtimeMs
    && prior.ctimeMs === stat.ctimeMs
    && prior.ino === stat.ino
    && prior.mtimeMs < prior.seenAt - TRUST_STAT_AFTER_MS;
}

/** Whether the reconcile walk hashes this path's content (notes and boards). */
export function isReconcileHashed(rel: string): boolean {
  const lower = rel.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.board.json');
}

/** The reconcile hash of `bytes`: the whole file under the ceiling, a 4 KB prefix above it. */
export function reconcileHash(bytes: Buffer): number {
  return bytes.length <= WATCHER_HASH_MAX_BYTES ? fnv1a32(bytes) : fnv1a32(bytes.subarray(0, 4096));
}

/**
 * Recursively walks the vault directory and returns a map of every regular
 * file's vault-relative path to its stat (and hash). Returns `null` if the
 * vault root itself can't be opened — the caller surfaces a watcher
 * failure rather than treating the missing root as "vault is empty"
 * (which would synthesise a delete for every known file).
 */
export async function walkVault(root: string, caches: WalkCaches): Promise<Map<string, ReconcileEntry> | null> {
  const out = new Map<string, ReconcileEntry>();
  try {
    await fsPromises.access(root);
  } catch {
    return null;
  }
  const seenAt = Date.now();
  await walkDir(root, root, out, seenAt, caches);
  await walkFiloConfig(root, out, seenAt, caches);
  return out;
}

/**
 * The main walk skips `.filo/` wholesale (cache / recovery / viewports
 * rewrite constantly), but the renderer-reconciled config files must still
 * be covered, or an external edit to tags.json / a theme / a template made
 * while the live handle is down would never surface. Stat just the `.filo`
 * paths `classifyChange` maps to a granular `config-*` type. The granular
 * reconcilers are echo-tolerant, so self-writes are harmless.
 */
async function walkFiloConfig(
  root: string,
  out: Map<string, ReconcileEntry>,
  seenAt: number,
  caches: WalkCaches,
): Promise<void> {
  const tagsRel = '.filo/tags.json';
  try {
    const stat = await fsPromises.stat(join(root, tagsRel));
    if (stat.isFile()) {
      out.set(tagsRel, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        hash: undefined,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        seenAt,
      });
    }
  } catch {
    // No tags.json yet (fresh vault) — nothing to track.
  }
  for (const sub of ['themes', 'templates'] as const) {
    // walkDir skips `.filo` itself, so walking the subdirectory directly
    // reuses the EACCES/ENOENT-tolerant walk + the `.tmp`/`.bak` filter;
    // entries land as `.filo/<sub>/…` rel paths.
    await walkDir(root, join(root, '.filo', sub), out, seenAt, caches);
  }
}

async function walkDir(
  root: string,
  dir: string,
  out: Map<string, ReconcileEntry>,
  seenAt: number,
  caches: WalkCaches,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // EACCES on a subdirectory is recoverable — just skip the subtree.
    // ENOENT here means the dir was deleted between readdir and stat,
    // which is fine too.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'EACCES' || code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    // Hidden entries (`.git`, a sync client's `.stversions/` / `.stfolder/`,
    // `.obsidian/`, dotfiles) are outside the sidebar tree, so outside the
    // walk. That includes `.filo`: cache, recovery and viewports rewrite
    // often and would produce constant synthesised events; the
    // renderer-reconciled config files are re-added by walkFiloConfig().
    if (entry.name.startsWith('.')) continue;
    if (entry.name.endsWith('.tmp') || entry.name.endsWith('.bak')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      caches.knownDirs.add(vaultPath(relativePosix(root, full)));
      await walkDir(root, full, out, seenAt, caches);
    } else if (entry.isFile()) {
      try {
        const stat = await fsPromises.stat(full);
        const rel = relativePosix(root, full);
        // Every file's size, not only a hashed one's: the correlator answers
        // a moved file's old side from this cache, and without it an
        // attachment (never hashed by the walk) can't pair as a rename.
        caches.lastKnownSizes.set(vaultPath(rel), stat.size);
        out.set(rel, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          hash: await hashForWalk(full, rel, stat, caches),
          ctimeMs: stat.ctimeMs,
          ino: stat.ino,
          seenAt,
        });
      } catch {
        // File gone between readdir and stat — race with a concurrent
        // delete. Skip; the next pass picks it up if it stays gone.
      }
    }
  }
}

/**
 * Hash `.md` + `.board.json` so reconcile can detect mid-second rewrites on
 * filesystems with second-resolution mtime (FAT, SMB, some NFS configs), AND
 * seed the SHA-1 the cross-basename correlator consumes for the now-missing
 * source of a rename. One read feeds both digests so the walk stays at one
 * open per file.
 *
 * Under WATCHER_HASH_MAX_BYTES hash the WHOLE file, so a deep edit past 4 KB
 * is caught and the SHA-1 seed matches the on-demand rename probe's digest.
 * Above the ceiling use a 4 KB-prefix FNV only; the rename gate refuses such
 * pairs, so no SHA-1 is seeded.
 *
 * A file whose stat matches the last walk's, and whose mtime was already old
 * then (TRUST_STAT_AFTER_MS), keeps its hash without a read: a vault of
 * thousands of notes is otherwise read in full every 30 s.
 */
async function hashForWalk(full: string, rel: string, stat: Stats, caches: WalkCaches): Promise<number | undefined> {
  if (!isReconcileHashed(rel)) return undefined;
  const key = vaultPath(rel);
  const prior = caches.previous?.get(rel);
  if (prior !== undefined && statUnchangedSince(prior, stat)
    && (stat.size > WATCHER_HASH_MAX_BYTES || caches.lastKnownHashes.has(key))) {
    caches.lastKnownSizes.set(key, stat.size);
    return prior.hash;
  }
  try {
    if (stat.size <= WATCHER_HASH_MAX_BYTES) {
      const buf = await fsPromises.readFile(full);
      // The size too: the cross-basename pass answers a now-missing
      // file's size from this cache.
      caches.lastKnownSizes.set(key, buf.length);
      caches.lastKnownHashes.set(key, sha1Hex(buf));
      return reconcileHash(buf);
    }
    const fd = await fsPromises.open(full, 'r');
    try {
      const head = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(head, 0, 4096, 0);
      return fnv1a32(head.subarray(0, bytesRead));
    } finally {
      await fd.close();
    }
  } catch {
    // Hash failure isn't fatal; leave undefined and the diff
    // falls back to mtime+size comparison.
    return undefined;
  }
}

/**
 * The renderer reads boards, themes, templates and tags while it opens the
 * vault, before the watcher's first walk. A file changed in that gap (a sync
 * client finishing a download) would sit in the seed as if it had always
 * looked so, and never be reported. This lists every note, board and
 * reconciled `.filo/` config the seed finds changed at or after `since` (when
 * the vault was armed for opening); each reconciler takes an unchanged file
 * as a no-op, so a file Filo itself wrote there costs only a re-read.
 *
 * Media and other attachments are left out: nothing holds their content. The
 * change time counts as well as mtime, because a sync client gives a
 * downloaded file the other machine's mtime.
 */
export function changedSinceEvents(entries: Map<string, ReconcileEntry>, since: number): FileChangeEvent[] {
  const changed: FileChangeEvent[] = [];
  for (const [path, entry] of entries) {
    if (shouldIgnorePath(path)) continue;
    const type = classifyChange(path);
    if (type === 'tree' || type === 'attachment' || type === 'config') continue;
    if (Math.max(entry.mtimeMs, entry.ctimeMs) < since) continue;
    changed.push({ type, filename: path, eventType: 'change' });
  }
  return changed;
}
