/**
 * The 3-way merge for `.filo/tags.json` (pure; split out of
 * `stores/fileTags.svelte.ts` for its file-size ceiling).
 *
 * Used by the external-reload path (`applyExternalReload`) and by the
 * debounced save's pre-write merge: another machine's
 * tags.json that lands inside the self-write window (or while a local change
 * is still debounced) is merged in instead of blindly overwritten.
 */
import type { TagsFile } from '../../schema/tagsFile';

export function cloneTagsFile(f: TagsFile): TagsFile {
  return JSON.parse(JSON.stringify(f)) as TagsFile;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Re-applies OUR delta (`ours` vs `base`) on top of `merged` (a clone of the
 * external `theirs`): our adds/changes overwrite, our removals delete. Entries
 * neither side of our delta touched keep the external value, so a genuine
 * external edit survives while a pending in-app mutation isn't lost. A true
 * same-key conflict resolves to OUR value (the user's in-app intent).
 */
function reapplyTagDelta(
  base: Record<string, unknown>,
  ours: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  for (const key of Object.keys(ours)) {
    if (!sameJson(ours[key], base[key])) merged[key] = ours[key];
  }
  for (const key of Object.keys(base)) {
    if (!(key in ours)) delete merged[key];
  }
}

/**
 * 3-way merge of `.filo/tags.json`. `base` = last persisted/loaded state,
 * `ours` = live in-memory (`base` + un-flushed mutations), `theirs` = the
 * external disk copy. Preserves un-flushed tag adds/removes (attachment tags
 * have no other home) instead of a wholesale overwrite.
 */
export function mergeTagsThreeWay(base: TagsFile, ours: TagsFile, theirs: TagsFile): TagsFile {
  const merged = cloneTagsFile(theirs);
  reapplyTagDelta(
    base.tags as Record<string, unknown>,
    ours.tags as Record<string, unknown>,
    merged.tags as Record<string, unknown>,
  );
  reapplyTagDelta(
    base.fileTags as Record<string, unknown>,
    ours.fileTags as Record<string, unknown>,
    merged.fileTags as Record<string, unknown>,
  );
  return merged;
}
