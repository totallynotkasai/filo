/**
 * Selection store — manages selected tile IDs and selection box for drag-select.
 *
 * Each `BoardScope` owns its own `SelectionScope` instance (so two panes can
 * hold independent selections). The exported `selectionStore` is a global
 * facade Proxy that delegates to the active scope.
 */
import { SvelteSet } from 'svelte/reactivity';
import { getActiveScope, makeFacade } from '../lib/boards/boardScope.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';

export interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface SelectionScope {
  readonly selectedIds: SvelteSet<string>;
  readonly selectedConnectionIds: SvelteSet<string>;
  readonly count: number;
  readonly connectionCount: number;
  readonly selectionBox: SelectionBox | null;
  readonly hasSelection: boolean;
  readonly boxRect: {
    left: number; top: number; right: number; bottom: number;
    width: number; height: number;
  } | null;
  isSelected(id: string): boolean;
  select(id: string, additive?: boolean): void;
  deselect(id: string): void;
  toggle(id: string): void;
  selectMultiple(ids: string[]): void;
  addMultiple(ids: string[]): void;
  clear(): void;
  selectConnection(connId: string, additive?: boolean): void;
  deselectConnection(connId: string): void;
  toggleConnection(connId: string): void;
  addConnectionIds(ids: string[]): void;
  clearConnections(): void;
  startBox(x: number, y: number): void;
  updateBox(x: number, y: number): void;
  endBox(): void;
}

function replaceSet<T>(set: SvelteSet<T>, next: Iterable<T>): void {
  set.clear();
  for (const item of next) set.add(item);
}

/**
 * Symmetric-difference set update. Cheaper than `replaceSet` for
 * marquee-selection on dense boards: reactive notifications fire only on
 * actual additions/removals, not on an intermediate clear+readd.
 */
function diffSet<T>(set: SvelteSet<T>, next: Iterable<T>): void {
  const nextSet = next instanceof Set ? (next as Set<T>) : new Set(next);
  for (const id of nextSet) {
    if (!set.has(id)) set.add(id);
  }
  for (const id of set) {
    if (!nextSet.has(id)) set.delete(id);
  }
}

/**
 * Factory: creates a fresh per-pane selection scope. Called from
 * `createBoardScope()` in `boardScope.svelte.ts`.
 */
export function createSelectionScope(): SelectionScope {
  const selectedIds = new SvelteSet<string>();
  const selectedConnectionIds = new SvelteSet<string>();
  let selectionBox = $state<SelectionBox | null>(null);

  const store: SelectionScope = {
    get selectedIds() { return selectedIds; },
    get selectedConnectionIds() { return selectedConnectionIds; },
    get count() { return selectedIds.size; },
    get connectionCount() { return selectedConnectionIds.size; },
    get selectionBox() { return selectionBox; },
    get hasSelection() { return selectedIds.size > 0 || selectedConnectionIds.size > 0; },

    isSelected(id: string): boolean {
      return selectedIds.has(id);
    },

    select(id: string, additive = false) {
      if (additive) {
        selectedIds.add(id);
      } else {
        replaceSet(selectedIds, [id]);
      }
    },

    deselect(id: string) {
      selectedIds.delete(id);
    },

    toggle(id: string) {
      if (selectedIds.has(id)) {
        store.deselect(id);
      } else {
        store.select(id, true);
      }
    },

    selectMultiple(ids: string[]) {
      diffSet(selectedIds, ids);
    },

    addMultiple(ids: string[]) {
      for (const id of ids) selectedIds.add(id);
    },

    clear() {
      selectedIds.clear();
      selectedConnectionIds.clear();
      selectionBox = null;
    },

    selectConnection(connId: string, additive = false) {
      if (additive) {
        selectedConnectionIds.add(connId);
      } else {
        replaceSet(selectedConnectionIds, [connId]);
      }
    },

    deselectConnection(connId: string) {
      selectedConnectionIds.delete(connId);
    },

    toggleConnection(connId: string) {
      if (selectedConnectionIds.has(connId)) {
        store.deselectConnection(connId);
      } else {
        store.selectConnection(connId, true);
      }
    },

    addConnectionIds(ids: string[]) {
      for (const id of ids) selectedConnectionIds.add(id);
    },

    clearConnections() {
      selectedConnectionIds.clear();
    },

    startBox(x: number, y: number) {
      selectionBox = { startX: x, startY: y, endX: x, endY: y };
    },

    updateBox(x: number, y: number) {
      if (selectionBox) {
        selectionBox = { ...selectionBox, endX: x, endY: y };
      }
    },

    endBox() {
      selectionBox = null;
    },

    get boxRect() {
      if (!selectionBox) return null;
      return {
        left: Math.min(selectionBox.startX, selectionBox.endX),
        top: Math.min(selectionBox.startY, selectionBox.endY),
        right: Math.max(selectionBox.startX, selectionBox.endX),
        bottom: Math.max(selectionBox.startY, selectionBox.endY),
        width: Math.abs(selectionBox.endX - selectionBox.startX),
        height: Math.abs(selectionBox.endY - selectionBox.startY),
      };
    },
  };
  return store;
}

/**
 * Global facade — every property access delegates to the active pane's
 * selection scope.
 */
export const selectionStore: SelectionScope = makeFacade(() => getActiveScope().selection);

// Vault-swap reset: drops the active pane's selection state. Per-pane scopes that get torn
// down on workspace re-hydration release their own state automatically;
// this handler covers the still-mounted active pane during the swap.
onVaultSwap('pre-swap', 'selection', () => {
  selectionStore.clear();
});
