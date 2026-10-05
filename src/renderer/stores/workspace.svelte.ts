/**
 * Workspace store — persisted layout state that belongs to "the window",
 * not the project. Split-pane tree, sidebar width, active pane id, the
 * boards' side toolbars, each Mind Map's minimap and waypoints shown or
 * hidden, and whether spell check is on.
 * Persisted to `.filo/workspace.json` alongside open-tab state.
 *
 * A pane leaf references a tab id (the tab's board determines what's
 * rendered). The active pane determines which tab is the focused tab
 * globally — only the active pane hosts a live, editable board view.
 */

import { createId } from '../lib/utils/ids';
import { onVaultSwap } from '../core/vaultLifecycle';
import type { ToolbarPosition } from '../lib/canvas/floatingToolbarDrag';

export type { ToolbarPosition };

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

/**
 * One board's floating side toolbar. `position` is where the user dragged it
 * (null: docked where its stylesheet puts it). A pinned toolbar can't be
 * dragged or reset, docked or not.
 */
export interface BoardToolbarState {
  position: ToolbarPosition | null;
  pinned: boolean;
}

/** Whether a Mind Map shows its minimap and its waypoints (both, unless hidden). */
export interface MindMapPanelsState {
  minimap: boolean;
  waypoints: boolean;
}

export interface WorkspaceLayout {
  paneTree: PaneNode | null;
  activePaneId: string | null;
  /** Each board's side toolbar, by board id. A board left docked and unpinned has no entry. */
  boardToolbars: Record<string, BoardToolbarState>;
  /** Each Mind Map's minimap and waypoints, by board id. A board showing both has no entry. */
  mindMapPanels: Record<string, MindMapPanelsState>;
  /** Spell check in every text editor (the toolbar's Spelling button), on unless turned off. */
  spellcheck: boolean;
}

const DEFAULT_LAYOUT: WorkspaceLayout = {
  paneTree: null,
  activePaneId: null,
  boardToolbars: {},
  mindMapPanels: {},
  spellcheck: true,
};

const DOCKED_TOOLBAR: BoardToolbarState = { position: null, pinned: false };
const PANELS_SHOWN: MindMapPanelsState = { minimap: true, waypoints: true };

function asToolbarPosition(value: unknown): ToolbarPosition | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Validated by hand like the rest of the layout: a bad entry is dropped, never the file. */
function asBoardToolbars(value: unknown): Record<string, BoardToolbarState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, BoardToolbarState> = {};
  for (const [boardId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!boardId || !entry || typeof entry !== 'object') continue;
    const { position, pinned } = entry as { position?: unknown; pinned?: unknown };
    const state: BoardToolbarState = { position: asToolbarPosition(position), pinned: pinned === true };
    if (state.position || state.pinned) out[boardId] = state;
  }
  return out;
}

/** Validated like the toolbars: only a hidden panel is kept, a bad entry is dropped. */
function asMindMapPanels(value: unknown): Record<string, MindMapPanelsState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, MindMapPanelsState> = {};
  for (const [boardId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!boardId || !entry || typeof entry !== 'object') continue;
    const { minimap, waypoints } = entry as { minimap?: unknown; waypoints?: unknown };
    const state: MindMapPanelsState = { minimap: minimap !== false, waypoints: waypoints !== false };
    if (!state.minimap || !state.waypoints) out[boardId] = state;
  }
  return out;
}

/** The panels map with `boardId` set to `next`; a board showing both needs no entry. */
function withMindMapPanels(boardId: string, next: MindMapPanelsState): Record<string, MindMapPanelsState> {
  const { [boardId]: _old, ...rest } = layout.mindMapPanels;
  void _old;
  return next.minimap && next.waypoints ? rest : { ...rest, [boardId]: next };
}

/** The toolbar map with `boardId` set to `next`; a docked, unpinned toolbar needs no entry. */
function withBoardToolbar(boardId: string, next: BoardToolbarState): Record<string, BoardToolbarState> {
  const { [boardId]: _old, ...rest } = layout.boardToolbars;
  void _old;
  return next.position || next.pinned ? { ...rest, [boardId]: next } : rest;
}

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
  if (newChildren.length === 1) return newChildren[0] ?? null;
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
    if (child && child.type === 'leaf' && child.id === leafId) return { parent: node, index: i };
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
  get activePaneId() { return layout.activePaneId; },
  get paneTree() { return layout.paneTree; },
  get boardToolbars() { return layout.boardToolbars; },
  get mindMapPanels() { return layout.mindMapPanels; },
  get spellcheck() { return layout.spellcheck; },
  get leafCount() { return countLeaves(layout.paneTree); },
  get leaves() { return collectLeaves(layout.paneTree); },

  /** The leaf for the currently active pane (or the sole leaf if only one exists). */
  get activeLeaf(): PaneLeaf | null {
    const leaves = collectLeaves(layout.paneTree);
    if (leaves.length === 0) return null;
    if (layout.activePaneId) {
      return leaves.find((l) => l.id === layout.activePaneId) ?? leaves[0] ?? null;
    }
    return leaves[0] ?? null;
  },

  setChangeListener(fn: (() => void) | null) {
    onChangeListener = fn;
  },

  /** A board's side toolbar; docked and unpinned when it has no entry. */
  boardToolbar(boardId: string): BoardToolbarState {
    return layout.boardToolbars[boardId] ?? DOCKED_TOOLBAR;
  },

  /** Moves a board's toolbar (null docks it). A pinned toolbar stays where it is. */
  setBoardToolbarPosition(boardId: string, position: ToolbarPosition | null) {
    if (!boardId) return;
    const current = workspaceStore.boardToolbar(boardId);
    if (current.pinned) return;
    const next = asToolbarPosition(position);
    if (next?.x === current.position?.x && next?.y === current.position?.y) return;
    layout = { ...layout, boardToolbars: withBoardToolbar(boardId, { ...current, position: next }) };
    notify();
  },

  /** Turns spell check on or off in every editor, and saves the choice with the vault's layout. */
  setSpellcheck(on: boolean) {
    if (layout.spellcheck === on) return;
    layout = { ...layout, spellcheck: on };
    notify();
  },

  setBoardToolbarPinned(boardId: string, pinned: boolean) {
    if (!boardId) return;
    const current = workspaceStore.boardToolbar(boardId);
    if (current.pinned === pinned) return;
    layout = { ...layout, boardToolbars: withBoardToolbar(boardId, { ...current, pinned }) };
    notify();
  },

  /** A deleted board's toolbar entry goes with it. */
  removeBoardToolbar(boardId: string) {
    if (!(boardId in layout.boardToolbars)) return;
    layout = { ...layout, boardToolbars: withBoardToolbar(boardId, DOCKED_TOOLBAR) };
    notify();
  },

  /** A Mind Map's minimap and waypoints: shown, unless hidden on this board. */
  mindMapPanelsOf(boardId: string): MindMapPanelsState {
    return layout.mindMapPanels[boardId] ?? PANELS_SHOWN;
  },

  /** Shows or hides one of a Mind Map's panels, remembered for that board. */
  setMindMapPanel(boardId: string, panel: keyof MindMapPanelsState, shown: boolean) {
    if (!boardId) return;
    const current = workspaceStore.mindMapPanelsOf(boardId);
    if (current[panel] === shown) return;
    layout = { ...layout, mindMapPanels: withMindMapPanels(boardId, { ...current, [panel]: shown }) };
    notify();
  },

  /** A deleted board's panels entry goes with it. */
  removeMindMapPanels(boardId: string) {
    if (!(boardId in layout.mindMapPanels)) return;
    layout = { ...layout, mindMapPanels: withMindMapPanels(boardId, PANELS_SHOWN) };
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
      if (kept.length === 1) return kept[0] ?? null;
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
      boardToolbars: asBoardToolbars(persisted.boardToolbars),
      mindMapPanels: asMindMapPanels(persisted.mindMapPanels),
      spellcheck: persisted.spellcheck !== false,
    };
  },

  reset() {
    layout = { ...DEFAULT_LAYOUT };
  },
};

// Vault-swap reset: drops the pane tree + active pane id so the new vault's hydrate call
// rebuilds against a clean DEFAULT_LAYOUT rather than merging the prior
// vault's pane geometry into the new vault's workspace.json on save.
onVaultSwap('pre-swap', 'workspace', () => {
  workspaceStore.reset();
}, { runAfter: ['leftBehind'] });
