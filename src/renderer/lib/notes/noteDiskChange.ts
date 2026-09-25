/**
 * noteDiskChange — what to do when a loaded note changes on disk.
 *
 * | Situation                                   | Action             |
 * |---------------------------------------------|--------------------|
 * | the bytes are our own write coming back     | `ignore`           |
 * | a read caught another program mid-write     | `retry`            |
 * | file gone                                   | `missing`          |
 * | no unsaved body                             | `replace`          |
 * | unsaved body, body on disk unchanged        | `take-frontmatter` |
 * | unsaved body, body on disk changed          | `conflict`         |
 *
 * `replace` swaps the model for the disk version and the views follow;
 * `take-frontmatter` keeps the local body and takes the disk frontmatter;
 * `conflict` is the one prompt (Reload / Keep mine).
 */

export interface DiskChangeInput {
  /** The file is still there. */
  exists: boolean;
  /** The bytes on disk are ones this app wrote (or the model's own base). */
  isOwnWrite: boolean;
  /** The read shows an opening fence but no closing one. */
  torn: boolean;
  /** A body edit hasn't reached disk yet. */
  hasUnsavedBody: boolean;
  /** The body on disk differs from the one the local state was built on. */
  bodyChanged: boolean;
}

export type DiskChangeAction = 'ignore' | 'retry' | 'missing' | 'replace' | 'take-frontmatter' | 'conflict';

export function decideDiskChange(input: DiskChangeInput): DiskChangeAction {
  if (!input.exists) return 'missing';
  if (input.isOwnWrite) return 'ignore';
  if (input.torn) return 'retry';
  if (!input.hasUnsavedBody) return 'replace';
  return input.bodyChanged ? 'conflict' : 'take-frontmatter';
}
