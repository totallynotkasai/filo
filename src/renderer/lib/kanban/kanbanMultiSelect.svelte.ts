import type { KanbanBoard as KanbanBoardType, Tile } from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import type { SelectionScope } from '../../stores/selection.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { historyStore } from '../../stores/history.svelte';
import type { Command } from '../../commands/Command';
import {
  BatchCommand,
  DeleteCardCommand,
  MoveCardsCommand,
  UpdateCardFieldCommand,
  UpdateOrphanFrontmatterCommand,
} from '../../commands/index';

import { resolveTextTileVaultPath } from '../boards/textTilePath';
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
    const boardId = this.deps.getBoardId();
    if (!boardId) return;
    const columns = this.deps.getColumns();
    const selected = Array.from(this.deps.selection.selectedIds);
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
    uiStore.toast(`Moved ${toMove.length} card(s) to "${target.title}"`, 'success', 2000);
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
      body: 'The backing vault files are kept — only the column placements are removed. You can undo via the toolbar history if you change your mind.',
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

    // Build one field command per card and run them as a single BatchCommand.
    // Each UpdateCardFieldCommand seeds the FM from disk INSIDE its own
    // execute() (on the history chain), so save()/quit cover every card via
    // whenChainSettled() — a quit mid-loop can't lose later cards' tags — and
    // the whole bulk add is one undo step.
    //
    // The `tags` patch is computed up front from the best-available source — the
    // live cache when an open editor / prior edit seeded it, else the vault-index
    // snapshot. A card whose disk frontmatter carries a tag the stale index never
    // learned would have that one external tag dropped by the additive patch —
    // the same narrow index-staleness edge every field-edit command's patch
    // carries; acceptable for a bulk convenience op.
    const commands: Command[] = [];
    for (const tileId of selected) {
      const tile = allTilesById[tileId];
      if (!tile) continue;
      const path = this.deps.vaultPathForTile(tile);
      if (!path) continue;
      const notePath = resolveTextTileVaultPath(tile);
      const fm = (notePath ? documentStore.getFrontmatter(notePath) : undefined)
        ?? (vaultIndexStore.getMetadata(path)?.frontmatter ?? {});
      const existing = Array.isArray((fm as Record<string, unknown>).tags)
        ? ((fm as Record<string, unknown>).tags as unknown[]).map((t) => String(t).replace(/^#/, ''))
        : [];
      if (existing.includes(norm)) continue;
      const nextTags = [...existing, norm];
      const desc = `Add #${norm}`;
      commands.push(
        notePath
          ? new UpdateCardFieldCommand(boardId, path, notePath, { tags: nextTags }, { tags: existing }, desc)
          : new UpdateOrphanFrontmatterCommand(boardId, path, { tags: nextTags }, { tags: existing }, desc),
      );
    }
    if (commands.length === 0) {
      uiStore.toast(`All selected cards already have #${norm}`, 'info', 2000);
      return;
    }
    // Crash-safe (whenChainSettled covers the batch on quit) + undoable in one step.
    // Gate the success toast on the chain actually resolving (a rejected batch
    // rolled back). On failure, stay silent here — the chain already surfaced
    // the visual error.
    const ok = await historyStore
      .execute(new BatchCommand(`Add #${norm} to ${commands.length} card(s)`, commands, boardId))
      .then(() => true, () => false);
    this.deps.bumpCacheVersion();
    if (ok) {
      uiStore.toast(`Added #${norm} to ${commands.length} card(s)`, 'success', 2000);
    }
  }

  openBulkContextMenu(e: MouseEvent, _tileId: string): void {
    void _tileId;
    const count = this.deps.selection.count;
    const columns = this.deps.getColumns();
    const moveItems = columns.map((c) => ({
      id: `move-to-${c.id}`,
      label: c.title,
      action: () => this.moveSelectedTilesToColumn(c.id),
    }));
    // Compose a flat menu with the move targets inline. uiStore.showContextMenu
    // doesn't support submenus, so we prefix the move items with a label and
    // append delete / tag at the end. This matches how the Mind Map bulk
    // menu renders today.
    const items = [
      { id: 'count', label: `${count} card(s) selected`, disabled: true },
      { id: 'div1', label: '', divider: true },
      { id: 'move-header', label: 'Move to column', disabled: true },
      ...moveItems,
      { id: 'div2', label: '', divider: true },
      { id: 'tag', label: 'Add Tag…', action: () => this.tagSelectedTiles() },
      {
        id: 'delete',
        label: count > 1 ? `Remove ${count} Cards` : 'Remove Card',
        danger: true,
        action: () => this.deleteSelectedTiles(),
      },
    ];
    uiStore.showContextMenu(e.clientX, e.clientY, items);
  }
}
