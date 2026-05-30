import { describe, it, expect } from 'vitest';
import { planTextTileDrop } from '@renderer/lib/canvas/textTileDropPlan';

type ExistingTile = {
  type: string;
  title?: string;
  contentId?: string;
  filePath?: string;
};

const baseInput = {
  droppedRelPath: 'Notes/Foo.md',
  title: 'Foo',
  contentId: 'doc_new',
  boardType: 'mindmap',
  boardName: undefined,
  existingTiles: [] as ExistingTile[],
};

describe('planTextTileDrop — duplicate detection', () => {
  it('returns duplicate=false when no text tiles exist', () => {
    const r = planTextTileDrop({ ...baseInput });
    expect(r.duplicate).toBe(false);
  });

  it('detects duplicate via filePath match', () => {
    const r = planTextTileDrop({
      ...baseInput,
      existingTiles: [
        { type: 'text', title: 'Foo', filePath: 'Notes/Foo.md', contentId: 'doc_orig' },
      ],
    });
    expect(r.duplicate).toBe(true);
  });

  it('detects duplicate via contentId match (path differs)', () => {
    const r = planTextTileDrop({
      ...baseInput,
      contentId: 'doc_shared',
      existingTiles: [
        { type: 'text', title: 'Foo', filePath: 'Other/Different.md', contentId: 'doc_shared' },
      ],
    });
    expect(r.duplicate).toBe(true);
  });

  it('detects duplicate via convention path match (mindmap = root)', () => {
    // Existing tile has no filePath, title="Foo" → convention path = "Foo.md".
    // Dropped path is "Foo.md" → duplicate.
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Foo.md',
      title: 'Foo',
      contentId: 'doc_new',
      existingTiles: [{ type: 'text', title: 'Foo', contentId: 'doc_orig' }],
    });
    expect(r.duplicate).toBe(true);
  });

  it('ignores non-text tiles', () => {
    const r = planTextTileDrop({
      ...baseInput,
      existingTiles: [
        { type: 'image', filePath: 'Notes/Foo.md' },
        { type: 'file', filePath: 'Notes/Foo.md' },
      ],
    });
    expect(r.duplicate).toBe(false);
  });

  it('is case-insensitive on path comparison', () => {
    const r = planTextTileDrop({
      ...baseInput,
      existingTiles: [{ type: 'text', title: 'Foo', filePath: 'notes/foo.md' }],
    });
    expect(r.duplicate).toBe(true);
  });
});

describe('planTextTileDrop — filePath stamping', () => {
  it('stamps explicit filePath when drop is outside convention folder (mindmap)', () => {
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Notes/Foo.md',
      title: 'Foo',
      boardType: 'mindmap',
    });
    expect(r.filePath).toBe('Notes/Foo.md');
  });

  it('does NOT stamp filePath when drop sits at the convention path (mindmap root)', () => {
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Foo.md',
      title: 'Foo',
      boardType: 'mindmap',
    });
    expect(r.filePath).toBeNull();
  });

  it('does NOT stamp filePath when drop sits at the cascade folder (tasklist with per-board pin to Tasks/)', () => {
    // After dropping the hardcoded TaskList convention, callers pass the
    // cascade-resolved folder via conventionFolderOverride. With a per-board
    // pin to Tasks/, the override resolves to Tasks/ and a drop at
    // Tasks/Buy milk.md matches the convention → no stamp needed.
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Tasks/Buy milk.md',
      title: 'Buy milk',
      boardType: 'tasklist',
      conventionFolderOverride: 'Tasks',
    });
    expect(r.filePath).toBeNull();
  });

  it('stamps filePath when drop is in a different folder than the cascade (tasklist no pin)', () => {
    // Without an override, the cascade folder is '' (vault root). A drop at
    // Tasks/Bar.md is outside the convention root, so the planner stamps an
    // explicit filePath to keep the file at its dropped location.
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Tasks/Bar.md',
      title: 'Bar',
      boardType: 'tasklist',
    });
    expect(r.filePath).toBe('Tasks/Bar.md');
  });

  it('does NOT stamp filePath for an unpinned tasklist when drop is at vault root', () => {
    // The new default for an unpinned tasklist is vault root. A vault-root
    // drop matches the convention → no stamp.
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Buy milk.md',
      title: 'Buy milk',
      boardType: 'tasklist',
    });
    expect(r.filePath).toBeNull();
  });

  it('stamps filePath for kanban with sanitized board name', () => {
    // Convention for kanban "My Board" is "Kanban/My Board/". Drop is
    // at root → outside convention → filePath stamped.
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'Foo.md',
      title: 'Foo',
      boardType: 'kanban',
      boardName: 'My Board',
    });
    expect(r.filePath).toBe('Foo.md');
  });

  it('always stamps filePath when board type has no convention', () => {
    const r = planTextTileDrop({
      ...baseInput,
      droppedRelPath: 'anywhere/Foo.md',
      boardType: 'document',
    });
    expect(r.filePath).toBe('anywhere/Foo.md');
  });
});

describe('planTextTileDrop — combined scenarios (reported bug)', () => {
  it('reproduces the reported bug: move root Foo.md → Notes/Foo.md, re-drop → duplicate=true AND filePath stamped', () => {
    // Original tile was created at vault root with no filePath (convention),
    // then sidebar move stamped filePath="Notes/Foo.md" onto the existing tile.
    // Re-dropping Notes/Foo.md must (a) report duplicate, (b) stamp filePath
    // on the new tile so its first save does NOT recreate Foo.md at root.
    const r = planTextTileDrop({
      droppedRelPath: 'Notes/Foo.md',
      title: 'Foo',
      contentId: 'doc_xyz',
      boardType: 'mindmap',
      boardName: undefined,
      existingTiles: [
        { type: 'text', title: 'Foo', filePath: 'Notes/Foo.md', contentId: 'doc_xyz' },
      ],
    });
    expect(r.duplicate).toBe(true);
    expect(r.filePath).toBe('Notes/Foo.md');
  });
});
