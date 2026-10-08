/**
 * Keeping the paths a command holds in step with renames.
 *
 * A command names the notes and files it acts on by vault path (a card's
 * note, a deleted tile's `filePath`, a cover image). When one of them is
 * renamed or moved after the command ran, its undo and redo must act on the
 * file at its new path: acting on the old one would recreate nothing but fail
 * as "file missing", and leave the change undone.
 *
 * The history store calls `renamePath(oldRel, newRel)` on every command it
 * holds after each rename. The default (`Command.renamePath`) walks the
 * command's own fields and rewrites every string held under a path field
 * name, including inside snapshots and child commands. A command whose paths
 * need other handling overrides it.
 */
import { rebasePath } from '../lib/vault/renamePathKeys';
import { vaultPath } from '../../shared/vaultPath';

/**
 * Field names whose string value (or array of strings) is a vault path.
 * Gate `commands-follow-renames` requires every path-like field in
 * `src/renderer/commands/` to be listed here (or its class to override
 * `renamePath`).
 */
export const PATH_FIELDS: ReadonlySet<string> = new Set([
  'relPath',
  'filePath',
  'filePaths',
  'notePath',
  'path',
  'paths',
  'src',
  'coverImage',
  'beforeCover',
  'afterCover',
  'backgroundImage',
  // The folder pin of a board: a board-settings undo that carries it must
  // restore the folder under its current name, not a name a rename retired.
  'defaultFolder',
  'fromPath',
  'toPath',
  'oldPath',
  'newPath',
  'itemRel',
]);

/**
 * Fields holding the user's own data (a note's frontmatter or index
 * metadata, a delta or splice built from them). Never walked: a frontmatter
 * key that happens to be called `path` or `src` is content, and a rename must
 * not rewrite what an undo writes back into the file.
 */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'fm',
  'frontmatter',
  'metadata',
  'forward',
  'inverse',
  'splices',
  'fileTags',
]);

/** A command's children (a batch's steps) follow renames through their own `renamePath`. */
interface Renamable {
  renamePath(oldRel: string, newRel: string, pinned?: readonly string[]): void;
}

function isRenamable(value: object): value is Renamable {
  return typeof (value as Partial<Renamable>).renamePath === 'function';
}

/** A file or folder the command moved into Filo's trash (`trashedFiles.ts`). */
function trashedRel(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { rel?: unknown; trashId?: unknown };
  return typeof v.rel === 'string' && typeof v.trashId === 'string' ? v.rel : null;
}

/**
 * The paths of everything `owner` holds in Filo's trash.
 *
 * DECISION: a trashed item keeps its original path. Undo restores it there
 * (or beside it, as `… (restored)`, when that path is taken again) and then
 * retargets the command's snapshots from the original path to where it
 * landed, so those snapshots must still name the original path. A rename of
 * a folder above it moves nothing that is in the trash.
 *
 * The exception: such a rename is noted on the item (`movedTo`, see
 * `followTrashedItem`), and when the folder it was in no longer exists at
 * restore (a board's folder renamed with the board) it goes back under the
 * renamed folder instead of making the old folder again. The retarget then
 * follows it there like any other landing place.
 */
function trashedPaths(owner: object): string[] {
  const out: string[] = [];
  for (const value of Object.values(owner)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const rel = trashedRel(item);
      if (rel) out.push(rel);
    }
  }
  return out;
}

/**
 * A trashed item whose folder (or a folder above it) moved from `oldRel` to
 * `newRel`: notes where the item would be now. Its own path is never renamed
 * (a file of that name at that path now is another file).
 */
function followTrashedItem(item: { rel: string; movedTo?: string }, oldRel: string, newRel: string): void {
  const at = item.movedTo ?? item.rel;
  // Only a folder above it: `oldRel` itself is a file that is not this one.
  if (vaultPath(at) === vaultPath(oldRel)) return;
  const next = rebasePath(at, oldRel, newRel);
  if (next !== null) item.movedTo = next;
}

/**
 * Rewrites every path `owner` holds under a path field name from `oldRel` (or
 * below it) to `newRel`, except paths `pinned` names or sits above (files in
 * the trash). Child commands are asked through their own `renamePath`.
 */
export function rebaseCommandFields(
  owner: object,
  oldRel: string,
  newRel: string,
  pinned: readonly string[] = [],
): void {
  const pins = [...pinned, ...trashedPaths(owner)];
  const isPinned = (path: string): boolean => pins.some((t) => rebasePath(path, t, t) !== null);
  const rebase = (path: string): string | null => (isPinned(path) ? null : rebasePath(path, oldRel, newRel));
  const seen = new WeakSet<object>([owner]);

  const visit = (holder: Record<string, unknown> | unknown[], key: string | number, value: unknown, pathField: boolean): void => {
    if (typeof value === 'string') {
      if (!pathField) return;
      const next = rebase(value);
      if (next !== null && next !== value) (holder as Record<string | number, unknown>)[key] = next;
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map || value instanceof Set) return; // keyed by tile / board ids, never paths
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(value, i, item, pathField));
      return;
    }
    if (trashedRel(value) !== null) {
      followTrashedItem(value as { rel: string; movedTo?: string }, oldRel, newRel);
      return;
    }
    if (isRenamable(value)) {
      value.renamePath(oldRel, newRel, pins);
      return;
    }
    walkObject(value as Record<string, unknown>);
  };

  const walkObject = (obj: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (CONTENT_FIELDS.has(key)) continue;
      visit(obj, key, value, PATH_FIELDS.has(key));
    }
  };

  walkObject(owner as Record<string, unknown>);
}
