/**
 * A thousand rapid edits to one note: the writer coalesces them into one
 * write per debounce window, and the bytes on disk end up exactly what the
 * last edit says, with every other key and the body untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '../../renderer/stores/notes.svelte';
import { vaultStore } from '../../renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { NOTE_WRITE_DEBOUNCE_MS } from '../../renderer/lib/notes/noteWriter';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const NOTE = '---\ntitle: Chore\ncompleted: false\nkeep: me # comment\n---\nBody stays\n';
let vault: MemoryVault;

const noteWrites = (): number => vault.writes.filter(([, rel]) => rel === 'Chore.md').length;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  vaultStore.setPath('/vault');
  noteStore.__resetForTests();
  vault = installMemoryVault({ 'Chore.md': NOTE });
});

afterEach(() => {
  vi.useRealTimers();
  noteStore.__resetForTests();
  restoreFiloDefault();
});

describe('1,000 rapid toggles on one note', () => {
  it('inside one debounce window: one write, and the last value wins', async () => {
    for (let i = 0; i < 1000; i++) {
      noteStore.patchFrontmatter('Chore.md', { set: { completed: i % 2 === 1 }, unset: [] });
    }
    await noteStore.flushAll();
    expect(noteWrites()).toBe(1);
    // i = 999 is odd: completed ends true.
    expect(vault.read('Chore.md')).toBe('---\ntitle: Chore\ncompleted: true\nkeep: me # comment\n---\nBody stays\n');
  });

  it('toggled back to the value on disk: nothing is written at all', async () => {
    for (let i = 0; i < 1000; i++) {
      noteStore.patchFrontmatter('Chore.md', { set: { completed: i % 2 === 0 }, unset: [] });
    }
    await noteStore.flushAll();
    // The last edit (i = 999) sets completed back to false, as on disk.
    expect(noteWrites()).toBe(0);
    expect(vault.read('Chore.md')).toBe(NOTE);
  });

  it('spread over several windows: at most one write per window, final bytes exact', async () => {
    vi.useFakeTimers();
    const windows = 5;
    for (let w = 0; w < windows; w++) {
      for (let i = 0; i < 200; i++) {
        noteStore.patchFrontmatter('Chore.md', { set: { completed: (w * 200 + i) % 2 === 1 }, unset: [] });
      }
      await vi.advanceTimersByTimeAsync(NOTE_WRITE_DEBOUNCE_MS + 50);
    }
    vi.useRealTimers();
    await noteStore.flushAll();
    expect(noteWrites()).toBeLessThanOrEqual(windows);
    // The last edit (index 999) sets completed: true.
    expect(vault.read('Chore.md')).toBe('---\ntitle: Chore\ncompleted: true\nkeep: me # comment\n---\nBody stays\n');
  });
});
