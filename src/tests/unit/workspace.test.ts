import { describe, it, expect, beforeEach } from 'vitest';
import { workspaceStore } from '@renderer/stores/workspace.svelte';
import type { WorkspaceLayout, PaneSplit } from '@renderer/stores/workspace.svelte';

describe('workspaceStore', () => {
  beforeEach(() => {
    workspaceStore.reset();
    workspaceStore.setChangeListener(null);
  });

  it('starts with sensible defaults', () => {
    expect(workspaceStore.activePaneId).toBeNull();
    expect(workspaceStore.paneTree).toBeNull();
    expect(workspaceStore.leafCount).toBe(0);
  });

  it('notifies change listener on every mutation', () => {
    let count = 0;
    workspaceStore.setChangeListener(() => count++);

    workspaceStore.setBoardToolbarPinned('board_1', true);
    workspaceStore.ensureRoot('tab_a');
    workspaceStore.setActivePane('some_pane');

    expect(count).toBe(3);
  });

  it('skips notification when active pane is set to the same id', () => {
    let count = 0;
    workspaceStore.setChangeListener(() => count++);
    workspaceStore.setActivePane('pane_x');
    workspaceStore.setActivePane('pane_x');
    expect(count).toBe(1);
  });

  describe('pane tree operations', () => {
    it('ensureRoot creates a single leaf and sets it active', () => {
      workspaceStore.ensureRoot('tab_1');
      expect(workspaceStore.leafCount).toBe(1);
      expect(workspaceStore.paneTree?.type).toBe('leaf');
      expect(workspaceStore.activeLeaf?.tabId).toBe('tab_1');
      expect(workspaceStore.activePaneId).toBe(workspaceStore.activeLeaf?.id);
    });

    it('ensureRoot is idempotent', () => {
      workspaceStore.ensureRoot('tab_1');
      const firstId = workspaceStore.activePaneId;
      workspaceStore.ensureRoot('tab_2');
      expect(workspaceStore.activePaneId).toBe(firstId);
      expect(workspaceStore.leafCount).toBe(1);
    });

    it('splitRoot left/right builds a horizontal split', () => {
      workspaceStore.ensureRoot('tab_1');
      const ok = workspaceStore.splitRoot('tab_2', 'right');
      expect(ok).toBe(true);
      expect(workspaceStore.leafCount).toBe(2);
      expect(workspaceStore.paneTree?.type).toBe('split');
      expect((workspaceStore.paneTree as PaneSplit).orientation).toBe('horizontal');
    });

    it('splitRoot top/bottom builds a vertical split', () => {
      workspaceStore.ensureRoot('tab_1');
      workspaceStore.splitRoot('tab_2', 'bottom');
      expect((workspaceStore.paneTree as PaneSplit).orientation).toBe('vertical');
    });

    it('enforces MAX_LEAVES = 3', () => {
      workspaceStore.ensureRoot('tab_1');
      expect(workspaceStore.splitRoot('tab_2', 'right')).toBe(true);
      expect(workspaceStore.splitRoot('tab_3', 'bottom')).toBe(true);
      expect(workspaceStore.splitRoot('tab_4', 'left')).toBe(false);
      expect(workspaceStore.leafCount).toBe(3);
    });

    it('closeLeaf collapses single-child splits back into a leaf', () => {
      workspaceStore.ensureRoot('tab_1');
      workspaceStore.splitRoot('tab_2', 'right');
      expect(workspaceStore.leafCount).toBe(2);

      const rootSplit = workspaceStore.paneTree as PaneSplit;
      const firstLeafId = (rootSplit.children[0] as { id: string }).id;

      workspaceStore.closeLeaf(firstLeafId);
      expect(workspaceStore.leafCount).toBe(1);
      expect(workspaceStore.paneTree?.type).toBe('leaf');
    });

    it('closeLeaf clears the tree when the last leaf is removed', () => {
      workspaceStore.ensureRoot('tab_1');
      const leafId = workspaceStore.activePaneId!;
      workspaceStore.closeLeaf(leafId);
      expect(workspaceStore.paneTree).toBeNull();
      expect(workspaceStore.activePaneId).toBeNull();
    });

    it('dropLeavesForTabs removes leaves referencing given tab ids', () => {
      workspaceStore.ensureRoot('tab_1');
      workspaceStore.splitRoot('tab_2', 'right');
      workspaceStore.splitRoot('tab_3', 'bottom');
      expect(workspaceStore.leafCount).toBe(3);

      workspaceStore.dropLeavesForTabs(new Set(['tab_2']));
      expect(workspaceStore.leafCount).toBe(2);
      expect(workspaceStore.leaves.map((l) => l.tabId).sort()).toEqual(['tab_1', 'tab_3']);
    });

    it('resizeSplit updates sizes normalized to sum to 1', () => {
      workspaceStore.ensureRoot('tab_1');
      workspaceStore.splitRoot('tab_2', 'right');
      const splitId = (workspaceStore.paneTree as PaneSplit).id;

      workspaceStore.resizeSplit(splitId, [2, 3]);
      const sizes = (workspaceStore.paneTree as PaneSplit).sizes;
      expect(sizes[0]).toBeCloseTo(0.4);
      expect(sizes[1]).toBeCloseTo(0.6);
    });

    it('findLeafByTab locates a leaf by its tab id', () => {
      workspaceStore.ensureRoot('tab_1');
      workspaceStore.splitRoot('tab_2', 'right');
      const leaf = workspaceStore.findLeafByTab('tab_2');
      expect(leaf?.tabId).toBe('tab_2');
    });
  });

  it('round-trips the full layout through serialize + hydrate', () => {
    const split: PaneSplit = {
      type: 'split',
      id: 'split_1',
      orientation: 'horizontal',
      sizes: [0.6, 0.4],
      children: [
        { type: 'leaf', id: 'leaf_1', tabId: 'tab_a' },
        { type: 'leaf', id: 'leaf_2', tabId: 'tab_b' },
      ],
    };

    const before: WorkspaceLayout = {
      paneTree: split,
      activePaneId: 'leaf_1',
      boardToolbars: { board_1: { position: { x: 40, y: 80 }, pinned: true } },
      spellcheck: false,
    };

    workspaceStore.hydrate(before);
    const snapshot = workspaceStore.serialize();

    workspaceStore.reset();
    workspaceStore.hydrate(snapshot);

    expect(workspaceStore.layout).toEqual(before);
  });

  it('hydrate(null) resets to defaults', () => {
    workspaceStore.ensureRoot('tab_a');
    workspaceStore.hydrate(null);
    expect(workspaceStore.paneTree).toBeNull();
  });

  it('hydrate fills missing fields with defaults', () => {
    workspaceStore.hydrate({ boardToolbars: { b: { position: null, pinned: true } } });
    expect(workspaceStore.boardToolbar('b').pinned).toBe(true);
    expect(workspaceStore.activePaneId).toBeNull();
    expect(workspaceStore.spellcheck).toBe(true);
  });
});

describe('workspaceStore spell check', () => {
  beforeEach(() => {
    workspaceStore.reset();
    workspaceStore.setChangeListener(null);
  });

  it('is on until turned off, and a change is saved once', () => {
    expect(workspaceStore.spellcheck).toBe(true);
    let notified = 0;
    workspaceStore.setChangeListener(() => notified++);
    workspaceStore.setSpellcheck(false);
    workspaceStore.setSpellcheck(false);
    expect(workspaceStore.spellcheck).toBe(false);
    expect(notified).toBe(1);
  });

  it('reads only an explicit false as off: anything else in the file is on', () => {
    workspaceStore.hydrate({ spellcheck: false });
    expect(workspaceStore.spellcheck).toBe(false);
    workspaceStore.hydrate({ spellcheck: 'no' as unknown as boolean });
    expect(workspaceStore.spellcheck).toBe(true);
    workspaceStore.hydrate({});
    expect(workspaceStore.spellcheck).toBe(true);
  });

  it('goes back on when the vault is let go', () => {
    workspaceStore.setSpellcheck(false);
    workspaceStore.reset();
    expect(workspaceStore.spellcheck).toBe(true);
  });
});

describe('workspaceStore board toolbars', () => {
  beforeEach(() => {
    workspaceStore.reset();
    workspaceStore.setChangeListener(null);
  });

  it('keeps a position and pin per board', () => {
    workspaceStore.setBoardToolbarPosition('a', { x: 10.4, y: 20.6 });
    workspaceStore.setBoardToolbarPinned('b', true);
    expect(workspaceStore.boardToolbar('a')).toEqual({ position: { x: 10, y: 21 }, pinned: false });
    expect(workspaceStore.boardToolbar('b')).toEqual({ position: null, pinned: true });
    expect(workspaceStore.boardToolbar('c')).toEqual({ position: null, pinned: false });
  });

  it('a pinned toolbar is neither moved nor docked', () => {
    workspaceStore.setBoardToolbarPosition('a', { x: 10, y: 20 });
    workspaceStore.setBoardToolbarPinned('a', true);
    workspaceStore.setBoardToolbarPosition('a', { x: 99, y: 99 });
    workspaceStore.setBoardToolbarPosition('a', null);
    expect(workspaceStore.boardToolbar('a').position).toEqual({ x: 10, y: 20 });
  });

  it('a docked, unpinned toolbar has no entry, and a deleted board loses its entry', () => {
    workspaceStore.setBoardToolbarPosition('a', { x: 10, y: 20 });
    workspaceStore.setBoardToolbarPosition('a', null);
    expect(workspaceStore.boardToolbars).toEqual({});

    workspaceStore.setBoardToolbarPinned('b', true);
    let notified = 0;
    workspaceStore.setChangeListener(() => notified++);
    workspaceStore.removeBoardToolbar('b');
    workspaceStore.removeBoardToolbar('b');
    expect(workspaceStore.boardToolbars).toEqual({});
    expect(notified).toBe(1);
  });

  it('round-trips through serialize and hydrate', () => {
    workspaceStore.setBoardToolbarPosition('a', { x: 140, y: 90 });
    workspaceStore.setBoardToolbarPinned('a', true);
    workspaceStore.setBoardToolbarPinned('b', true);
    const snapshot = JSON.parse(JSON.stringify(workspaceStore.serialize())) as WorkspaceLayout;
    workspaceStore.reset();
    workspaceStore.hydrate(snapshot);
    expect(workspaceStore.boardToolbars).toEqual({
      a: { position: { x: 140, y: 90 }, pinned: true },
      b: { position: null, pinned: true },
    });
  });

  it('hydrate drops bad entries and keeps the good ones', () => {
    workspaceStore.hydrate({
      boardToolbars: {
        good: { position: { x: 1, y: 2 }, pinned: false },
        badPos: { position: { x: 'no', y: 2 }, pinned: true },
        docked: { position: null, pinned: false },
        junk: 'nope',
        nan: { position: { x: Number.NaN, y: 2 } },
      } as unknown as WorkspaceLayout['boardToolbars'],
    });
    expect(workspaceStore.boardToolbars).toEqual({
      good: { position: { x: 1, y: 2 }, pinned: false },
      badPos: { position: null, pinned: true },
    });
  });

  it('hydrate ignores a toolbar map that is not an object', () => {
    workspaceStore.hydrate({ boardToolbars: [1, 2] as unknown as WorkspaceLayout['boardToolbars'] });
    expect(workspaceStore.boardToolbars).toEqual({});
  });
});
