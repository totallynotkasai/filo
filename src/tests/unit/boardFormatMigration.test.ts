/**
 * A board in an older board format is carried forward by the migration
 * steps and opens; opening it writes nothing. Its first save copies the file
 * as it was to `.filo/recovery/<ts>-keep/` and only then writes the current
 * format, once. A copy that can't be made refuses the save (kept for Retry),
 * so the file is never written over uncopied. A step that fails leaves the
 * board listed as failed and its file as it was.
 *
 * Driven by a synthetic format 7, in which a Kanban board called its columns
 * `lanes`, carried to the current format 8 by a test-only step.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadAllBoards, loadBoard } from '@renderer/lib/boards/boardLoader';
import { adoptLoadedBoardBaseline } from '@renderer/lib/boards/boardBaseline';
import { retryFailedBoardWrite, scheduleBoardWrite, type BoardWriteArgs } from '@renderer/lib/boards/boardWriteScheduler';
import {
  hasUncopiedOlderFormat,
  keepOlderFormatFile,
  noteLoadedBoardFormat,
  olderFormatBoardsNotice,
} from '@renderer/lib/boards/migratedBoards';
import { buildWriteErrorToast } from '@renderer/lib/boards/writeErrorToast';
import {
  setWriteErrorListener,
  unsavedWork,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { __setBoardMigrationStepsForTests, migrateBoardFile, type BoardMigrationStep } from '@renderer/schema/migrations';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import type { KanbanBoard } from '@renderer/schema/index';

const REL = 'Plan.board.json';

const renameLanes: BoardMigrationStep = {
  from: 7,
  to: 8,
  migrate: (file) => {
    const { lanes, ...board } = file.board as Record<string, unknown>;
    return { ...file, board: { ...board, columns: lanes } };
  },
};

function olderBoardText(id = 'kb', lanes = [{ id: 'c1', title: 'To do', position: 0 }]): string {
  return JSON.stringify(
    {
      version: 7,
      board: { id, type: 'kanban', name: 'Plan', emoji: '', createdAt: 0, updatedAt: 0, settings: {}, lanes },
      tileDefs: {},
      connections: {},
      frames: [],
    },
    null,
    2,
  );
}

interface Disk {
  files: Map<string, string>;
  /** Copies kept in `.filo/recovery`, by the path they were taken of. */
  kept: Map<string, string>;
  calls: string[];
  /** The failure code `recovery:snapshot` answers with, or null to succeed. */
  snapshotFails: string | null;
  shown: string[];
}

function install(files: Record<string, string>): Disk {
  const disk: Disk = { files: new Map(Object.entries(files)), kept: new Map(), calls: [], snapshotFails: null, shown: [] };
  const mtimes = new Map<string, number>();
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      disk.calls.push(channel);
      const rel = String(args[1] ?? '');
      switch (channel) {
        case 'vault:stat': {
          const text = disk.files.get(rel);
          if (text === undefined) return { ok: false, code: 'ENOENT', error: 'ENOENT' };
          return { success: true, mtimeMs: mtimes.get(rel) ?? 1000, size: text.length };
        }
        case 'board:list':
          return [...disk.files.keys()].filter((k) => k.endsWith('.board.json'));
        case 'board:load': {
          const text = disk.files.get(rel);
          if (text === undefined) return { ok: false, code: 'ENOENT', error: 'ENOENT' };
          return JSON.parse(text) as unknown;
        }
        case 'board:save':
          disk.files.set(rel, String(args[2]));
          mtimes.set(rel, (mtimes.get(rel) ?? 1000) + 1);
          return { success: true };
        case 'recovery:snapshot': {
          if (disk.snapshotFails) return { ok: false, code: disk.snapshotFails, error: disk.snapshotFails };
          const text = disk.files.get(rel);
          if (text === undefined) return { ok: false, code: 'ENOENT', error: 'ENOENT' };
          disk.kept.set(rel, text);
          return { ok: true, path: `/vault/.filo/recovery/2026-10-01T10-00-00.000-keep/${rel}` };
        }
        case 'shell:show-item-in-folder':
          disk.shown.push(String(args[0]));
          return { ok: true };
        default:
          return undefined;
      }
    },
    on: () => () => {},
    send: () => {},
  };
  return disk;
}

const getArgs = (): BoardWriteArgs | null => {
  const cached = boardCacheStore.cache.kb;
  const boardPath = boardCacheStore.paths.kb;
  return cached && boardPath ? { vaultRoot: '/vault', boardPath, cached } : null;
};

/** Loads the board the way the open does: load, then adopt into the cache. */
async function openBoard(rel = REL): Promise<void> {
  const result = await loadBoard('/vault', rel);
  if (!result.ok) throw new Error(result.message);
  boardCacheStore.hydrate({ kb: result.data }, { kb: rel });
  adoptLoadedBoardBaseline(rel, result.baseline);
}

/** A change to the board, saved after the board debounce. */
async function editBoard(emoji: string): Promise<void> {
  (boardCacheStore.cache.kb!.board as KanbanBoard).emoji = emoji;
  scheduleBoardWrite('kb', getArgs);
  await vi.advanceTimersByTimeAsync(400);
}

function savedVersion(disk: Disk, rel = REL): unknown {
  return (JSON.parse(disk.files.get(rel) ?? '{}') as { version?: unknown }).version;
}

describe('a board in an older format', () => {
  let failures: WriteErrorInfo[];

  beforeEach(() => {
    vi.useFakeTimers();
    __setBoardMigrationStepsForTests([renameLanes]);
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    failures = [];
    setWriteErrorListener((info) => failures.push(info));
  });

  afterEach(() => {
    setWriteErrorListener(null);
    __setBoardMigrationStepsForTests(null);
    vi.useRealTimers();
    vaultStore.setPath('');
    boardCacheStore.clear();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    delete (window as unknown as Record<string, unknown>).filo;
  });

  it('opens in the current format, and opening it writes nothing', async () => {
    const original = olderBoardText();
    const disk = install({ [REL]: original });
    const result = await loadBoard('/vault', REL);
    if (!result.ok) throw new Error(result.message);
    expect(result.migratedFrom).toBe(7);
    expect(result.data.version).toBe(8);
    expect((result.data.board as KanbanBoard).columns.map((c) => c.title)).toEqual(['To do']);
    expect('lanes' in result.data.board).toBe(false);

    boardCacheStore.hydrate({ kb: result.data }, { kb: REL });
    adoptLoadedBoardBaseline(REL, result.baseline);
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.calls).not.toContain('board:save');
    expect(disk.calls).not.toContain('recovery:snapshot');
    expect(disk.files.get(REL)).toBe(original);
    expect(hasUncopiedOlderFormat(REL)).toBe(true);
  });

  it('its first save keeps the file as it was, then writes the current format', async () => {
    const original = olderBoardText();
    const disk = install({ [REL]: original });
    await openBoard();
    await editBoard('pin');

    expect(disk.kept.get(REL)).toBe(original);
    const order = disk.calls.filter((c) => c === 'recovery:snapshot' || c === 'board:save');
    expect(order).toEqual(['recovery:snapshot', 'board:save']);
    expect(savedVersion(disk)).toBe(8);
    const saved = JSON.parse(disk.files.get(REL) ?? '{}') as { board: Record<string, unknown> };
    expect(saved.board.emoji).toBe('pin');
    expect((saved.board.columns as Array<{ title: string }>).map((c) => c.title)).toEqual(['To do']);
    expect('lanes' in saved.board).toBe(false);
    expect(failures).toEqual([]);
    expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
  });

  it('tells the user once where the copy is, with Show in folder', async () => {
    const disk = install({ [REL]: olderBoardText() });
    await openBoard();
    await editBoard('one');
    await editBoard('two');

    const notices = uiStore.toasts.filter((t) => t.text.includes('is now saved in this version\'s board format'));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toBe('"Plan" is now saved in this version\'s board format. A copy of the file as it was is in .filo/recovery.');
    const show = notices[0].actions?.find((a) => a.label === 'Show in folder');
    await show?.handler();
    expect(disk.shown).toEqual(['/vault/.filo/recovery/2026-10-01T10-00-00.000-keep/Plan.board.json']);
  });

  it('later saves keep no more copies', async () => {
    const disk = install({ [REL]: olderBoardText() });
    await openBoard();
    await editBoard('one');
    await editBoard('two');
    await editBoard('three');
    expect(disk.calls.filter((c) => c === 'recovery:snapshot')).toHaveLength(1);
    expect(disk.calls.filter((c) => c === 'board:save')).toHaveLength(3);
    expect(hasUncopiedOlderFormat(REL)).toBe(false);
  });

  it('is not written over when the copy fails, and Retry saves it once the copy can be made', async () => {
    const original = olderBoardText();
    const disk = install({ [REL]: original });
    await openBoard();
    disk.snapshotFails = 'ENOSPC';
    await editBoard('pin');

    expect(disk.files.get(REL)).toBe(original);
    expect(disk.calls).not.toContain('board:save');
    expect(failures).toHaveLength(1);
    const toast = buildWriteErrorToast(failures[0]);
    expect(toast.context).toBe('Board not saved');
    expect(toast.message).toContain('is in an older board format, and Filo couldn\'t keep a copy of it in .filo/recovery');
    expect(toast.retryable).toBe(true);
    expect(unsavedWork().failed).toEqual([REL.toLowerCase()]);

    disk.snapshotFails = null;
    const retried = await retryFailedBoardWrite('kb');
    expect(retried.failed).toEqual([]);
    expect(disk.kept.get(REL)).toBe(original);
    expect(savedVersion(disk)).toBe(8);
    expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
  });

  it('says when the file is too large to copy', async () => {
    const disk = install({ [REL]: olderBoardText() });
    await openBoard();
    disk.snapshotFails = 'RECOVERY_SNAPSHOT_TOO_LARGE';
    await editBoard('pin');
    const toast = buildWriteErrorToast(failures[0]);
    expect(toast.message).toContain('larger than the 25 MB Filo copies');
    expect(toast.retryable).toBe(false);
    expect(disk.calls).not.toContain('board:save');
  });

  it('keeps the copy of a file renamed before its first save, at its new path', async () => {
    const original = olderBoardText();
    const disk = install({ 'Old.board.json': original });
    await openBoard('Old.board.json');
    disk.files.set('New.board.json', original);
    disk.files.delete('Old.board.json');
    renameAllPathKeys('Old.board.json', 'New.board.json');
    boardCacheStore.renameBoardPath('Old.board.json', 'New.board.json');
    expect(hasUncopiedOlderFormat('New.board.json')).toBe(true);

    await editBoard('pin');
    expect(disk.kept.get('New.board.json')).toBe(original);
    expect(savedVersion(disk, 'New.board.json')).toBe(8);
  });

  it('a board read again in the current format keeps no copy', async () => {
    install({ [REL]: olderBoardText() });
    noteLoadedBoardFormat(REL, 7);
    noteLoadedBoardFormat(REL, undefined);
    expect(hasUncopiedOlderFormat(REL)).toBe(false);
    await keepOlderFormatFile('/vault', REL);
    expect(uiStore.toasts).toEqual([]);
  });

  it('a file that is gone has nothing to copy, and the save goes ahead', async () => {
    const disk = install({});
    noteLoadedBoardFormat(REL, 7);
    await keepOlderFormatFile('/vault', REL);
    expect(hasUncopiedOlderFormat(REL)).toBe(false);
    expect(disk.kept.size).toBe(0);
    expect(failures).toEqual([]);
  });

  it('a step that fails lists the board as failed and leaves its file as it was', async () => {
    __setBoardMigrationStepsForTests([
      {
        from: 7,
        to: 8,
        migrate: () => {
          throw new Error('lanes is not a list');
        },
      },
    ]);
    const original = olderBoardText();
    const disk = install({ [REL]: original });
    const result = await loadAllBoards('/vault');
    expect(result.boards).toEqual([]);
    expect(result.migratedBoards).toEqual([]);
    expect(result.failedBoards).toHaveLength(1);
    expect(result.failedBoards[0].errorKind).toBe('no-migration-path');
    expect(result.failedBoards[0].message).toBe(
      'This board was made by an older Filo, and updating it to this version\'s format failed (from version 7: lanes is not a list). The file was left unchanged.',
    );
    expect(disk.files.get(REL)).toBe(original);
    expect(disk.calls).not.toContain('board:save');
  });

  it('a step whose result fails validation lists the board as failed', async () => {
    const disk = install({ [REL]: olderBoardText('kb', [{ id: 'c1', title: '', position: 0 }]) });
    const result = await loadAllBoards('/vault');
    expect(result.failedBoards.map((f) => f.errorKind)).toEqual(['schema-invalid']);
    expect(disk.calls).not.toContain('board:save');
  });

  it('the open lists the boards it read from an older format', async () => {
    install({
      [REL]: olderBoardText('kb'),
      'Current.board.json': JSON.stringify({ ...JSON.parse(olderBoardText('k2')), version: 8 }),
    });
    const result = await loadAllBoards('/vault');
    expect(result.boards).toHaveLength(2);
    expect(result.migratedBoards).toEqual([REL]);
  });

  it('with no step for its version, the board is refused as before', async () => {
    __setBoardMigrationStepsForTests([]);
    const original = olderBoardText();
    const disk = install({ [REL]: original });
    const result = await loadBoard('/vault', REL);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('no-migration-path');
    expect(result.message).toBe('This board was made by an older Filo and is not supported. The file was left unchanged.');
    expect(disk.files.get(REL)).toBe(original);
  });
});

describe('migrateBoardFile with a step', () => {
  afterEach(() => {
    __setBoardMigrationStepsForTests(null);
  });

  const older = (): Record<string, unknown> => JSON.parse(olderBoardText()) as Record<string, unknown>;

  it('carries the file forward on a copy, even when the step changes its board in place', () => {
    __setBoardMigrationStepsForTests([
      {
        from: 7,
        to: 8,
        migrate: (file) => {
          const board = file.board as Record<string, unknown>;
          board.columns = board.lanes;
          delete board.lanes;
          return file;
        },
      },
    ]);
    const raw = older();
    const before = JSON.stringify(raw);
    const out = migrateBoardFile(raw);
    expect(out.migratedFrom).toBe(7);
    expect(out.noMigrationPath).toBe(false);
    expect((out.data as { version: number }).version).toBe(8);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('runs every step from the file\'s version, in order', () => {
    const seen: number[] = [];
    const step = (from: number): BoardMigrationStep => ({
      from,
      to: from + 1,
      migrate: (file) => {
        seen.push(from);
        expect(file.version).toBe(from);
        return from === 7 ? renameLanes.migrate(file) : file;
      },
    });
    __setBoardMigrationStepsForTests([step(5), step(6), step(7)]);
    const out = migrateBoardFile({ ...older(), version: 5 });
    expect(seen).toEqual([5, 6, 7]);
    expect(out.migratedFrom).toBe(5);
    expect((out.data as { version: number }).version).toBe(8);
  });

  it('refuses a file older than the first step, or with a gap on the way', () => {
    __setBoardMigrationStepsForTests([renameLanes]);
    expect(migrateBoardFile({ ...older(), version: 6 }).noMigrationPath).toBe(true);
    __setBoardMigrationStepsForTests([{ ...renameLanes, from: 5, to: 6 }, renameLanes]);
    expect(migrateBoardFile({ ...older(), version: 5 }).noMigrationPath).toBe(true);
  });

  it('refuses a step that would pass the current version', () => {
    __setBoardMigrationStepsForTests([{ ...renameLanes, to: 9 }]);
    const raw = older();
    const out = migrateBoardFile(raw);
    expect(out.noMigrationPath).toBe(true);
    expect(out.data).toBe(raw);
  });

  it('names a step that gives back something that isn\'t a board', () => {
    __setBoardMigrationStepsForTests([{ ...renameLanes, migrate: () => JSON.parse('[]') as Record<string, unknown> }]);
    const raw = older();
    const out = migrateBoardFile(raw);
    expect(out.noMigrationPath).toBe(true);
    expect(out.failure).toBe('from version 7: the step gave back something that isn\'t a board');
    expect(out.data).toBe(raw);
  });

  it('refuses a fractional version, above the current one too', () => {
    for (const version of [7.5, 8.5]) {
      const raw = { ...older(), version };
      const out = migrateBoardFile(raw);
      expect(out.noMigrationPath).toBe(true);
      expect(out.data).toBe(raw);
    }
  });

  it('leaves a current or newer file, and a string, alone', () => {
    __setBoardMigrationStepsForTests([renameLanes]);
    const current = { ...older(), version: 8 };
    expect(migrateBoardFile(current).data).toBe(current);
    expect(migrateBoardFile({ ...older(), version: 9 }).fromFuture).toBe(true);
    expect(migrateBoardFile(olderBoardText()).noMigrationPath).toBe(true);
  });
});

describe('the older-format notice', () => {
  it('names one board', () => {
    expect(olderFormatBoardsNotice(['Plans/Plan.board.json'])?.text).toBe(
      'The board "Plan" was made by an older version of Filo and opens in this version\'s board format. ' +
        'Its file changes to the new format only when you change the board, and Filo keeps a copy of the file as it was in .filo/recovery first.',
    );
  });

  it('names a few boards, and counts the rest', () => {
    expect(olderFormatBoardsNotice(['A.board.json', 'B.board.json'])?.text).toMatch(/^2 boards were made by an older version of Filo and open in this version's board format: "A" and "B"\. Each file/);
    expect(olderFormatBoardsNotice(['A.board.json', 'B.board.json', 'C.board.json'])?.text).toContain(': "A", "B" and "C".');
    const five = ['A', 'B', 'C', 'D', 'E'].map((n) => `${n}.board.json`);
    expect(olderFormatBoardsNotice(five)?.text).toContain('5 boards were made by an older version of Filo and open in this version\'s board format: "A", "B", "C" and 2 more.');
  });

  it('is not shown when no board was in an older format', () => {
    expect(olderFormatBoardsNotice([])).toBeNull();
  });
});
