/**
 * Writes one tag add/remove into a note's frontmatter. The note's file is the
 * only copy of its tags, so this is the whole change: the note writer applies
 * the source-preserving rewriter (only the `tags:` entry changes) to a fresh
 * read of the file, inside the note's queue, then re-indexes it and updates
 * any open view of the note.
 */
import { addTagToMarkdown, removeTagFromMarkdown } from '../vault/tagRewriter';
import { reportError } from '../utils/errorBus';
import { isMissingFileError } from '../notes/noteWriter';
import { noteStore } from '../../stores/notes.svelte';

export async function writeTagChangeToMarkdownPath(
  relPath: string,
  tagName: string,
  operation: 'add' | 'remove',
): Promise<void> {
  if (!relPath) return;
  try {
    await noteStore.transform(relPath, (fresh) =>
      operation === 'add' ? addTagToMarkdown(fresh.raw, tagName) : removeTagFromMarkdown(fresh.raw, tagName),
    );
  } catch (err) {
    // A note deleted meanwhile has no tags to change.
    if (isMissingFileError(err)) return;
    reportError('fileTagsStore', err, `Failed to write tag change to ${relPath}`);
  }
}
