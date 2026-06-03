import type { KanbanBoard as KanbanBoardType, Tile } from '../../schema/index';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { documentStore } from '../../stores/document.svelte';
import type { SelectionScope } from '../../stores/selection.svelte';
import { uiStore } from '../../stores/ui.svelte';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { scheduleFrontmatterWrite as scheduleSharedFrontmatterWrite } from '../boards/frontmatterWriteScheduler';
import { seedDocumentFrontmatterFromDisk } from '../boards/seedFrontmatterFromDisk';
import { historyStore } from '../../stores/history.svelte';
import { BatchCommand, DeleteCardCommand, MoveCardsCommand } from '../../commands/index';

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
    // Phase 16 / H5 — single MoveCardsCommand for the whole bulk move so
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
      // Phase 16 / H5 — single-card path uses DeleteCardCommand (it
      // snapshots the placement + def for undo). Mirrors the multi-card
      // path below so context-menu single delete is just as recoverable.
      historyStore.execute(new DeleteCardCommand(boardId, selected[0]));
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
        // Phase 16 / H5 — BatchCommand of DeleteCardCommand so Ctrl+Z
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
    const tagName = window.prompt('Add tag to selected cards (without leading #):');
    if (!tagName) return;
    const norm = tagName.trim().replace(/^#/, '');
    if (!norm) return;
    const allTilesById = this.deps.getAllTilesById();
    let updated = 0;
    for (const tileId of selected) {
      const tile = allTilesById[tileId];
      if (!tile) continue;
      const path = this.deps.vaultPathForTile(tile);
      if (!path) continue;
      // Audit-6 M4 — seed FM from a fresh disk read before the index-seed so a
      // bulk tag add doesn't drop a key an external editor added since the last
      // index rebuild (same hazard as the field-edit writers). No-op for an
      // already-seeded / open-editor card or on a disk read failure.
      await seedDocumentFrontmatterFromDisk(
        (tile as Tile & { contentId?: string }).contentId ?? null,
        vaultStore.path,
        path,
      );
      const docId = this.deps.ensureSeededFm(tile);
      const fm = (docId ? documentStore.getFrontmatter(docId) : null)
        ?? (vaultIndexStore.getMetadata(path)?.frontmatter ?? {});
      const existing = Array.isArray((fm as Record<string, unknown>).tags)
        ? ((fm as Record<string, unknown>).tags as unknown[]).map((t) => String(t).replace(/^#/, ''))
        : [];
      if (existing.includes(norm)) continue;
      const nextTags = [...existing, norm];
      if (docId) documentStore.mergeFrontmatter(docId, { tags: nextTags });
      scheduleSharedFrontmatterWrite(path, docId);
      updated++;
    }
    this.deps.bumpCacheVersion();
    if (updated > 0) {
      uiStore.toast(`Added #${norm} to ${updated} card(s)`, 'success', 2000);
    } else {
      uiStore.toast(`All selected cards already have #${norm}`, 'info', 2000);
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
