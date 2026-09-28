/**
 * Writes one tag add/remove into a note's frontmatter. The note's file is the
 * only copy of its tags, so this is the whole change: the note writer applies
 * the source-preserving rewriter (only the `tags:` entry changes) to a fresh
 * read of the file, inside the note's queue, then re-indexes it and updates
 * any open view of the note.
 *
 * A note that can't take the change (frontmatter the rewriter won't touch, a
 * note that isn't UTF-8 or is a link, an edit of it still unsaved) rejects
 * with `ChangeRefusedError`: the tag command that asked is taken off the undo
 * stack and the user is told why, instead of a step that did nothing.
 */
import { addTagToMarkdown, removeTagFromMarkdown, tagsEqual } from '../vault/tagRewriter';
import { parseTagsField } from '../utils/normalizeTagsField';
import { reportError } from '../utils/errorBus';
import { isMissingFileError, NoteBusyError } from '../notes/noteWriter';
import { isLinkedNote, isNonUtf8 } from '../vault/nonUtf8Paths.svelte';
import { ChangeRefusedError } from '../../commands/changeRefusedError';
import { frontmatterSourceProblem } from '../vault/frontmatterCstModel';
import { frontmatterRefusalText } from '../notes/frontmatterRefusal';
import type { FrontmatterRefusal } from '../editor/markdownSync';
import { noteStore } from '../../stores/notes.svelte';

export async function writeTagChangeToMarkdownPath(
  relPath: string,
  tagName: string,
  operation: 'add' | 'remove',
): Promise<void> {
  if (!relPath) return;
  const verb = operation === 'add' ? 'add' : 'remove';
  const couldnt = `Couldn't ${verb} the tag "${tagName}" ${operation === 'add' ? 'to' : 'from'} "${relPath}"`;
  let ran = false;
  let refused: FrontmatterRefusal | null = null;
  try {
    await noteStore.transform(relPath, (fresh) => {
      ran = true;
      const next = operation === 'add' ? addTagToMarkdown(fresh.raw, tagName) : removeTagFromMarkdown(fresh.raw, tagName);
      // Unchanged although the note doesn't already say what was asked: the
      // rewriter refused its frontmatter.
      if (next === fresh.raw && tagChangeNeeded(fresh.frontmatter, tagName, operation)) {
        refused = frontmatterSourceProblem(fresh.rawFrontmatter) ?? 'unparseable';
      }
      return next;
    });
  } catch (err) {
    // A note deleted meanwhile has no tags to change.
    if (isMissingFileError(err)) return;
    if (err instanceof NoteBusyError) throw new ChangeRefusedError(`${couldnt}: an edit of it isn't saved yet.`);
    reportError('fileTagsStore', err, `Failed to write tag change to ${relPath}`, relPath);
    return;
  }
  if (refused) throw new ChangeRefusedError(frontmatterRefusalText(relPath, refused));
  // The writer leaves a read-only note alone without asking the rewriter.
  if (!ran && isNonUtf8(relPath)) throw new ChangeRefusedError(`${couldnt}: it isn't UTF-8 text. Use "Convert to UTF-8" first.`);
  if (!ran && isLinkedNote(relPath)) throw new ChangeRefusedError(`${couldnt}: it is a link to another file. Edit the original.`);
}

/** True when the note's tags don't already say what `operation` asks. */
function tagChangeNeeded(frontmatter: Record<string, unknown>, tagName: string, operation: 'add' | 'remove'): boolean {
  const bare = tagName.replace(/^#/, '').trim();
  const has = parseTagsField(frontmatter.tags).tags.some((t) => tagsEqual(t.replace(/^#/, ''), bare));
  return operation === 'add' ? !has : has;
}
