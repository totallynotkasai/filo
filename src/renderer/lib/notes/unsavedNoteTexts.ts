/**
 * unsavedNoteTexts — the text a rescue copy holds for each note with a change
 * that hasn't reached disk.
 *
 * A note a model holds is its last frontmatter with the queued change applied,
 * over the local body. A queued frontmatter change to a note no model holds is
 * laid over a fresh read of the file (only the changed keys when it can't be
 * read).
 */
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { applyFrontmatterDelta } from '../vault/frontmatterDelta';
import { localNoteText, newNoteText, snapshotOf, type DiskSnapshot } from './noteFile';
import { readNoteFresh, type NoteWriter } from './noteWriter';

/** The parts of a note model a rescue copy is built from. */
export interface RescuableNote {
  relPath: string;
  path: VaultPath;
  hasUnsavedBody: boolean;
  base: DiskSnapshot | undefined;
  frontmatter: Record<string, unknown>;
  body: string;
}

export async function unsavedNoteTexts(
  models: Iterable<RescuableNote>,
  writer: Pick<NoteWriter, 'hasPendingBody' | 'pendingDelta' | 'queuedPaths'>,
  vaultRoot: string | null,
): Promise<Array<{ relPath: string; text: string }>> {
  const out: Array<{ relPath: string; text: string }> = [];
  const seen = new Set<VaultPath>();
  for (const m of models) {
    if (!m.hasUnsavedBody && !writer.hasPendingBody(m.path)) continue;
    seen.add(m.path);
    out.push({ relPath: m.relPath, text: localNoteText(m.base, m.frontmatter, m.body, writer.pendingDelta(m.path)) });
  }
  for (const relPath of writer.queuedPaths()) {
    const key = vaultPath(relPath);
    const delta = writer.pendingDelta(key);
    if (seen.has(key) || !delta) continue;
    let text = newNoteText(applyFrontmatterDelta({}, delta), '');
    if (vaultRoot) {
      try {
        const fresh = await readNoteFresh(vaultRoot, relPath);
        if (!fresh.nonUtf8) text = localNoteText(snapshotOf(fresh.text), {}, undefined, delta);
      } catch {
        // Gone or unreadable: the copy holds the changed keys alone.
      }
    }
    out.push({ relPath, text });
  }
  return out;
}
