/**
 * Filo's trash: `.filo/trash/<trashId>/`.
 *
 * Every user-facing delete moves the item here instead of unlinking it, so undo
 * (and Settings → Trash) is a rename back that works for any file type and
 * size. Each entry is one folder:
 *
 *   .filo/trash/<trashId>/manifest.json   { originalPath, deletedAt, machineId, kind }
 *   .filo/trash/<trashId>/files/<originalPath>
 *
 * The item sits under `files/` rather than beside the manifest so a vault-root
 * file called `manifest.json` can't collide with it.
 *
 * Ordering is what makes a crash harmless:
 * - A move writes the manifest FIRST, then renames the item in. A crash in
 *   between leaves a manifest with no item (listed as missing, cleared by a
 *   purge); the item itself never left its place.
 * - The move is one `rename` on the vault's own volume, so a folder with a
 *   locked child fails as a whole: nothing moves.
 *
 * Nothing here deletes user content except `deleteTrashedPermanently`, which
 * only runs after the user confirmed it. A purge hands items to the OS Recycle
 * Bin through the injected `trashItem` and, when that fails, reports the items
 * and leaves them where they are.
 */
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, extname, join, posix } from 'path';
import { retryOnWindowsLock } from './filenameUtils';
import { toPosix } from '../../shared/pathUtils';

export const TRASH_DIR = join('.filo', 'trash');
const MANIFEST = 'manifest.json';
const FILES_DIR = 'files';
/** Items older than this are purged on vault open (on the machine that trashed them). */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** `20260925T101500Z-a1b2c3`: sortable by time, unique by the nonce. */
export const TRASH_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export type TrashKind = 'file' | 'folder';

/**
 * A custom theme file, the one thing under `.filo/` that the user deletes (and
 * so may restore). The pattern admits a single file directly in
 * `.filo/themes/`, so a manifest can't steer a restore anywhere else in
 * Filo's own folder.
 */
const THEME_FILE_RE = /^\.filo\/themes\/[^/\\]+\.json$/;

export function isThemeFilePath(originalPath: string): boolean {
  return THEME_FILE_RE.test(originalPath);
}

export interface TrashManifest {
  originalPath: string;
  deletedAt: string;
  machineId: string;
  kind: TrashKind;
  /**
   * Set when the item was restored (to this vault-relative path) but its trash
   * copy couldn't be removed (locked). The entry is not restored a second
   * time; emptying the trash clears the copy.
   */
  restoredTo?: string;
}

export interface TrashEntry extends TrashManifest {
  trashId: string;
  /** False when the manifest is there but the item never arrived (a crash mid-move). */
  present: boolean;
}

export class TrashIdError extends Error {
  constructor(id: string) {
    super(`Not a trash id: ${id}`);
    this.name = 'TrashIdError';
  }
}

export class TrashItemMissingError extends Error {
  readonly code = 'ENOENT';
  constructor(id: string) {
    super(`Trash item ${id} is gone`);
    this.name = 'TrashItemMissingError';
  }
}

/**
 * The entry was restored already; what is left in the trash is a copy. To the
 * renderer it is an item no longer in the trash (`TRASH_ITEM_MISSING`).
 */
export class TrashAlreadyRestoredError extends TrashItemMissingError {
  constructor(id: string, restoredTo: string) {
    super(id);
    this.message = `Trash item ${id} was already restored to ${restoredTo}`;
    this.name = 'TrashAlreadyRestoredError';
  }
}

function assertTrashId(id: string): void {
  if (!TRASH_ID_RE.test(id)) throw new TrashIdError(id);
}

function trashRoot(vaultRoot: string): string {
  return join(vaultRoot, TRASH_DIR);
}

function containerOf(vaultRoot: string, trashId: string): string {
  assertTrashId(trashId);
  return join(trashRoot(vaultRoot), trashId);
}

function itemPathOf(vaultRoot: string, trashId: string, originalPath: string): string {
  return join(containerOf(vaultRoot, trashId), FILES_DIR, ...originalPath.split('/'));
}

function newTrashId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function parseManifest(raw: string): TrashManifest | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (typeof m.originalPath !== 'string' || m.originalPath.length === 0) return null;
  if (typeof m.deletedAt !== 'string' || Number.isNaN(Date.parse(m.deletedAt))) return null;
  if (typeof m.machineId !== 'string') return null;
  if (m.kind !== 'file' && m.kind !== 'folder') return null;
  // A manifest is data from a synced folder: its path must stay a plain
  // vault-relative path so a restore can't be steered outside the vault.
  const segments = m.originalPath.split('/');
  if (m.originalPath.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (/^[a-zA-Z]:/.test(m.originalPath) || m.originalPath.includes('\\')) return null;
  if (segments[0]?.toLowerCase() === '.filo' && !isThemeFilePath(m.originalPath)) return null;
  const manifest: TrashManifest = { originalPath: m.originalPath, deletedAt: m.deletedAt, machineId: m.machineId, kind: m.kind };
  // Only shown and used to refuse a second restore, never as a path to write.
  if (typeof m.restoredTo === 'string' && m.restoredTo.length > 0) manifest.restoredTo = m.restoredTo;
  return manifest;
}

async function readManifest(vaultRoot: string, trashId: string): Promise<TrashManifest | null> {
  try {
    return parseManifest(await fs.readFile(join(containerOf(vaultRoot, trashId), MANIFEST), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Removes a container's bookkeeping once its item has left: the empty folders
 * under `files/`, the manifest and the container. `rmdir` only removes empty
 * folders, so this can never take user content with it; a folder that is
 * somehow not empty stays, and the entry keeps listing.
 */
async function removeBookkeeping(vaultRoot: string, trashId: string, originalPath: string): Promise<void> {
  const container = containerOf(vaultRoot, trashId);
  const filesDir = join(container, FILES_DIR);
  let dir = dirname(itemPathOf(vaultRoot, trashId, originalPath));
  while (dir.length >= filesDir.length && dir.startsWith(filesDir)) {
    try {
      await fs.rmdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return;
    }
    if (dir === filesDir) break;
    dir = dirname(dir);
  }
  try {
    await fs.unlink(join(container, MANIFEST));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  await fs.rmdir(container).catch(() => undefined);
}

/**
 * Moves `<vault>/<relPath>` into the trash. The caller has validated `relPath`
 * (safe, inside the vault, not under `.filo/`). Throws with the fs error when
 * the move can't happen; nothing has moved then.
 */
export async function moveToTrash(
  vaultRoot: string,
  relPath: string,
  machineId: string,
  now: Date = new Date(),
): Promise<{ trashId: string; kind: TrashKind }> {
  const originalPath = toPosix(relPath).replace(/^\/+|\/+$/g, '');
  const source = join(vaultRoot, ...originalPath.split('/'));
  const stat = await fs.lstat(source);
  const kind: TrashKind = stat.isDirectory() ? 'folder' : 'file';
  const trashId = newTrashId(now);
  const container = containerOf(vaultRoot, trashId);
  const target = itemPathOf(vaultRoot, trashId, originalPath);
  const manifest: TrashManifest = { originalPath, deletedAt: now.toISOString(), machineId, kind };
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(join(container, MANIFEST), JSON.stringify(manifest, null, 2), 'utf-8');
  try {
    await retryOnWindowsLock(() => fs.rename(source, target));
  } catch (err) {
    await removeBookkeeping(vaultRoot, trashId, originalPath);
    throw err;
  }
  return { trashId, kind };
}

/**
 * The free path for a restore: the original, or beside it as
 * `<stem> (restored)<ext>`, `<stem> (restored 2)<ext>` …
 */
async function freeRestorePath(vaultRoot: string, originalPath: string, kind: TrashKind): Promise<string> {
  if (!(await exists(join(vaultRoot, ...originalPath.split('/'))))) return originalPath;
  const slash = originalPath.lastIndexOf('/');
  const parent = slash >= 0 ? originalPath.slice(0, slash + 1) : '';
  const name = originalPath.slice(slash + 1);
  const lower = name.toLowerCase();
  const ext = kind === 'folder' ? '' : lower.endsWith('.board.json') ? '.board.json' : extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${parent}${stem} (restored${n === 1 ? '' : ` ${n}`})${name.slice(name.length - ext.length)}`;
    if (!(await exists(join(vaultRoot, ...candidate.split('/'))))) return candidate;
  }
  throw new Error(`No free name to restore ${originalPath} to`);
}

function targetTaken(target: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`"${target}" appeared before the restore; not replacing it`);
  err.code = 'EEXIST';
  return err;
}

/**
 * Test seams: a racing create just before the move, a volume without hard
 * links, and a trash copy that can't be unlinked.
 */
export interface RestoreHooks {
  beforeMove?: (target: string) => Promise<void>;
  link?: (existing: string, created: string) => Promise<void>;
  unlink?: (path: string) => Promise<void>;
}

/**
 * Moves `item` to `target` only if nothing is at `target`. On Windows `rename`
 * replaces an existing file, so a file a sync client created there since the
 * free-name check would be overwritten.
 *
 * - A file is hard-linked into place (the link fails with EEXIST when the
 *   target exists, atomically), then unlinked from the trash.
 * - Where hard links aren't supported (FAT32, some network shares), and for
 *   a folder, the target is re-checked just before each rename attempt; that
 *   leaves only the gap between that check and the rename.
 *
 * Throws EEXIST when the target is taken. Returns whether a copy of the item
 * was left in the trash (linked into place, but the trash side is locked).
 */
async function moveWithoutReplacing(
  item: string,
  target: string,
  kind: TrashKind,
  hooks: RestoreHooks,
): Promise<{ copyLeft: boolean }> {
  await hooks.beforeMove?.(target);
  if (kind === 'file') {
    let linked = false;
    try {
      await (hooks.link ?? fs.link)(item, target);
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw targetTaken(target);
      // No hard links here: fall back to the re-checked rename below.
    }
    if (linked) {
      // The item is in place. A trash copy that can't be unlinked (locked) is
      // only a duplicate; the caller marks the entry restored.
      const copyLeft = await retryOnWindowsLock(() => (hooks.unlink ?? fs.unlink)(item)).then(
        () => false,
        () => true,
      );
      return { copyLeft };
    }
  }
  await retryOnWindowsLock(() => fs.rename(item, target), {
    beforeAttempt: async () => {
      if (await exists(target)) throw targetTaken(target);
    },
  });
  return { copyLeft: false };
}

/** How many free names a restore tries while other programs keep taking them. */
const RESTORE_ATTEMPTS = 5;

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Where the item goes back: its original path, or `movedTo` (the same name
 * under a folder above it that was renamed while it was in the trash) when
 * the folder it was in no longer exists and the renamed one does. Restoring
 * to the original path then would make the old folder again, beside the one
 * the user renamed.
 */
async function restoreBase(vaultRoot: string, originalPath: string, movedTo: string | undefined): Promise<string> {
  if (!movedTo || movedTo === originalPath) return originalPath;
  if (posix.basename(movedTo).toLowerCase() !== posix.basename(originalPath).toLowerCase()) return originalPath;
  if (await exists(dirname(join(vaultRoot, ...originalPath.split('/'))))) return originalPath;
  return (await isDirectory(dirname(join(vaultRoot, ...movedTo.split('/'))))) ? movedTo : originalPath;
}

/**
 * Moves a trashed item back. When its original path is taken, it goes beside
 * it (`… (restored).md`) and `alongside` is true. It never replaces a file:
 * a path taken during the restore moves it to the next free name. `movedTo`
 * is checked by the caller (a safe path in the vault, outside `.filo/`); see
 * `restoreBase` for when it is used.
 */
export async function restoreFromTrash(
  vaultRoot: string,
  trashId: string,
  hooks: RestoreHooks = {},
  movedTo?: string,
): Promise<{ restoredPath: string; originalPath: string; kind: TrashKind; alongside: boolean }> {
  const manifest = await readManifest(vaultRoot, trashId);
  if (!manifest) throw new TrashItemMissingError(trashId);
  if (manifest.restoredTo !== undefined) throw new TrashAlreadyRestoredError(trashId, manifest.restoredTo);
  const item = itemPathOf(vaultRoot, trashId, manifest.originalPath);
  if (!(await exists(item))) throw new TrashItemMissingError(trashId);
  const base = await restoreBase(vaultRoot, manifest.originalPath, movedTo);
  for (let attempt = 0; ; attempt++) {
    const restoredPath = await freeRestorePath(vaultRoot, base, manifest.kind);
    const target = join(vaultRoot, ...restoredPath.split('/'));
    // The item's folder may have been deleted since.
    await fs.mkdir(dirname(target), { recursive: true });
    let copyLeft: boolean;
    try {
      ({ copyLeft } = await moveWithoutReplacing(item, target, manifest.kind, hooks));
    } catch (err) {
      // A rename onto a folder that appeared fails with its own code on some
      // systems; what counts is that the path is taken now.
      const taken = (err as NodeJS.ErrnoException).code === 'EEXIST' || (await exists(target));
      if (taken && attempt + 1 < RESTORE_ATTEMPTS) continue;
      throw err;
    }
    if (copyLeft) {
      // The bookkeeping can't go while the copy is there. Marking the entry
      // keeps the list from offering a second restore, which would put a
      // "(restored)" duplicate beside the file just brought back. If even the
      // mark can't be written, the entry stays restorable as before.
      const marked: TrashManifest = { ...manifest, restoredTo: restoredPath };
      await fs
        .writeFile(join(containerOf(vaultRoot, trashId), MANIFEST), JSON.stringify(marked, null, 2), 'utf-8')
        .catch(() => undefined);
    } else {
      await removeBookkeeping(vaultRoot, trashId, manifest.originalPath);
    }
    return {
      restoredPath,
      originalPath: manifest.originalPath,
      kind: manifest.kind,
      alongside: restoredPath !== base,
    };
  }
}

/** Every entry in the trash, newest first. Unreadable entries are skipped. */
export async function listTrash(vaultRoot: string): Promise<TrashEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(trashRoot(vaultRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TrashEntry[] = [];
  for (const trashId of names) {
    if (!TRASH_ID_RE.test(trashId)) continue;
    const manifest = await readManifest(vaultRoot, trashId).catch(() => null);
    if (!manifest) continue;
    const present = await exists(itemPathOf(vaultRoot, trashId, manifest.originalPath)).catch(() => false);
    out.push({ trashId, ...manifest, present });
  }
  return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export interface PurgeResult {
  purged: string[];
  failed: Array<{ trashId: string; originalPath: string }>;
}

/**
 * Hands trashed items to the OS Recycle Bin (`trashItem`). An item the Recycle
 * Bin refuses stays in Filo's trash and is reported in `failed`; the caller
 * asks the user before anything is deleted for good. `which` is a list of ids,
 * or `olderThan30d` for this machine's items past the retention period.
 */
export async function purgeTrash(
  vaultRoot: string,
  which: string[] | 'olderThan30d',
  opts: { machineId: string; trashItem: (absPath: string) => Promise<void>; now?: Date },
): Promise<PurgeResult> {
  const now = (opts.now ?? new Date()).getTime();
  let entries = await listTrash(vaultRoot);
  if (which === 'olderThan30d') {
    // Only the machine that trashed an item purges it: another machine's
    // clock or retention must not empty a trash it can't see being used.
    entries = entries.filter(
      (e) => e.machineId === opts.machineId && now - Date.parse(e.deletedAt) > TRASH_RETENTION_MS,
    );
  } else {
    for (const id of which) assertTrashId(id);
    const wanted = new Set(which);
    entries = entries.filter((e) => wanted.has(e.trashId));
  }
  const result: PurgeResult = { purged: [], failed: [] };
  for (const entry of entries) {
    if (entry.present) {
      try {
        await opts.trashItem(itemPathOf(vaultRoot, entry.trashId, entry.originalPath));
      } catch {
        result.failed.push({ trashId: entry.trashId, originalPath: entry.originalPath });
        continue;
      }
    }
    await removeBookkeeping(vaultRoot, entry.trashId, entry.originalPath);
    result.purged.push(entry.trashId);
  }
  return result;
}

/**
 * Deletes trashed items for good. Only for the "Delete permanently?" answer
 * after the Recycle Bin refused them.
 */
export async function deleteTrashedPermanently(vaultRoot: string, trashIds: string[]): Promise<string[]> {
  const deleted: string[] = [];
  for (const id of trashIds) {
    const container = containerOf(vaultRoot, id);
    await fs.rm(container, { recursive: true, force: true });
    deleted.push(id);
  }
  return deleted;
}
