/**
 * Audit-18 Phase 5 — Audit-17 recent-change regressions.
 *
 *  5.1 The lastView persist `$effect` cleanup fired on EVERY effect re-run
 *      (Svelte 5 runs the cleanup before each re-execution, not only on
 *      teardown), so a filter/sort change flushed the pending debounce
 *      immediately — structurally defeating the 300 ms debounce (each change
 *      wrote one behind). Fix: flush ONLY on a real board switch (`board?.id
 *      !== id`); the unmount flush moved to `filters.dispose()` / KanbanBoard's
 *      onDestroy, decoupled from the timer the cleanup may have just nulled.
 *  5.2 The teardown-time title commit (A17-4.1) renamed the `.md` with NO undo
 *      entry, fire-and-forget, racing the board switch. Fix: defer the commit
 *      one microtask past the switch and push `RenameTitleCommand` onto the
 *      tile's HOME board's stack via the new
 *      `historyStore.pushWithoutExecuteOnBoard`.
 *  5.3 `withDrainedWrites`' A17-3.4 sibling-parking re-ran a FULL drain per
 *      queued sibling on a drain failure (`return withDrainedWrites(op)`) — an
 *      N×60 s latency cliff + duplicate toasts. Fix: siblings share the outer
 *      drain's verdict (throw, no re-drain) and re-validate the vault
 *      generation after the park.
 *  5.4 The A17-5.3 post-write content read-back doubled per-write IO inside the
 *      bounded window; multi-MB notes on slow volumes could flap on timeout.
 *      Fix: size-gate the read-back at `MARKDOWN_READBACK_BYTE_THRESHOLD`
 *      (1 MB) — small notes read back, large notes accept size-only.
 *
 * The jsdom suite has no Svelte component-mount harness, so component wiring is
 * pinned via source-shape assertions (same pattern as audit17Phase4); the
 * behaviour lives in the extracted lib helpers / stores the components call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { Command } from '@renderer/commands/Command';
import { TaskListFiltersAndViews } from '@renderer/lib/tasklist/filtersAndViews.svelte';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

import {
  withDrainedWrites,
  PendingWritesFailedError,
  __resetDrainGuardForTests,
} from '@renderer/lib/vault/vaultOperations';
import {
  scheduleMarkdownWrite,
  markHydrated,
  writeMarkdownFile,
  setExternalEditPromptHandler,
  MARKDOWN_READBACK_BYTE_THRESHOLD,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { scheduleMiscWrite } from '@renderer/lib/boards/miscWriteScheduler';
import {
  getBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { uiStore } from '@renderer/stores/ui.svelte';

const ROOT = process.cwd();
const TASKLIST_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/boards/TaskListBoard.svelte'),
  'utf8',
);
const KANBAN_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/boards/KanbanBoard.svelte'),
  'utf8',
);
const TILE_HEADER_SRC = readFileSync(
  join(ROOT, 'src/renderer/components/tiles/TileHeader.svelte'),
  'utf8',
);

function makeMindMapFixture(id: string, name: string): V7BoardFileData {
  return {
    board: {
      id,
      type: 'mindmap',
      name,
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

function hydrateBoards(): void {
  boardCacheStore.hydrate(
    { mm: makeMindMapFixture('mm', 'Map'), other: makeMindMapFixture('other', 'Other') },
    { mm: 'map.board.json', other: 'other.board.json' },
  );
}

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

// ── 5.1 — lastView debounce ──────────────────────────────────────────────

describe('Audit-18 5.1 — lastView persist debounce restored', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    restoreFiloDefault();
  });

  function makeFilters(boardId: string): TaskListFiltersAndViews {
    return new TaskListFiltersAndViews({
      getSavedViewsRaw: () => [],
      updateSettings: () => {},
      setSavedViews: () => {},
      tickAndPersist: () => {},
      getGroupBy: () => 'section',
      getSortBy: () => 'manual',
      announce: () => {},
      getBoardId: () => boardId,
    });
  }

  it('dispose() flushes the pending slice even when the timer was ALREADY cleared (decoupled from the timer)', () => {
    hydrateBoards();
    const filters = makeFilters('other');
    filters.hydrateFromLastView('other', null);
    filters.applyFilterTags(['urgent']);
    // The persist-$effect cleanup now nulls the timer on a same-board / unmount
    // tick WITHOUT flushing (it flushes only on a board switch). Simulate that:
    // the timer is null at dispose time but a filter change is pending.
    filters.lastViewPersistTimer = null;
    filters.dispose();
    const other = boardCacheStore.cache['other'] as unknown as {
      board: { settings: { lastView?: { filterTags?: string[] } } };
    };
    // Pre-fix dispose() gated the flush on the timer, so this dropped the slice.
    expect(other.board.settings.lastView?.filterTags).toEqual(['urgent']);
  });

  it('dispose() does NOT flush when no board was hydrated (no spurious write)', () => {
    hydrateBoards();
    const filters = makeFilters('other');
    // Never hydrated → hydratedForBoardId stays null.
    filters.lastViewPersistTimer = null;
    expect(() => filters.dispose()).not.toThrow();
    const other = boardCacheStore.cache['other'] as unknown as {
      board: { settings: { lastView?: unknown } };
    };
    expect(other.board.settings.lastView).toBeUndefined();
  });

  it('source: TaskListBoard + KanbanBoard cleanup flushes ONLY on a board switch (guarded), preserving the debounce', () => {
    for (const src of [TASKLIST_SRC, KANBAN_SRC]) {
      // The cleanup clears the timer every tick but only flushes when the live
      // board id moved off the armed id (a real switch) — so a same-board
      // filter change re-arms the debounce instead of writing one-behind.
      const guardIdx = src.indexOf('if (board?.id !== id) {');
      expect(guardIdx).toBeGreaterThan(-1);
      const region = src.slice(guardIdx, guardIdx + 120);
      expect(region).toContain('flushLastViewForBoard(id, nextLastView)');
    }
  });

  it('source: KanbanBoard onDestroy flushes the pending lastView for the hydrated id (the unmount path the cleanup no longer covers)', () => {
    const idx = KANBAN_SRC.indexOf('if (hydratedForBoardId) {');
    expect(idx).toBeGreaterThan(-1);
    const region = KANBAN_SRC.slice(idx, idx + 320);
    expect(region).toContain('flushLastViewForBoard(hydratedForBoardId');
  });
});

// ── 5.2 — teardown title rename onto the home board's stack ───────────────

class NoopCommand extends Command {
  readonly targetBoardId: string;
  description = 'noop';
  ran = { execute: 0, undo: 0 };
  constructor(boardId: string) {
    super();
    this.targetBoardId = boardId;
  }
  execute(): void {
    this.ran.execute++;
  }
  undo(): void {
    this.ran.undo++;
  }
}

describe('Audit-18 5.2 — teardown title commit pushes onto the HOME board stack', () => {
  beforeEach(() => {
    installEmptyFiloStub();
    boardCacheStore.clear();
    boardStore.clearBoard();
    historyStore.clear();
    hydrateBoards();
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    boardCacheStore.clear();
    boardStore.clearBoard();
    restoreFiloDefault();
  });

  it('pushWithoutExecuteOnBoard files onto the NAMED board, not the active one', async () => {
    historyStore.setActiveBoard('mm'); // active board = mm (the switched-in one)
    const cmd = new NoopCommand('other'); // tile's HOME board = other
    historyStore.pushWithoutExecuteOnBoard(cmd, 'other');

    // The command did NOT land on the active board's stack.
    expect(historyStore.canUndo).toBe(false);
    // It landed on the home board's stack — undoable once that board is active.
    historyStore.setActiveBoard('other');
    expect(historyStore.canUndo).toBe(true);
    await historyStore.undo();
    expect(cmd.ran.undo).toBe(1);
    expect(historyStore.canUndo).toBe(false);
    expect(historyStore.canRedo).toBe(true);
  });

  it('pushWithoutExecuteOnBoard is a no-op when the board id is empty / null', () => {
    historyStore.setActiveBoard('mm');
    historyStore.pushWithoutExecuteOnBoard(new NoopCommand(''), '');
    historyStore.pushWithoutExecuteOnBoard(new NoopCommand('x'), null);
    historyStore.setActiveBoard('other');
    expect(historyStore.canUndo).toBe(false);
  });

  it('source: TileHeader DEFERS the teardown commit past the switch (queueMicrotask)', () => {
    const idx = TILE_HEADER_SRC.indexOf('if (snap) queueMicrotask(() => void applyTitleCommit(snap, true));');
    expect(idx).toBeGreaterThan(-1);
  });

  it('source: the text-tile teardown commit routes through pushWithoutExecuteOnBoard with tile.boardId + threaded boardId', () => {
    expect(TILE_HEADER_SRC).toContain('historyStore.pushWithoutExecuteOnBoard(');
    // The command threads { boardId: tile.boardId } so its targetBoardId
    // resolves to the home board (a later cross-board Ctrl+Z auto-switches).
    expect(TILE_HEADER_SRC).toContain('{ boardId: tile.boardId },');
    // and the push targets that same home board id (the 2nd arg).
    const pushIdx = TILE_HEADER_SRC.indexOf('historyStore.pushWithoutExecuteOnBoard(');
    expect(TILE_HEADER_SRC.slice(pushIdx, pushIdx + 320)).toContain('tile.boardId,');
  });
});

// ── 5.3 — withDrainedWrites failure-path recursion cap + post-park re-validate

describe('Audit-18 5.3 — withDrainedWrites siblings share the drain verdict', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetDrainGuardForTests();
    __resetVaultIdentityForTests();
    restoreFiloDefault();
    for (const t of uiStore.toasts) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetDrainGuardForTests();
    __resetVaultIdentityForTests();
    restoreFiloDefault();
    vi.useRealTimers();
  });

  it('concurrent siblings on a FAILED drain share the verdict — ONE drain, ONE toast, no re-drain', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => { releaseWrite = r; });
    let writeCalls = 0;

    installFiloMock({
      'vault:write-existing-file-text': async () => {
        writeCalls++;
        await writeGate; // park the drain in flight
        return { success: false, error: 'EACCES: permission denied' };
      },
    });

    markHydrated('Slow.md', false);
    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath: 'Slow.md',
      frontmatter: {},
      body: 'pending',
      callerId: 'c1',
    });
    vi.useFakeTimers();
    vi.advanceTimersByTime(400); // fire the debounce → write in flight (parked)
    vi.useRealTimers();

    const outerOp = vi.fn(async () => 'outer');
    const sib1Op = vi.fn(async () => 's1');
    const sib2Op = vi.fn(async () => 's2');

    const outer = withDrainedWrites(outerOp);
    await Promise.resolve(); // let the outer drain enter flight + arm drainPromise
    const s1 = withDrainedWrites(sib1Op);
    const s2 = withDrainedWrites(sib2Op);

    releaseWrite(); // write resolves (failure) → drain fails
    const results = await Promise.allSettled([outer, s1, s2]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(PendingWritesFailedError);
      }
    }
    // No op ran (the disk-shape change is refused behind a failed drain).
    expect(outerOp).not.toHaveBeenCalled();
    expect(sib1Op).not.toHaveBeenCalled();
    expect(sib2Op).not.toHaveBeenCalled();
    // The markdown write IPC fired EXACTLY ONCE — the siblings did NOT re-enter
    // a fresh full drain each (the pre-fix `return withDrainedWrites(op)`).
    expect(writeCalls).toBe(1);
    // Exactly ONE aggregated error toast (not one per sibling).
    expect(uiStore.toasts.filter((t) => t.type === 'error').length).toBe(1);
  });

  it('positive control: a successful drain lets a parked sibling proceed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let miscWrites = 0;

    installFiloMock({});
    scheduleMiscWrite('k-pos', () => ({
      vaultRoot: '/vault',
      path: '.filo/x.json',
      write: async () => {
        miscWrites++;
        await gate;
      },
    }));

    const outerOp = vi.fn(async () => 'outer');
    const sibOp = vi.fn(async () => 'sib');

    const outer = withDrainedWrites(outerOp);
    await Promise.resolve(); // outer drain parks on the gated misc write
    const sib = withDrainedWrites(sibOp);

    release();
    await Promise.all([outer, sib]);

    expect(outerOp).toHaveBeenCalledTimes(1);
    expect(sibOp).toHaveBeenCalledTimes(1);
    expect(miscWrites).toBe(1); // one drain, shared
  });

  it('a vault swap during the park aborts the sibling op (stale generation)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    installFiloMock({});
    scheduleMiscWrite('k-swap', () => ({
      vaultRoot: '/vault',
      path: '.filo/x.json',
      write: async () => { await gate; },
    }));

    const outerOp = vi.fn(async () => 'outer');
    const sibOp = vi.fn(async () => 'sib');

    const outer = withDrainedWrites(outerOp);
    await Promise.resolve();
    const sib = withDrainedWrites(sibOp);

    // A vault swap lands while the sibling is parked behind the in-flight drain.
    beginVaultGeneration('/new-vault');

    release();
    const [outerRes, sibRes] = await Promise.allSettled([outer, sib]);

    // The outer op ran (its drain succeeded before the swap was observed).
    expect(outerRes.status).toBe('fulfilled');
    expect(outerOp).toHaveBeenCalledTimes(1);
    // The sibling re-validated the generation after the park and bailed.
    expect(sibRes.status).toBe('rejected');
    expect(sibOp).not.toHaveBeenCalled();
  });
});

// ── 5.4 — markdown post-write read-back size-gate ─────────────────────────

interface Captured { channel: string; args: unknown[] }

function installSizeGateStub(opts: { intercept?: (channel: string, args: unknown[]) => unknown } = {}): Captured[] {
  const captured: Captured[] = [];
  let lastWrittenText: string | null = null;
  let lastWrittenBytes: number | null = null;
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:write-existing-file-text') {
        lastWrittenText = String(args[2]);
        lastWrittenBytes = new TextEncoder().encode(lastWrittenText).length;
      }
      if (opts.intercept) {
        const r = opts.intercept(channel, args);
        if (r !== undefined) return r;
      }
      if (channel === 'vault:read-file-text' && lastWrittenText !== null) {
        return { success: true, content: lastWrittenText, mtimeMs: 1, size: lastWrittenBytes };
      }
      if (channel === 'vault:stat') {
        // Post-write stat reports exactly the bytes we wrote (clean self-write).
        if (lastWrittenBytes !== null) {
          return { success: true, mtimeMs: 1100, size: lastWrittenBytes };
        }
        return { success: true, mtimeMs: 1000, size: 100 };
      }
      return { success: true, ok: true };
    },
    on: () => () => {},
    send: () => {},
  };
  return captured;
}

describe('Audit-18 5.4 — post-write read-back is size-gated', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    __resetVaultIdentityForTests();
    setExternalEditPromptHandler(null);
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    __resetVaultIdentityForTests();
    setExternalEditPromptHandler(null);
    restoreFiloDefault();
  });

  it('exports a 1 MB threshold', () => {
    expect(MARKDOWN_READBACK_BYTE_THRESHOLD).toBe(1_000_000);
  });

  it('SMALL note (< 1 MB): reads the bytes back AND stamps the baseline', async () => {
    const invokes = installSizeGateStub();
    const relPath = 'small.md';
    markHydrated(relPath, false, 1000, 100);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'tiny body',
      callerId: 'small',
      docId: null,
    });

    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // The post-write read-back ran for the small note.
    expect(invokes.filter((i) => i.channel === 'vault:read-file-text').length).toBe(1);
    // Baseline stamped to the post-write stat (size = the bytes we wrote).
    expect(getBaseline(relPath)?.mtimeMs).toBe(1100);
  });

  it('LARGE note (>= 1 MB): SKIPS the read-back but still stamps the baseline (size-only)', async () => {
    const invokes = installSizeGateStub();
    const relPath = 'large.md';
    markHydrated(relPath, false, 1000, 100);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'x'.repeat(1_500_000), // > 1 MB
      callerId: 'large',
      docId: null,
    });

    expect(invokes.some((i) => i.channel === 'vault:write-existing-file-text')).toBe(true);
    // No post-write read-back for the large note (the IO-doubling we avoid).
    expect(invokes.filter((i) => i.channel === 'vault:read-file-text').length).toBe(0);
    // Size-only confirmation still stamped the baseline (NOT a missed stamp).
    expect(getBaseline(relPath)?.mtimeMs).toBe(1100);
  });

  it('SMALL note same-byte-count foreign write is STILL rejected (read-back protection intact)', async () => {
    // The post-write read-back returns DIFFERENT content of the same byte
    // count (a foreign write that landed in the write→stat gap).
    const invokes = installSizeGateStub({
      intercept: (channel) => {
        if (channel === 'vault:read-file-text') {
          return { success: true, content: 'DIFFERENT', mtimeMs: 1, size: 9 };
        }
        return undefined;
      },
    });
    const relPath = 'foreign.md';
    markHydrated(relPath, false, 1000, 100);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'mybody!!', // small → read-back runs
      callerId: 'foreign',
      docId: null,
    });

    expect(invokes.filter((i) => i.channel === 'vault:read-file-text').length).toBe(1);
    // Content mismatch → baseline KEPT (not stamped to the foreign write), so
    // the drift gate re-detects + prompts on the next write.
    expect(getBaseline(relPath)).toEqual({ mtimeMs: 1000, size: 100 });
  });

  it('source: the read-back is gated by writtenByteLength < MARKDOWN_READBACK_BYTE_THRESHOLD', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/lib/vault/markdownFileWriter.ts'),
      'utf8',
    );
    expect(src).toContain('if (writtenByteLength < MARKDOWN_READBACK_BYTE_THRESHOLD) {');
  });
});
