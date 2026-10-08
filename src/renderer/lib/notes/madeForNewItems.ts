/**
 * The notes Filo made in this session for a new tile, card or task. Undoing
 * that add may move such a note to Filo's trash while it is still as Filo made
 * it (`commands/newNoteUndo.ts`); a note the user made, dropped or brought in
 * some other way is never one of them, so an undo never trashes it.
 *
 * Each keeps the text it was created with, so the undo can tell whether
 * anything was added since: a tag or a field set in another view (a Document
 * tab, the Raw view) makes it the user's note, even with no body.
 *
 * Kept by vault path, following renames; a vault swap forgets them.
 */
import { vaultSwapResettable } from '../../core/vaultLifecycle';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { rebasePath, registerPathRenamable } from '../vault/renamePathKeys';
import { readNoteText } from './noteFile';

interface MadeNote {
  /** The path as spelled. */
  path: string;
  /** The text Filo created it with. */
  seed: string;
}

const made = new Map<VaultPath, MadeNote>();

vaultSwapResettable('madeForNewItems', () => {
  made.clear();
});

registerPathRenamable('madeForNewItems', (oldRel, newRel) => {
  for (const [key, note] of [...made]) {
    const next = rebasePath(note.path, oldRel, newRel);
    if (next === null) continue;
    made.delete(key);
    made.set(vaultPath(next), { ...note, path: next });
  }
});

/** The note at `relPath` was just made, with the text `seed`, for a new tile, card or task. */
export function noteMadeForNewItem(relPath: string, seed: string): void {
  if (relPath) made.set(vaultPath(relPath), { path: relPath, seed });
}

/** Whether Filo made the note at `relPath` for a new tile, card or task in this session. */
export function isNoteMadeForNewItem(relPath: string): boolean {
  return !!relPath && made.has(vaultPath(relPath));
}

/** The text Filo made the note at `relPath` with, or null when it didn't make it. */
export function newItemSeed(relPath: string): string | null {
  return relPath ? (made.get(vaultPath(relPath))?.seed ?? null) : null;
}

/** JSON with every object's keys in order, so two equal values always print alike. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Whether `frontmatter` is still exactly what Filo made the note at `relPath` with. */
export function frontmatterAsMade(relPath: string, frontmatter: Readonly<Record<string, unknown>>): boolean {
  const seed = newItemSeed(relPath);
  if (seed === null) return false;
  return stableJson(readNoteText(seed).frontmatter) === stableJson(frontmatter);
}
