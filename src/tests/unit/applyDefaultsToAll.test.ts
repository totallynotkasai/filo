/**
 * "Use Default Font Sizes for all Existing Items"
 * (`lib/styles/applyDefaultsToAll.ts`): every element's own font size is
 * cleared, on every board type, so it follows the style cascade again; touched
 * boards are marked dirty and untouched ones are left alone.
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

import { clearFontSizesOnAllExisting } from '@renderer/lib/styles/applyDefaultsToAll';

type Obj = Record<string, unknown>;

beforeEach(() => {
  h.markDirty.mockReset();
  h.cache = {};
  h.project = { boards: [], settings: {} };
});

describe('clearFontSizesOnAllExisting', () => {
  it('does nothing without a project', () => {
    h.project = undefined;
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
  });

  it('skips ids with neither a cached nor a project board, and tolerates a missing boards list', () => {
    h.project = { settings: {} };
    h.cache = { ghost: {} };
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
    expect(h.markDirty).not.toHaveBeenCalled();
  });

  it('mind map: clears tile defs, frames and connection labels, and keeps every other style field', () => {
    const tile = { style: { headerColor: 'red', fontSizeTitle: 20, fontSizeBody: 15 } };
    const bodyOnly = { style: { fontSizeBody: 9 } };
    const frame = { style: { borderWidth: 2, fontSizeTitle: 18 } };
    const labelled = { label: { text: 'x', fontSize: 13 } };
    h.cache = {
      mm: {
        board: { id: 'mm', type: 'mindmap' },
        tileDefs: { a: tile, b: bodyOnly, c: {} },
        frames: [frame, {}],
        connections: { c1: labelled, c2: {} },
      },
    };
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 4 });
    expect(tile.style).toEqual({ headerColor: 'red' });
    expect(bodyOnly.style).toEqual({});
    expect(frame.style).toEqual({ borderWidth: 2 });
    expect(labelled.label).toEqual({ text: 'x' });
    expect(h.markDirty).toHaveBeenCalledWith('mm');
  });

  it('kanban: clears columns, card placements and the sizes an older card def was given', () => {
    const placement = { tileId: 'c', style: { fontSizeTitle: 22, backgroundColor: '#fff' } };
    const col = { style: { fontSizeTitle: 15 }, tilePlacements: [placement] };
    const card = { style: { fontSizeTitle: 16, fontSizeBody: 17 } };
    h.cache = { kb: { board: { id: 'kb', type: 'kanban', columns: [col] }, tileDefs: { c: card } } };
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 3 });
    expect(col.style).toEqual({});
    expect(placement.style).toEqual({ backgroundColor: '#fff' });
    expect(card.style).toEqual({});
  });

  it('task list: clears the board title size, task placements, task defs and sections', () => {
    const settings: Obj = { titleFontSize: 18, accentColor: '' };
    const task = { tileId: 't', style: { fontSizeTitle: 19 } };
    const def = { style: { fontSizeBody: 20 } };
    const sec = { style: { fontSizeTitle: 21 } };
    h.cache = {
      tl: { board: { id: 'tl', type: 'tasklist', settings, tasks: [task], sections: [sec] }, tileDefs: { t: def } },
    };
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 4 });
    expect(settings).toEqual({ accentColor: '' });
    expect(task.style).toEqual({});
    expect(def.style).toEqual({});
    expect(sec.style).toEqual({});
  });

  it('project-only boards (no cache entry) are walked but have no frames/connections', () => {
    const col = { style: { fontSizeTitle: 15 } };
    h.project = {
      boards: [
        { id: 'kb', type: 'kanban', columns: [col] },
        { id: 'tl', type: 'tasklist' },
        { id: 'doc', type: 'document' },
      ],
      settings: {},
    };
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 1, elementsTouched: 1 });
    expect(h.markDirty).toHaveBeenCalledTimes(1);
    expect(h.markDirty).toHaveBeenCalledWith('kb');
  });

  it('leaves boards with no sizes of their own untouched (not dirty)', () => {
    h.cache = {
      kb: { board: { id: 'kb', type: 'kanban', columns: [{ tilePlacements: [{}] }] }, tileDefs: { c: {} } },
      tl: { board: { id: 'tl', type: 'tasklist', settings: {}, sections: [{}] }, tileDefs: { t: {} } },
      mm: { board: { id: 'mm', type: 'mindmap' }, frames: [{}], connections: { c: { label: {} } } },
    };
    expect(clearFontSizesOnAllExisting()).toEqual({ boardsTouched: 0, elementsTouched: 0 });
    expect(h.markDirty).not.toHaveBeenCalled();
  });
});
