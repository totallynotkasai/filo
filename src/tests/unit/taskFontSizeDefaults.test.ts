/**
 * The Task List font-size defaults in Settings → General ("Task Item", "Task
 * Body", "Task Section Title") are what a new task and a new section get.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  cache: {} as Record<string, unknown>,
  project: undefined as unknown,
}));

vi.mock('@renderer/stores/boardCache.svelte', () => ({
  boardCacheStore: {
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

import {
  defaultFontSizesForBoard,
  defaultTaskFontSizes,
  defaultTaskSectionFontSizes,
} from '@renderer/lib/styles/defaultFontSizes';

describe('Task List font-size defaults', () => {
  beforeEach(() => {
    h.cache = { tl: { board: { type: 'tasklist' } } };
    h.project = {
      settings: { general: { defaultBoardFontSize: { taskItem: 15, taskItemBody: 11, taskSectionTitle: 19 } } },
    };
  });

  it('a new task gets the Task Item title and the Task Body size', () => {
    expect(defaultTaskFontSizes()).toEqual({ fontSizeTitle: 15, fontSizeBody: 11 });
    expect(defaultFontSizesForBoard('tl')).toEqual({ fontSizeTitle: 15, fontSizeBody: 11 });
  });

  it('a new section gets the Task Section Title size', () => {
    expect(defaultTaskSectionFontSizes()).toEqual({ fontSizeTitle: 19 });
  });

  it('with no defaults set, nothing is baked in', () => {
    h.project = { settings: { general: {} } };
    expect(defaultTaskFontSizes()).toEqual({ fontSizeTitle: undefined, fontSizeBody: undefined });
    expect(defaultTaskSectionFontSizes()).toEqual({ fontSizeTitle: undefined });
  });
});
