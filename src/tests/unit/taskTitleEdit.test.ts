/**
 * A Task List row's title while it is typed: Enter, click-away and a save
 * (Ctrl+S, close, quit) commit it; Escape and Cancel drop it; a rename made
 * elsewhere meanwhile wins over the draft.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TaskTitleEdit } from '@renderer/lib/tasklist/taskTitleEdit.svelte';
import { flushAllComponents, __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';

afterEach(() => {
  __resetComponentFlushesForTests();
});

function edit(title = 'Water plants'): { e: TaskTitleEdit; rename: ReturnType<typeof vi.fn>; setTitle(t: string): void } {
  let current = title;
  const rename = vi.fn((t: string) => {
    current = t;
  });
  const e = new TaskTitleEdit({ title: () => current, rename });
  return { e, rename, setTitle: (t) => { current = t; } };
}

describe('TaskTitleEdit', () => {
  it('Enter commits the trimmed draft once', () => {
    const { e, rename } = edit();
    e.start();
    e.draft = 'Water the herbs ';
    e.keydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    e.blurred();
    expect(rename).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledWith('Water the herbs');
    expect(e.editing).toBe(false);
  });

  it('a save commits a title still being typed', async () => {
    const { e, rename } = edit();
    const off = e.track();
    e.start();
    e.draft = 'Water the herbs';
    await flushAllComponents();
    expect(rename).toHaveBeenCalledWith('Water the herbs');
    expect(e.editing).toBe(false);
    off();
  });

  it('a save with no title being typed renames nothing', async () => {
    const { rename, e } = edit();
    const off = e.track();
    await flushAllComponents();
    expect(rename).not.toHaveBeenCalled();
    off();
  });

  it('Escape drops the draft, and the blur that follows commits nothing', async () => {
    const { e, rename } = edit();
    e.start();
    e.draft = 'Something else';
    e.keydown(new KeyboardEvent('keydown', { key: 'Escape' }));
    e.blurred();
    await Promise.resolve();
    expect(rename).not.toHaveBeenCalled();
    expect(e.draft).toBe('Water plants');
  });

  it('a rename made elsewhere while typing wins over the draft', () => {
    const { e, rename, setTitle } = edit();
    e.start();
    e.draft = 'My draft';
    setTitle('Renamed elsewhere');
    e.commit();
    expect(rename).not.toHaveBeenCalled();
  });

  it('an emptied title renames nothing', () => {
    const { e, rename } = edit();
    e.start();
    e.draft = '   ';
    e.commit();
    expect(rename).not.toHaveBeenCalled();
  });
});
