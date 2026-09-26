import { localNoteText } from './noteFile';
import { noteStore } from '../../stores/notes.svelte';

/**
 * Puts back the missing note a text tile points at, at the same path, so the
 * tile works again. The create is exclusive: if a file has come back there
 * meanwhile, nothing is overwritten and the result is `exists`.
 *
 * A note this session read keeps the frontmatter it last had on disk and any
 * local body; one it never read starts as an empty note titled by its name.
 */
export async function recreateMissingNote(relPath: string): Promise<'created' | 'exists'> {
  const m = noteStore.get(relPath);
  const stem = (relPath.split('/').pop() ?? relPath).replace(/\.(md|markdown)$/i, '');
  const text = localNoteText(m?.base, { title: stem, ...(m?.frontmatter ?? {}) }, m?.body);
  const outcome = await noteStore.recreate(relPath, text);
  // Every view of the note was showing it as missing; read it back in.
  if (outcome === 'created' && m) await noteStore.reload(relPath);
  return outcome;
}
