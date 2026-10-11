import { describe, it, expect } from 'vitest';
import {
  KanbanDefaultsSchema,
  TaskListDefaultsSchema,
  DocumentDefaultsSchema,
  MindMapDefaultsSchema,
} from '@renderer/schema/settings';

/**
 * Back-fill of `backgroundPattern` for stale `.filo/settings.json`.
 *
 * A vault saved before Filo introduced `kanban.backgroundPattern` may have a
 * `defaults.kanban` object that lacks the field entirely. The loader calls
 * `KanbanDefaultsSchema.safeParse(defaultsConfig.kanban ?? {})` — the parse
 * MUST emit `backgroundPattern: 'none'` for non-canvas boards so the
 * cascade in KanbanBoard/TaskListBoard/DocumentEditor doesn't fall through
 * to the BoardBackground component default. Mind Map stays 'grid'.
 *
 * Pinning the contract here so a future schema-default flip can't silently
 * leak grid back onto non-canvas boards.
 */

describe('Per-board-type default schemas back-fill backgroundPattern', () => {
  it('Kanban defaults to none', () => {
    const r = KanbanDefaultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.backgroundPattern).toBe('none');
  });

  it('TaskList defaults to none', () => {
    const r = TaskListDefaultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.backgroundPattern).toBe('none');
  });

  it('Document defaults to none', () => {
    const r = DocumentDefaultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.backgroundPattern).toBe('none');
  });

  it('Mind Map defaults to grid', () => {
    const r = MindMapDefaultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.backgroundPattern).toBe('grid');
  });

  it('Kanban back-fills backgroundPattern when only accentColor is provided (stale legacy shape)', () => {
    const r = KanbanDefaultsSchema.safeParse({ accentColor: '#abc' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.backgroundPattern).toBe('none');
      expect(r.data.accentColor).toBe('#abc');
    }
  });
});
