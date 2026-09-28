/**
 * What the user is told when a metadata edit can't land on a note's
 * frontmatter. One wording for the note writer (which keeps the block and
 * drops the edit) and for the views that check first (which then queue
 * nothing), so the same note always gets the same explanation.
 */
import type { FrontmatterRefusal } from '../editor/markdownSync';

export function frontmatterRefusalText(relPath: string, reason: FrontmatterRefusal): string {
  if (reason === 'lossy') {
    return `Couldn't update metadata for "${relPath}": saving it would also change other values in its frontmatter (a number like 02134, a YAML tag or anchor), so the change wasn't saved. Edit that file's frontmatter by hand.`;
  }
  return reason === 'not-properties'
    ? `"${relPath}" starts with a --- block Filo can't read as properties, so this change wasn't saved.`
    : `Couldn't update metadata for "${relPath}": its YAML frontmatter is malformed, so the change wasn't saved. Fix the frontmatter in that file to re-enable metadata edits.`;
}
