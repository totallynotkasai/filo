/**
 * The note a new tile, card or task was made with, when its add is undone.
 *
 * A note Filo made for the add (`madeForNewItems.ts`) that is still empty,
 * whose frontmatter is still what Filo made it with, and that no tile on any
 * board shows any more held nothing the user wrote: left behind, it would
 * stay in the vault as "New Tile 4.md" for good. So the undo moves it to
 * Filo's trash and the redo brings it back before the item returns, as a
 * delete with its file does. A note with text in it, a tag or field set in
 * another view, or one another tile shows, stays where it is.
 */
import { restoreFiles, stillTrashed, trashFiles, type TrashedItem } from './trashedFiles';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { noteStore } from '../stores/notes.svelte';
import { noteBody } from '../stores/noteMeta';
import { frontmatterAsMade, isNoteMadeForNewItem, newItemSeed, noteMadeForNewItem } from '../lib/notes/madeForNewItems';
import { vaultPath } from '../../shared/vaultPath';

/** Whether any tile on any loaded board shows the file at `relPath`. */
function shownOnABoard(relPath: string): boolean {
  const key = vaultPath(relPath);
  for (const data of Object.values(boardCacheStore.cache)) {
    for (const def of Object.values(data.tileDefs ?? {})) {
      const file = (def as { filePath?: unknown }).filePath;
      if (typeof file === 'string' && file && vaultPath(file) === key) return true;
    }
  }
  return false;
}

export class NewNoteUndo {
  private trashed: TrashedItem[] = [];
  /** The text the trashed note was made with, so the redo's note counts as made for the item again. */
  private seed: string | null = null;
  private readonly vaultRoot: string;

  constructor() {
    this.vaultRoot = vaultStore.path;
  }

  /** Whether the undo moved the note to the trash (so the redo must bring it back first). */
  get trashedNote(): boolean {
    return this.trashed.length > 0;
  }

  /** Run by undo once the item has left its board. */
  async trashIfUnused(notePath: string | null | undefined, context: string): Promise<void> {
    if (!notePath || !this.vaultRoot || vaultStore.path !== this.vaultRoot) return;
    if (!isNoteMadeForNewItem(notePath)) return;
    if (noteBody(notePath).trim() !== '' || shownOnABoard(notePath)) return;
    // Read from the file, not a view's copy: a tag set in a Document tab or
    // the Raw view may not have reached the index yet. Unreadable: kept.
    const frontmatter = await noteStore.currentFrontmatter(notePath, { fromDisk: true });
    if (!frontmatter || !frontmatterAsMade(notePath, frontmatter) || vaultStore.path !== this.vaultRoot) return;
    if (noteBody(notePath).trim() !== '' || shownOnABoard(notePath)) return;
    this.seed = newItemSeed(notePath);
    this.trashed = await trashFiles(this.vaultRoot, [notePath], context);
  }

  /**
   * Run by redo before the item goes back: the note returns from the trash.
   * Where it landed (beside its old name when that was taken meanwhile), or
   * null when nothing was trashed.
   */
  async restore(context: string): Promise<string | null> {
    if (this.trashed.length === 0 || vaultStore.path !== this.vaultRoot) return null;
    const items = this.trashed;
    const restored = await restoreFiles(this.vaultRoot, items, context);
    this.trashed = stillTrashed(items, restored);
    const landed = restored[0]?.restoredPath ?? null;
    // Still the add's own note: a later undo may trash it again.
    if (landed && this.seed !== null) noteMadeForNewItem(landed, this.seed);
    return landed;
  }
}
