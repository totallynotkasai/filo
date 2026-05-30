import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  cancelAllPendingWrites,
  __resetDirtyTrackingForTests,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { classifyExternalChange } from '@renderer/lib/vault/conflictResolver';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';
import type { MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 22 — Write Pipeline Robustness.
 *
 * Regression coverage for M6 (snapshot at schedule time) and M9 (partial-read
 * detection in the external-change classifier). M7/M8/M10 are exercised by
 * existing tests + their own focused suites.
 */

function emptyMindmapBoard(id: string, label = 'b'): V7BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name: label,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

/**
 * Phase C / C.5 supersedes Phase 22 M6 — `scheduleBoardWrite` now snapshots
 * at FIRE TIME (inside the timer callback) rather than at every schedule
 * call. Coalesces N keystrokes within the 300ms debounce window into a
 * single deep-clone instead of N. The Phase 22 race remains closed
 * because the fire-time snapshot is taken synchronously immediately
 * before `writeBoardFile` — no microtask can interleave between
 * `JSON.parse(JSON.stringify(args.cached))` and the call that consumes it.
 *
 * The behavioural consequence: a mutation that lands AFTER the schedule
 * call but BEFORE the timer fires IS reflected on disk (the cache is
 * already the source of truth; the snapshot just captures whatever it
 * holds when the debounce expires).
 */
describe('Phase 22 M6 / Phase C C.5 — scheduleBoardWrite snapshots at fire time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    cancelAllPendingWrites();
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('writes the latest cache state at fire time (was schedule-time before C.5)', async () => {
    let savedPayload: string | null = null;
    installFiloMock({
      'board:save': (..._args: unknown[]) => {
        savedPayload = String(_args[2]);
        return null;
      },
    });

    const live = emptyMindmapBoard('mm', 'before');

    scheduleBoardWrite('mm', () => ({
      vaultRoot: '/vault',
      boardPath: 'mm.board.json',
      cached: live,
    }));

    // Mutate the live proxy AFTER scheduling. Phase C / C.5 — the deferred
    // write now picks this up because the snapshot is taken at fire time.
    (live.board as { name: string }).name = 'after';

    await vi.advanceTimersByTimeAsync(500);

    expect(savedPayload).not.toBeNull();
    const out = JSON.parse(savedPayload!);
    expect(out.board.name).toBe('after');
  });

  it('re-scheduling within the debounce window collapses to a single fire-time snapshot', async () => {
    let savedPayload: string | null = null;
    let savesSeen = 0;
    installFiloMock({
      'board:save': (..._args: unknown[]) => {
        savedPayload = String(_args[2]);
        savesSeen += 1;
        return null;
      },
    });

    const live = emptyMindmapBoard('mm', 'v1');

    scheduleBoardWrite('mm', () => ({
      vaultRoot: '/vault',
      boardPath: 'mm.board.json',
      cached: live,
    }));

    (live.board as { name: string }).name = 'v2';
    scheduleBoardWrite('mm', () => ({
      vaultRoot: '/vault',
      boardPath: 'mm.board.json',
      cached: live,
    }));

    // Mutate again AFTER the second schedule but before the timer fires.
    // Phase C / C.5 — this lands on disk because the snapshot is taken at
    // fire time. (Pre-C.5 Phase 22 M6 would have frozen at the second
    // schedule call's v2.)
    (live.board as { name: string }).name = 'v3';

    await vi.advanceTimersByTimeAsync(500);

    expect(savesSeen).toBe(1);
    expect(savedPayload).not.toBeNull();
    const out = JSON.parse(savedPayload!);
    expect(out.board.name).toBe('v3');
  });
});

describe('Phase 22 M9 — classifyExternalChange flags likely partial reads', () => {
  // Phase 1 / 1.6 — the partial-read gate requires `next.lastModified`
  // to be inside a 100 ms freshness window (a stale mtime indicates the
  // rewrite already committed). Tests construct `next` with a current
  // timestamp so the historical contract still fires.
  function mkMeta(path: string, content: string, lastModified = Date.now()): FileMetadata {
    return {
      path,
      title: 'T',
      headings: [],
      tags: [],
      frontmatter: {},
      links: [],
      content,
      lastModified,
    };
  }

  it('returns partial-read-retry when a substantial file shrinks to empty on a clean editor', () => {
    const prev = mkMeta('Notes.md', 'a'.repeat(2048));
    const next = mkMeta('Notes.md', '');

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('partial-read-retry');
  });

  it('returns reload-silently for an in-bounds shrink (>10% of prior remaining)', () => {
    // C2 — threshold moved from absolute 64 bytes to <10% of prior size.
    // 2048 → 300 B keeps ~14.6% of the original, well above the threshold.
    const prev = mkMeta('Notes.md', 'a'.repeat(2048));
    const next = mkMeta('Notes.md', 'b'.repeat(300));

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('reload-silently');
  });

  it('returns partial-read-retry when a large file shrinks to <10% of prior', () => {
    // C2 — percentage-based threshold catches partial reads on large files
    // that the old absolute 64-byte threshold would miss. 100 KB → 5 KB is
    // a 95% shrink: well within partial-read territory.
    const prev = mkMeta('Notes.md', 'a'.repeat(100_000));
    const next = mkMeta('Notes.md', 'b'.repeat(5_000));

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('partial-read-retry');
  });

  it('returns reload-silently when the prior file was small (heuristic does not trigger)', () => {
    // 200B prior → 0B next. The heuristic ignores small prior files because
    // they can legitimately go to zero.
    const prev = mkMeta('Notes.md', 'a'.repeat(200));
    const next = mkMeta('Notes.md', '');

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('reload-silently');
  });

  it('still prompts on dirty editor even when partial-read pattern matches', () => {
    const prev = mkMeta('Notes.md', 'a'.repeat(2048));
    const next = mkMeta('Notes.md', '');

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: true },
    });

    // Dirty-editor branch takes precedence — never silently drop the partial
    // read on top of unsaved work, and never silently accept the partial
    // either; the toast lets the user choose.
    expect(decision.action).toBe('prompt-user');
  });

  /**
   * Phase 1 / 1.6 — the partial-read heuristic only fires while the
   * shrink is RECENT. A file shrunk hours ago has had its rewrite
   * committed; treating it as a partial read keeps the editor stuck on
   * stale content waiting for a retry that won't change anything.
   */
  it('returns reload-silently for a stale shrink (>1 hour old mtime)', () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const prev = mkMeta('Notes.md', 'a'.repeat(2048));
    const next = mkMeta('Notes.md', '', oneHourAgo);

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('reload-silently');
  });

  it('returns reload-silently for a shrink older than the 1000 ms freshness window', () => {
    // M5 (2026-05-28) — the freshness window widened from 100 ms to 1000 ms
    // so a slow truncate-then-rewrite is still caught. A shrink whose mtime
    // is older than the window (1500 ms ago) has had its rewrite committed
    // and is treated as a deliberate edit.
    const stale = Date.now() - 1500;
    const prev = mkMeta('Notes.md', 'a'.repeat(2048));
    const next = mkMeta('Notes.md', '', stale);

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('reload-silently');
  });

  it('returns partial-read-retry for a drastic shrink WITHIN the widened 1000 ms window', () => {
    // M5 — a 300 ms-old drastic shrink was previously (100 ms window) treated
    // as a deliberate edit and applied; it is now correctly held back as a
    // suspected partial read.
    const recent = Date.now() - 300;
    const prev = mkMeta('Notes.md', 'a'.repeat(2048));
    const next = mkMeta('Notes.md', '', recent);

    const decision = classifyExternalChange({
      path: 'Notes.md',
      previousMetadata: prev,
      nextMetadata: next,
      editor: { path: 'Notes.md', isDirty: false },
    });

    expect(decision.action).toBe('partial-read-retry');
  });
});
