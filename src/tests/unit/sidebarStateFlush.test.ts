import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Phase 4 / 4.4 — `flushSidebarStateNow()` must drain any in-debounce
 * `scheduleSave` timer AND any in-flight `writeSidebarState` promise
 * before resolving. Without this, `before-quit` could exit between the
 * user's sidebar resize (300 ms debounce) and the actual disk write,
 * silently dropping the new geometry.
 */

// Mock Electron's `app` so `loadSidebarState` / `statePath()` can resolve a
// userData path without spinning up a real Electron process.
let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir;
      return tmpdir();
    },
  },
}));

const { updateSidebarState, flushSidebarStateNow, loadSidebarState } = await import(
  '../../main/services/sidebarState'
);

describe('flushSidebarStateNow — drains timer + in-flight write (Phase 4 / 4.4)', () => {
  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'filo-sidebar-'));
    // Re-prime the module's cache against the fresh userDataDir.
    await loadSidebarState();
  });

  afterEach(async () => {
    // Drain anything still in-flight from the test before nuking the dir
    // so we don't race a write into a non-existent path.
    await flushSidebarStateNow();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('persists a resize that arrived inside the 300ms debounce window', async () => {
    // Schedule a save — the cached state mutates immediately but the
    // disk write is queued behind the 300ms debounce.
    await updateSidebarState({ width: 444 });

    // Without flushNow, the file wouldn't exist yet (we're well below
    // 300ms). Drain explicitly.
    await flushSidebarStateNow();

    const raw = await fs.readFile(join(userDataDir, 'sidebar-state.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { width: number };
    expect(parsed.width).toBe(444);
  });

  it('is idempotent — calling twice resolves cleanly when nothing is pending', async () => {
    await flushSidebarStateNow();
    await flushSidebarStateNow();
    // Just asserting we don't throw is enough.
    expect(true).toBe(true);
  });

  it('awaits an in-flight write that started after the debounce fired', async () => {
    vi.useFakeTimers();
    try {
      await updateSidebarState({ width: 333 });
      // Advance past the 300ms debounce so the timer fires and the
      // in-flight write starts.
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
      // The timer has fired; the write is in flight. flushNow must
      // await the disk I/O before resolving.
      await flushSidebarStateNow();

      const raw = await fs.readFile(join(userDataDir, 'sidebar-state.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { width: number };
      expect(parsed.width).toBe(333);
    } finally {
      vi.useRealTimers();
    }
  });
});
