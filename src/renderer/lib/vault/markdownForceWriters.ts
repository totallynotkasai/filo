/**
 * Force-writer registry for the markdown write gateway.
 *
 * Editor-backed writers (TextTile, DocumentEditor) register a callback that
 * returns their LATEST write args (live editor body + current frontmatter),
 * keyed by callerId and tagged with the note it edits. Keep-local and the
 * cancel helpers in `markdownFileWriter` find a note's editors here, so they
 * act on exactly what the user sees rather than a stale schedule snapshot.
 *
 * Non-editor callers (PropertiesPopup, orphan-fm sites) don't register: they
 * always call `writeMarkdownFile` / `scheduleMarkdownWrite` with fresh args.
 */
import { vaultPath } from '@shared/vaultPath';
import { registerPathRenamable } from './renamePathKeys';
import type { WriteArgs } from './markdownFileWriter';

interface ForceWriter {
  notePath: string | null;
  build: () => WriteArgs | null;
}

// allow-module-state: cleared by clearForceWriters from cancelAllMarkdownWrites at vault swap
const forceWriters = new Map<string, ForceWriter>();

/**
 * Registers a fresh-args callback for `callerId`. The gateway calls `build()`
 * from `forceWriteForDocument(notePath)` to obtain the live editor body + the
 * latest frontmatter, then writes via the canonical pipeline.
 *
 * Components register in onMount and unregister in onDestroy. The note path
 * may be null (a writer with no note yet). Matching happens at call time, and
 * a rename carries every registered path to the new one, so a writer
 * registered once keeps matching its note.
 */
export function registerForceWriter(
  callerId: string,
  notePath: string | null,
  build: () => WriteArgs | null,
): void {
  forceWriters.set(callerId, { notePath, build });
}

export function unregisterForceWriter(callerId: string): void {
  forceWriters.delete(callerId);
}

/** Drops every registration (vault swap / test reset). */
export function clearForceWriters(): void {
  forceWriters.clear();
}

/** True when both paths name the same note (case-folded vault paths). */
export function sameNote(a: string | null | undefined, b: string): boolean {
  return !!a && vaultPath(a) === vaultPath(b);
}

/** The `[callerId, build]` pairs of every writer registered on the note at `notePath`. */
export function forceWritersFor(notePath: string): Array<[string, () => WriteArgs | null]> {
  const out: Array<[string, () => WriteArgs | null]> = [];
  for (const [callerId, entry] of forceWriters) {
    if (sameNote(entry.notePath, notePath)) out.push([callerId, entry.build]);
  }
  return out;
}

/**
 * Carries each registered writer's note path across a rename (the file itself
 * and, for a folder rename, every note under it), so Keep-local and the
 * cancel helpers still reach an editor whose note moved after it registered.
 */
function renameForceWriterPaths(oldRel: string, newRel: string): void {
  const oldKey = vaultPath(oldRel);
  const oldPrefix = `${oldKey}/`;
  for (const [callerId, entry] of forceWriters) {
    if (!entry.notePath) continue;
    const key = vaultPath(entry.notePath);
    if (key === oldKey) forceWriters.set(callerId, { ...entry, notePath: newRel });
    else if (key.startsWith(oldPrefix)) {
      forceWriters.set(callerId, { ...entry, notePath: newRel + entry.notePath.slice(oldRel.length) });
    }
  }
}

registerPathRenamable('markdownFileWriter.forceWriters', renameForceWriterPaths);
