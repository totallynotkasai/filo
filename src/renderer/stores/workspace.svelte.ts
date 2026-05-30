/**
 * Workspace store — persisted layout state that belongs to "the window",
 * not the project. Split-pane tree, sidebar width, active pane id.
 * Persisted to `.filo/workspace.json` alongside open-tab state.
 *
 * A pane leaf references a tab id (the tab's board determines what's
 * rendered). The active pane determines which tab is the focused tab
 * globally — only the active pane hosts a live, editable board view.
 */

import { createId } from '../lib/utils/ids';
import { onVaultSwap } from '../core/vaultLifecycle';

export interface PaneLeaf {
  type: 'leaf';
  id: string;
  /** The tab id this leaf shows. Must exist in tabStore when rendered. */
  tabId: string;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  orientation: 'horizontal' | 'vertical';
  /** Relative sizes per child, summing to 1.0. */
  sizes: number[];
  children: PaneNode[];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface WorkspaceLayout {
  paneTree: PaneNode | null;
  activePaneId: string | null;
  sidebarWidth: number;
}

const DEFAULT_LAYOUT: WorkspaceLayout = {
  paneTree: null,
  activePaneId: null,
  sidebarWidth: 260,
};

const MAX_LEAVES = 3;

let layout = $state<WorkspaceLayout>({ ...DEFAULT_LAYOUT });

let onChangeListener: (() => void) | null = null;

function notify() {
  onChangeListener?.();
}

// ── Pure helpers over the pane tree ──

function countLeaves(node: PaneNode | null): number {
  if (!node) return 0;
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

function collectLeaves(node: PaneNode | null): PaneLeaf[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node];
  return node.children.flatMap(collectLeaves);
}

function findLeaf(node: PaneNode | null, paneId: string): PaneLeaf | null {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

/**
 * Returns a fresh tree in which `replacerFn(leaf)` substitutes any matching
 * leaf. If the replacement is `null` the leaf is dropped. Splits that collapse
 * to a single child are replaced by that child.
 */
function transformLeaf(
  node: PaneNode,
  leafId: string,
  replacerFn: (leaf: PaneLeaf) => PaneNode | null,
): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === leafId ? replacerFn(node) : node;
  }
  const newChildren: PaneNode[] = [];
  const newSizes: number[] = [];
  node.children.forEach((child, i) => {
    const transformed = transformLeaf(child, leafId, replacerFn);
    if (transformed) {
      newChildren.push(transformed);
      newSizes.push(node.sizes[i] ?? 1 / node.children.length);
    }
  });
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  const totalSize = newSizes.reduce((s, v) => s + v, 0) || 1;
  return { ...node, children: newChildren, sizes: newSizes.map((s) => s / totalSize) };
}

/**
 * Creates a split around the given leaf: old leaf + new leaf, in the chosen
 * direction. Direction 'right' / 'down' appends the new leaf after the old one;
 * 'left' / 'up' prepends it.
 */
function splitAtLeaf(leaf: PaneLeaf, newTabId: string, direction: 'left' | 'right' | 'up' | 'down'): PaneSplit {
  const newLeaf: PaneLeaf = { type: 'leaf', id: createId(), tabId: newTabId };
  const orientation = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const children: PaneNode[] = direction === 'right' || direction === 'down' ? [leaf, newLeaf] : [newLeaf, leaf];
  return {
    type: 'split',
    id: createId(),
    orientation,
    sizes: [0.5, 0.5],
    children,
  };
}

/** Walks the tree looking for a split that directly contains the leaf and returns its index. */
function findParentOfLeaf(node: PaneNode | null, leafId: string): { parent: PaneSplit; index: number } | null {
  if (!node || node.type === 'leaf') return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.type === 'leaf' && child.id === leafId) return { parent: node, index: i };
  }
  for (const child of node.children) {
    const found = findParentOfLeaf(child, leafId);
    if (found) return found;
  }
  return null;
}

// ── Public API ──

export const workspaceStore = {
  get layout() { return layout; },
  get sidebarWidth() { return layout.sidebarWidth; },
  get activePaneId() { return layout.activePaneId; },
  get paneTree() { return layout.paneTree; },
  get leafCount() { return countLeaves(layout.paneTree); },
  get leaves() { return collectLeaves(layout.paneTree); },

  /** The leaf for the currently active pane (or the sole leaf if only one exists). */
  get activeLeaf(): PaneLeaf | null {
    const leaves = collectLeaves(layout.paneTree);
    if (leaves.length === 0) return null;
    if (layout.activePaneId) {
      return leaves.find((l) => l.id === layout.activePaneId) ?? leaves[0];
    }
    return leaves[0];
  },

  setChangeListener(fn: (() => void) | null) {
    onChangeListener = fn;
  },

  setSidebarWidth(width: number) {
    if (width < 120 || width > 800) return;
    layout = { ...layout, sidebarWidth: width };
    notify();
  },

  setActivePane(paneId: string | null) {
    if (layout.activePaneId === paneId) return;
    layout = { ...layout, activePaneId: paneId };
    notify();
  },

  /**
   * Initialises the pane tree to a single leaf referencing the given tab.
   * No-op if the tree already exists.
   */
  ensureRoot(tabId: string) {
    if (layout.paneTree) return;
    const leaf: PaneLeaf = { type: 'leaf', id: createId(), tabId };
    layout = { ...layout, paneTree: leaf, activePaneId: leaf.id };
    notify();
  },

  /**
   * Clears the pane tree. Called when no tabs remain.
   */
  clearTree() {
    if (!layout.paneTree && !layout.activePaneId) return;
    layout = { ...layout, paneTree: null, activePaneId: null };
    notify();
  },

  /**
   * Swaps the tab shown by a specific leaf. Used when a tab becomes active
   * by conventional means (click) — the currently-active leaf retargets.
   */
  setLeafTab(paneId: string, tabId: string) {
    if (!layout.paneTree) return;
    const nextTree = transformLeaf(layout.paneTree, paneId, (leaf) => {
      if (leaf.tabId === tabId) return leaf;
      return { ...leaf, tabId };
    });
    if (!nextTree) return;
    layout = { ...layout, paneTree: nextTree };
    notify();
  },

  /**
   * Splits a leaf into two, placing `newTabId` in the new leaf on the given side.
   * Enforces a hard cap of 3 total leaves.
   */
  splitLeaf(paneId: string, newTabId: string, direction: 'left' | 'right' | 'up' | 'down'): boolean {
    if (!layout.paneTree) return false;
    if (countLeaves(layout.paneTree) >= MAX_LEAVES) return false;
    const existing = findLeaf(layout.paneTree, paneId);
    if (!existing) return false;

    const nextTree = transformLeaf(layout.paneTree, paneId, (leaf) =>
      splitAtLeaf(leaf, newTabId, direction),
    );
    if (!nextTree) return false;

    // Activate the newly-added leaf (it's sibling of the original in the split)
    const newActiveLeaf = collectLeaves(nextTree).find((l) => l.tabId === newTabId && l.id !== existing.id);
    layout = {
      ...layout,
      paneTree: nextTree,
      activePaneId: newActiveLeaf?.id ?? layout.activePaneId,
    };
    notify();
    return true;
  },

  /**
   * Splits the root at the given workspace edge — used when a tab is dragged
   * onto an outer edge of the workspace. Creates a leaf for `newTabId` on
   * that side of the existing tree.
   */
  splitRoot(newTabId: string, edge: 'left' | 'right' | 'top' | 'bottom'): boolean {
    if (!layout.paneTree) {
      this.ensureRoot(newTabId);
      return true;
    }
    if (countLeaves(layout.paneTree) >= MAX_LEAVES) return false;

    const newLeaf: PaneLeaf = { type: 'leaf', id: createId(), tabId: newTabId };
    const orientation = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
    const children: PaneNode[] = edge === 'right' || edge === 'bottom'
      ? [layout.paneTree, newLeaf]
      : [newLeaf, layout.paneTree];

    const nextTree: PaneSplit = {
      type: 'split',
      id: createId(),
      orientation,
      sizes: [0.5, 0.5],
      children,
    };
    layout = { ...layout, paneTree: nextTree, activePaneId: newLeaf.id };
    notify();
    return true;
  },

  /**
   * Removes a leaf. If it was the last leaf, the tree is cleared.
   */
  closeLeaf(paneId: string) {
    if (!layout.paneTree) return;
    const nextTree = transformLeaf(layout.paneTree, paneId, () => null);
    let nextActive = layout.activePaneId;
    if (nextActive === paneId) {
      const leaves = collectLeaves(nextTree);
      nextActive = leaves[0]?.id ?? null;
    }
    layout = { ...layout, paneTree: nextTree, activePaneId: nextActive };
    notify();
  },

  /**
   * Removes every leaf whose `tabId` is in the given set. Called after a tab closes.
   */
  dropLeavesForTabs(tabIds: Set<string>) {
    if (!layout.paneTree) return;
    const walk = (node: PaneNode): PaneNode | null => {
      if (node.type === 'leaf') return tabIds.has(node.tabId) ? null : node;
      const kept: PaneNode[] = [];
      const keptSizes: number[] = [];
      node.children.forEach((child, i) => {
        const next = walk(child);
        if (next) {
          kept.push(next);
          keptSizes.push(node.sizes[i] ?? 1 / node.children.length);
        }
      });
      if (kept.length === 0) return null;
      if (kept.length === 1) return kept[0];
      const total = keptSizes.reduce((s, v) => s + v, 0) || 1;
      return { ...node, children: kept, sizes: keptSizes.map((s) => s / total) };
    };
    const nextTree = walk(layout.paneTree);
    let nextActive = layout.activePaneId;
    if (nextActive) {
      const leaves = collectLeaves(nextTree);
      if (!leaves.some((l) => l.id === nextActive)) {
        nextActive = leaves[0]?.id ?? null;
      }
    }
    layout = { ...layout, paneTree: nextTree, activePaneId: nextActive };
    notify();
  },

  /**
   * Resizes a split by updating the `sizes` array of the split that directly
   * contains the pane identified by `splitId`.
   */
  resizeSplit(splitId: string, sizes: number[]) {
    if (!layout.paneTree) return;
    const walk = (node: PaneNode): PaneNode => {
      if (node.type === 'leaf') return node;
      if (node.id === splitId && sizes.length === node.children.length) {
        const total = sizes.reduce((s, v) => s + v, 0) || 1;
        return { ...node, sizes: sizes.map((s) => s / total), children: node.children.map(walk) };
      }
      return { ...node, children: node.children.map(walk) };
    };
    layout = { ...layout, paneTree: walk(layout.paneTree) };
    notify();
  },

  /**
   * Finds the leaf that owns the tab `tabId`, if any.
   */
  findLeafByTab(tabId: string): PaneLeaf | null {
    const leaves = collectLeaves(layout.paneTree);
    return leaves.find((l) => l.tabId === tabId) ?? null;
  },

  findLeaf(paneId: string): PaneLeaf | null {
    return findLeaf(layout.paneTree, paneId);
  },

  findParentOfLeaf(paneId: string): { parent: PaneSplit; index: number } | null {
    return findParentOfLeaf(layout.paneTree, paneId);
  },

  /**
   * Returns the workspace layout snapshot for persistence.
   */
  serialize(): WorkspaceLayout {
    return JSON.parse(JSON.stringify(layout));
  },

  /**
   * Restores workspace layout from a persisted snapshot. Does not notify.
   *
   * Active-pane fallback: if the persisted `activePaneId` doesn't match any
   * leaf in `paneTree` (or is null/missing), default to the first leaf.
   * Without this, `PaneView` short-circuits its `BoardRouter` mount because
   * no pane is "active" — leaving the user staring at an empty workspace
   * on launch even though tabs and layout restored correctly.
   */
  hydrate(persisted: Partial<WorkspaceLayout> | undefined | null) {
    if (!persisted) {
      layout = { ...DEFAULT_LAYOUT };
      return;
    }
    const paneTree = persisted.paneTree ?? null;
    const leaves = collectLeaves(paneTree);
    const persistedActive = persisted.activePaneId ?? null;
    const activePaneId =
      persistedActive && leaves.some((l) => l.id === persistedActive)
        ? persistedActive
        : leaves[0]?.id ?? null;
    layout = {
      paneTree,
      activePaneId,
      sidebarWidth: persisted.sidebarWidth ?? DEFAULT_LAYOUT.sidebarWidth,
    };
  },

  reset() {
    layout = { ...DEFAULT_LAYOUT };
  },
};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the pane tree + active pane id so the new vault's hydrate call
// rebuilds against a clean DEFAULT_LAYOUT rather than merging the prior
// vault's pane geometry into the new vault's workspace.json on save.
onVaultSwap('pre-swap', 'workspace', () => {
  workspaceStore.reset();
});
