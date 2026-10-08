import type { KanbanBoard as KanbanBoardType, Tile } from '../../schema/index';
import { noteTags } from '../../stores/noteMeta';
import { fileTagsStore } from '../../stores/fileTags.svelte';
import { sameTag } from '../vault/sidebarTagFilter';
import { canonicaliseTagName } from '../vault/tagsStorage';
import type { SelectionScope } from '../../stores/selection.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { historyStore } from '../../stores/history.svelte';
import type { Command } from '../../commands/Command';
import {
  BatchCommand,
  DeleteCardCommand,
  MoveCardsCommand,
  AddPathTagCommand,
  AddTileTagCommand,
} from '../../commands/index';
import { buildBulkCardContextMenu } from './kanbanContextMenus';

/**
 * What a bulk "Add tag" did, in the user's words: how many cards took the tag,
 * and why the others didn't (they had it, or are recordings not yet made,
 * whose tags are kept with their file).
 */
export function bulkTagResult(tag: string, added: number, count: { already: number; noFile: number }): string {
  const cards = (n: number): string => `${n} card${n === 1 ? '' : 's'}`;
  const noFile = `${count.noFile === 1 ? '1 audio card has' : `${count.noFile} audio cards have`} nothing recorded yet (a recording keeps its tags with its file)`;
  if (added > 0) {
    return count.noFile > 0 ? `Added #${tag} to ${cards(added)}. Skipped: ${noFile}.` : `Added #${tag} to ${cards(added)}`;
  }
  if (count.noFile === 0) return `All selected cards already have #${tag}`;
  const already = count.already > 0 ? `${cards(count.already)} already ${count.already === 1 ? 'has' : 'have'} it, and ` : '';
  return `#${tag} wasn't added: ${already}${noFile}.`;
}

export interface KanbanMultiSelectDeps {
  /** The pane's selection scope. Bulk actions and the click-toggle both
   * mutate THIS scope, so two panes opening the same Kanban board don't
   * share selection state. */
  selection: SelectionScope;
  getBoardId: () => string | null;
  getColumns: () => KanbanBoardType['columns'];
  getAllTilesById: () => Record<string, Tile>;
  /** Drives Shift-click range selection: ordered list of visible tile IDs. */
  getFlatVisibleTileIds: () => string[];
  bumpCacheVersion: () => void;
  tickAndPersist: () => void;
  ensureSeededFm: (tile: Tile) => string | null;
  vaultPathForTile: (tile: Tile) => string | null;
  /**
   * Opens an in-app text-input popup for the bulk "Add tag" flow and resolves
   * with the entered tag (raw, un-normalised) or `null` if the user cancelled.
   * Injected by `KanbanBoard` because `window.prompt` is unimplemented in
   * Electron's renderer (it throws). The controller stays UI-agnostic; the
   * component owns the popup.
   */
  promptForTag: () => Promise<string | null>;
}

/**
 * Multi-select controller for the Kanban board.
 *
 * Owns the anchor (`lastSelectedTileId`) used by Shift-click range
 * selection plus the bulk-action handlers fired from the bulk context
 * menu. Selection itself lives in `selectionStore` so cross-component
 * selection state (canvas, kanban, task list) shares one source of truth.
 */
export class KanbanMultiSelect {
  lastSelectedTileId = $state<string | null>(null);

  constructor(private deps: KanbanMultiSelectDeps) {}

  /** Returns the column ID containing `tileId`, or null if not on this board. */
  findColumnIdForTile(tileId: string): string | null {
    const columns = this.deps.getColumns();
    for (const col of columns) {
      if ((col.tilePlacements ?? []).some((p) => p.tileId === tileId)) return col.id;
    }
    return null;
  }

  handleTileClick(e: MouseEvent, tileId: string): void {
    if (e.shiftKey && this.lastSelectedTileId) {
      const ids = this.deps.getFlatVisibleTileIds();
      const anchor = ids.indexOf(this.lastSelectedTileId);
      const target = ids.indexOf(tileId);
      if (anchor >= 0 && target >= 0) {
        const lo = Math.min(anchor, target);
        const hi = Math.max(anchor, target);
        this.deps.selection.selectMultiple(ids.slice(lo, hi + 1));
        // Anchor stays put on shift-click — matches standard list semantics
        // (subsequent shift-clicks pivot around the original anchor).
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      this.deps.selection.toggle(tileId);
      this.lastSelectedTileId = this.deps.selection.isSelected(tileId) ? tileId : null;
      return;
    }
    this.deps.selection.select(tileId, false);
    this.lastSelectedTileId = tileId;
  }

  clearSelectionOnBoardClick(e: MouseEvent): void {
    // Only clear when the click landed on the board background itself, not
    // a card or toolbar. The drop-zone / button checks mirror
    // KanbanColumn.handleTileClick's filters.
    const tgt = e.target as HTMLElement | null;
    if (!tgt) return;
    if (tgt.closest('.tile-drop-zone, .side-toolbar, .kanban-find-bar, button, a, input, textarea, select')) {
      return;
    }
    if (this.deps.selection.count > 0) this.deps.selection.clear();
    this.lastSelectedTileId = null;
  }

  /** Cancels any selection + anchor, e.g. on Escape. */
  clearSelectionAndAnchor(): void {
    if (this.deps.selection.count > 0) this.deps.selection.clear();
    this.lastSelectedTileId = null;
  }

  moveSelectedTilesToColumn(targetColumnId: string): void {
    this.moveTilesToColumn(Array.from(this.deps.selection.selectedIds), targetColumnId);
  }

  /** Moves cards to the end of a column, as one undo step (a card's own menu, or the selection's). */
  moveTilesToColumn(selected: string[], targetColumnId: string): void {
    const boardId = this.deps.getBoardId();
    if (!boardId) return;
    const columns = this.deps.getColumns();
    if (selected.length === 0) return;
    const target = columns.find((c) => c.id === targetColumnId);
    if (!target) return;
    // Snapshot the source (column, position) of every tile that's actually
    // moving so undo can replay them home individually. Tiles already in
    // the target column are skipped so undo doesn't shuffle their order.
    const toMove: string[] = [];
    const snapshots: Array<{ tileId: string; fromColumnId: string; fromPosition: number }> = [];
    for (const tileId of selected) {
      const fromColumnId = this.findColumnIdForTile(tileId);
      if (!fromColumnId || fromColumnId === targetColumnId) continue;
      const fromCol = columns.find((c) => c.id === fromColumnId);
      const fromPosition = fromCol?.tilePlacements?.findIndex((p) => p.tileId === tileId) ?? -1;
      if (fromPosition < 0) continue;
      toMove.push(tileId);
      snapshots.push({ tileId, fromColumnId, fromPosition });
    }
    if (toMove.length === 0) return;
    const toPosition = (target.tilePlacements ?? []).length;
    // Single MoveCardsCommand for the whole bulk move so
    // Ctrl+Z reverses every card at once.
    historyStore.execute(new MoveCardsCommand(boardId, toMove, targetColumnId, toPosition, snapshots));
    this.deps.tickAndPersist();
    uiStore.toast(`Moved ${toMove.length} card${toMove.length === 1 ? '' : 's'} to "${target.title}"`, 'success', 2000);
  }

  deleteSelectedTiles(): void {
    const boardId = this.deps.getBoardId();
    if (!boardId) return;
    const selected = Array.from(this.deps.selection.selectedIds);
    if (selected.length === 0) return;
    if (selected.length === 1) {
      // Single-card path uses DeleteCardCommand (it
      // snapshots the placement + def for undo). Mirrors the multi-card
      // path below so context-menu single delete is just as recoverable.
      historyStore.execute(new DeleteCardCommand(boardId, selected[0]!)); // length === 1 checked above
      this.deps.selection.clear();
      this.lastSelectedTileId = null;
      this.deps.tickAndPersist();
      return;
    }
    uiStore.openConfirm({
      title: `Remove ${selected.length} cards from the board?`,
      body: 'The cards leave this board; their notes stay in the vault. Undo puts them back.',
      confirmLabel: 'Remove cards',
      danger: true,
      onConfirm: () => {
        const stillBoardId = this.deps.getBoardId();
        if (!stillBoardId) return;
        // BatchCommand of DeleteCardCommand so Ctrl+Z
        // reverses the bulk delete in one step.
        const commands = selected.map((tileId) => new DeleteCardCommand(stillBoardId, tileId));
        historyStore.execute(new BatchCommand(`Remove ${selected.length} cards`, commands));
        this.deps.selection.clear();
        this.lastSelectedTileId = null;
        this.deps.tickAndPersist();
      },
    });
  }

  async tagSelectedTiles(): Promise<void> {
    const selected = Array.from(this.deps.selection.selectedIds);
    if (selected.length === 0) return;
    // Route through the injected in-app popup, NOT `window.prompt`
    // (unimplemented in Electron's renderer → throws). Resolves null on cancel.
    const tagName = await this.deps.promptForTag();
    if (!tagName) return;
    const norm = tagName.trim().replace(/^#/, '');
    if (!norm) return;
    const boardId = this.deps.getBoardId();
    if (!boardId) return;
    const allTilesById = this.deps.getAllTilesById();
    // The spelling the vault already uses for this tag, if any.
    const tag = canonicaliseTagName(fileTagsStore.file, norm) || norm;

    // One tag-add command per card, run as a single BatchCommand on the
    // history chain, so save()/quit cover every card via whenChainSettled()
    // and the whole bulk add is one undo step. A text card's tag goes through
    // the tag-row writer, which adds it to a fresh read of the note in the form
    // its `tags:` field already has (a list, or text such as `tags: project`),
    // so the tags the note carries are never replaced. A link card keeps its
    // tags on the board, a recording in `.filo/tags.json` by its file.
    const commands: Command[] = [];
    const count = { already: 0, noFile: 0 };
    for (const tileId of selected) {
      const tile = allTilesById[tileId];
      if (!tile) continue;
      const path = this.deps.vaultPathForTile(tile);
      if (path) {
        if (noteTags(path).some((t) => sameTag(t, tag))) count.already++;
        else commands.push(new AddPathTagCommand(path, tag, boardId));
        continue;
      }
      const found = fileTagsStore.findTile(tileId);
      if (!found) continue;
      if (found.tags.some((t) => sameTag(t, tag))) count.already++;
      else if (tile.type === 'audio' && !tile.src) count.noFile++;
      else commands.push(new AddTileTagCommand(tileId, tag, boardId));
    }
    if (commands.length === 0) {
      uiStore.toast(bulkTagResult(tag, 0, count), 'info', 4000);
      return;
    }
    // Crash-safe (whenChainSettled covers the batch on quit) + undoable in one step.
    // Gate the success toast on the chain actually resolving (a rejected batch
    // rolled back). On failure, stay silent here — the chain already surfaced
    // the visual error.
    const ok = await historyStore
      .execute(new BatchCommand(`Add #${tag} to ${commands.length} card${commands.length === 1 ? '' : 's'}`, commands, boardId))
      .then(() => true, () => false);
    this.deps.bumpCacheVersion();
    if (ok) {
      uiStore.toast(bulkTagResult(tag, commands.length, count), 'success', count.noFile > 0 ? 4000 : 2000);
    }
  }

  openBulkContextMenu(at: { x: number; y: number }, _tileId: string): void {
    void _tileId;
    // The menu has no submenus, so the move targets sit inline under their
    // own heading.
    const items = buildBulkCardContextMenu({
      count: this.deps.selection.count,
      columns: this.deps.getColumns(),
      onAddTag: () => { void this.tagSelectedTiles(); },
      onRemove: () => this.deleteSelectedTiles(),
      onMoveTo: (columnId) => this.moveSelectedTilesToColumn(columnId),
    });
    uiStore.showContextMenu(at.x, at.y, items);
  }
}
