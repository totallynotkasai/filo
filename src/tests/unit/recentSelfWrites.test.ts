import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  markRecentSelfWrite,
  isRecentSelfWrite,
  trackComponentWrite,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Tests the Phase 19 S3 renderer-side recent-self-write registry. The
 * registry is the safety net that drops late OS-level watcher events for
 * paths the renderer just wrote — without it, a bulk operation that
 * outruns the main-side suppression window fires spurious external-edit
 * toasts.
 */
describe('recentSelfWrites registry', () => {
  beforeEach(() => {
    installFiloMock(async () => ({ success: true }));
    __resetDirtyTrackingForTests();
  });

  afterEach(() => {
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('isRecentSelfWrite returns false for an unmarked path', () => {
    expect(isRecentSelfWrite('Notes.md')).toBe(false);
  });

  it('isRecentSelfWrite returns true immediately after markRecentSelfWrite', () => {
    markRecentSelfWrite('Notes.md');
    expect(isRecentSelfWrite('Notes.md')).toBe(true);
  });

  it('normalises backslashes and leading slashes', () => {
    markRecentSelfWrite('sub\\Notes.md');
    expect(isRecentSelfWrite('sub/Notes.md')).toBe(true);

    markRecentSelfWrite('/Other.md');
    expect(isRecentSelfWrite('Other.md')).toBe(true);
  });

  it('empty path is a no-op', () => {
    markRecentSelfWrite('');
    expect(isRecentSelfWrite('')).toBe(false);
  });

  it('isRecentSelfWrite returns false once the TTL has expired', () => {
    vi.useFakeTimers();
    markRecentSelfWrite('Notes.md');
    expect(isRecentSelfWrite('Notes.md')).toBe(true);
    // Idle (no inflight) TTL is 1500ms.
    vi.advanceTimersByTime(1600);
    expect(isRecentSelfWrite('Notes.md')).toBe(false);
  });

  it('trackComponentWrite registers the path before writeFn runs (Phase A.2a)', async () => {
    // The OS watcher event for our own write can fire (and reach the renderer)
    // before the IPC promise resolves. Marking after the await let
    // `vault:files-changed` see the path as unknown-self-write and surface
    // a spurious external-edit toast for every freshly-created file. The fix
    // moves the mark to before the writeFn so suppression is active for the
    // entire IPC window. See [IMPL_PLAN_2026-05-23_v3.md] §A.2a.
    await trackComponentWrite('/vault', 'sub/Notes.md', async () => {
      expect(isRecentSelfWrite('sub/Notes.md')).toBe(true);
    });
    // Refreshed on success so the TTL extends past the IPC duration.
    expect(isRecentSelfWrite('sub/Notes.md')).toBe(true);
  });

  it('trackComponentWrite drops the path from the registry on failure (Phase 1 / 1.4)', async () => {
    // Phase 1 / 1.4 reverses the A.2a trade-off for the FAILURE branch.
    // The original A.2a behaviour kept the recent-self-write entry alive
    // after a failed write, on the theory that the tile-creation toast
    // spam was worse than a 1.5 s window where a true external edit
    // might be missed. That theory missed a worse failure mode: a real
    // recovery action by the user (re-saving in another editor, a git
    // checkout restoring the file) hits the OS watcher while the
    // registry still suppresses it, and the renderer's external-change
    // pipeline silently drops the event. Filo then continues with the
    // stale in-memory state and overwrites disk on the next debounce.
    //
    // Post-fix: the catch branch drops the registration so the next
    // OS-level event on the path flows through the external-change
    // pipeline normally. The toast-spam window only opens for the
    // SUCCESS branch (which keeps the mark refreshed via the post-await
    // call).
    await expect(
      trackComponentWrite(
        '/vault',
        'Failing.md',
        async () => {
          throw new Error('disk full');
        },
        { notifyOnError: false },
      ),
    ).rejects.toThrow('disk full');
    expect(isRecentSelfWrite('Failing.md')).toBe(false);
  });

  it('trackComponentWrite clears the registry on failure for the case-folded key (Phase 1 / 1.4)', async () => {
    // Defence-in-depth: the case-fold normalisation used by mark/check
    // also applies to the drop helper. A Windows-side failure path that
    // marked `Notes.md` and then threw must clear the registry entry
    // even though `recentSelfWrites` indexes case-insensitive on win32 /
    // darwin.
    await expect(
      trackComponentWrite(
        '/vault',
        'Notes.md',
        async () => {
          // Confirm the path WAS suppressed inside the IPC window before
          // the failure unwinds it.
          expect(isRecentSelfWrite('Notes.md')).toBe(true);
          throw new Error('EACCES');
        },
        { notifyOnError: false },
      ),
    ).rejects.toThrow('EACCES');
    // Drop applies regardless of OS — on Linux the key is exactly
    // `Notes.md`; on Windows/macOS it's `notes.md`. Either way the
    // public read for the original casing must return false.
    expect(isRecentSelfWrite('Notes.md')).toBe(false);
  });

  it('uses the bulk TTL while inflight writes are non-zero', async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const firstWrite = trackComponentWrite('/vault', 'First.md', () => {
      return new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });

    // While First.md is still in flight (inflight === 1), mark a sibling.
    // The bulk TTL (5000ms) must apply rather than the idle TTL (1500ms).
    markRecentSelfWrite('Sibling.md');

    vi.advanceTimersByTime(2000);
    expect(isRecentSelfWrite('Sibling.md')).toBe(true);

    resolveFirst();
    await firstWrite;
  });
});
