/**
 * Unit coverage for "Apply to all Existing Items"
 * (`lib/styles/applyDefaultsToAll.ts`): every board type's elements get the
 * current Default Board Font Size values baked in as per-element overrides,
 * touched boards are marked dirty, and untouched ones are left alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  markDirty: vi.fn(),
  cache: {} as Record<string, unknown>,
  project: undefined as unknown,
}));

vi.mock('@renderer/stores/boardCache.svelte', () => ({
  boardCacheStore: {
    markDirty: h.markDirty,
    get cache() {
      return h.cache;
    },
  },
}));
vi.mock('@renderer/stores/vault.svelte', () => ({
  vaultStore: {
    get project() {
      return h.project;
    },
  },
}));

import { applyFontDefaultsToAllExisting } from '@renderer/lib/styles/applyDefaultsToAll';

type Obj = Record<string, unknown>;

function withDefaults(defaults: Obj | undefined, boards: Obj[] = []): void {
  h.project = { boards, settings: { general: { defaultBoardFontSize: defaults } } };
}

const ALL = {
  tileTitle: 11,
  tileBody: 12,
  connectionLabel: 13,
  frameTitle: 14,
  kanbanColumnTitle: 15,
  kanbanCardTitle: 16,
  kanbanCardBody: 17,
  taskListTitle: 18,
  taskItem: 19,
  taskItemBody: 20,
  taskSectionTitle: 21,
};

beforeEach(() => {
  h.markDirty.mockReset();
  h.cache = {};
  h.project = undefined;
});

describe('applyFontDefaultsToAllExisting', () => {
  it('does nothing without a project', () => {
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
  });

  it('does nothing when no font defaults are set', () => {
    h.project = { boards: [], settings: {} };
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
  });

  it('skips ids with neither a cached nor a project board, and tolerates a missing boards list', () => {
    h.project = { settings: { general: { defaultBoardFontSize: ALL } } };
    h.cache = { ghost: {} };
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
    expect(h.markDirty).not.toHaveBeenCalled();
  });

  it('mind map: stamps tile defs (creating style), frames and connection labels', () => {
    const styled = { style: { color: 'red' } };
    const bare: Obj = {};
    const frame: Obj = {};
    const labelled = { label: { text: 'x' } };
    const unlabelled: Obj = {};
    h.cache = {
      mm: {
        board: { id: 'mm', type: 'mindmap' },
        tileDefs: { a: styled, b: bare },
        frames: [frame],
        connections: { c1: labelled, c2: unlabelled },
      },
    };
    withDefaults(ALL);
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 4 });
    expect(styled.style).toEqual({ color: 'red', fontSizeTitle: 11, fontSizeBody: 12 });
    expect(bare).toEqual({ style: { fontSizeTitle: 11, fontSizeBody: 12 } });
    expect(frame).toEqual({ style: { fontSizeTitle: 14 } });
    expect(labelled.label).toEqual({ text: 'x', fontSize: 13 });
    expect(unlabelled).toEqual({});
    expect(h.markDirty).toHaveBeenCalledWith('mm');
  });

  it('mind map: a partial default (body only) still counts the tile', () => {
    const def: Obj = {};
    h.cache = { mm: { board: { id: 'mm', type: 'mindmap' }, tileDefs: { a: def } } };
    withDefaults({ tileBody: 9 });
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 1 });
    expect(def).toEqual({ style: { fontSizeBody: 9 } });
  });

  it('kanban: stamps columns and card tile defs', () => {
    const col: Obj = {};
    const card: Obj = {};
    h.cache = {
      kb: { board: { id: 'kb', type: 'kanban', columns: [col] }, tileDefs: { c: card } },
    };
    withDefaults(ALL);
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 2 });
    expect(col).toEqual({ style: { fontSizeTitle: 15 } });
    expect(card).toEqual({ style: { fontSizeTitle: 16, fontSizeBody: 17 } });
  });

  it('task list: stamps board title setting, task defs and sections', () => {
    const settings: Obj = {};
    const t: Obj = {};
    const sec: Obj = {};
    h.cache = {
      tl: { board: { id: 'tl', type: 'tasklist', settings, sections: [sec] }, tileDefs: { t } },
    };
    withDefaults(ALL);
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 3 });
    expect(settings).toEqual({ titleFontSize: 18 });
    expect(t).toEqual({ style: { fontSizeTitle: 19, fontSizeBody: 20 } });
    expect(sec).toEqual({ style: { fontSizeTitle: 21 } });
  });

  it('project-only boards (no cache entry) are walked but have no frames/connections', () => {
    const col: Obj = {};
    withDefaults(ALL, [
      { id: 'kb', type: 'kanban', columns: [col] },
      { id: 'tl', type: 'tasklist' },
      { id: 'doc', type: 'document' },
    ]);
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 1 });
    expect(h.markDirty).toHaveBeenCalledTimes(1);
    expect(h.markDirty).toHaveBeenCalledWith('kb');
  });

  it('leaves boards untouched (not dirty) when the relevant defaults are unset', () => {
    const col: Obj = {};
    const settings: Obj = {};
    h.cache = {
      kb: { board: { id: 'kb', type: 'kanban', columns: [col] }, tileDefs: { c: {} } },
      tl: { board: { id: 'tl', type: 'tasklist', settings, sections: [{}] }, tileDefs: { t: {} } },
      mm: { board: { id: 'mm', type: 'mindmap' }, frames: [{}], connections: { c: { label: {} } } },
    };
    withDefaults({});
    expect(applyFontDefaultsToAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
    expect(settings).toEqual({});
    expect(h.markDirty).not.toHaveBeenCalled();
  });
});
