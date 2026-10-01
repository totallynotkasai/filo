/**
 * The real writers on the full-save race (see fullSaveKeepsNewerWrite.test.ts):
 * a full save holds a copy of every waiting write and sends them in turn, and
 * a write scheduled again while an earlier one is slow must end on disk as its
 * newer version.
 *
 *  - boards: two boards, the first one's save slow; the second board is
 *    edited meanwhile (its drift baseline in place, as for a loaded board);
 *  - a board deleted during that save: the file moved to Filo's trash is the
 *    board's newest version;
 *  - the `.filo/` settings bundle (one key): a settings change made while an
 *    earlier bundle write is slow;
 *  - `.filo/tags.json` on the misc writer, behind a slow write of another
 *    `.filo/` file (its snapshot is taken when the write is scheduled).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  flushAllScheduledBoards,
  boardHasUnsavedWrite,
  type BoardWriteArgs,
} from '@renderer/lib/boards/boardWriteScheduler';
import { scheduleConfigWrite, flushScheduledConfig } from '@renderer/lib/boards/configWriteScheduler';
import { scheduleMiscWrite, flushAllMisc } from '@renderer/lib/boards/miscWriteScheduler';
import { __resetDirtyTrackingForTests, unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import type { BoardFileData } from '@renderer/lib/boards/tileDefBuilder';
import { noteBaseline, baselineSeq, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { TagsFile } from '@renderer/schema/tagsFile';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const ROOT = '/v';

/** A gate: `wait` resolves once `open` is called. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((res) => { open = res; });
  openGates.add(open);
  return { wait, open };
}
const openGates = new Set<() => void>();

/** Lets every promise chain that can run without a timer run. */
async function ticks(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function board(id: string, note: string): BoardFileData {
  return {
    board: {
      id, type: 'mindmap', name: id, emoji: '', createdAt: 0, updatedAt: 0,
      settings: { note }, placements: {}, inlineTiles: {}, waypoints: [],
    },
    tileDefs: {}, connections: {}, frames: [],
  } as unknown as BoardFileData;
}

/** The `settings.note` a board file on disk holds. */
function noteOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return (JSON.parse(text) as { board: { settings: { note?: string } } }).board.settings.note;
}

/**
 * A disk for board files: `board:save` stores (a path's next save waits while
 * `slowNext` holds a gate for it), `vault:stat` reads back, and
 * `vault:trash-move` records what the file held when it was moved.
 */
function boardDisk(): {
  files: Map<string, { text: string; mtimeMs: number }>;
  slowNext: Map<string, Promise<void>>;
  trashed: Array<{ rel: string; text: string | undefined }>;
  loaded(rel: string, text: string): void;
} {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const slowNext = new Map<string, Promise<void>>();
  const trashed: Array<{ rel: string; text: string | undefined }> = [];
  let clock = 1000;
  installFiloMock((channel: string, ...args: unknown[]) => {
    const rel = String(args[1]);
    if (channel === 'vault:stat') {
      const f = files.get(rel);
      if (!f) return { success: false, code: 'ENOENT' };
      return { success: true, mtimeMs: f.mtimeMs, size: byteLength(f.text) };
    }
    if (channel === 'board:save') {
      return (async () => {
        const slow = slowNext.get(rel);
        if (slow) {
          slowNext.delete(rel);
          await slow;
        }
        files.set(rel, { text: String(args[2]), mtimeMs: ++clock });
        return { success: true };
      })();
    }
    if (channel === 'vault:trash-move') {
      trashed.push({ rel, text: files.get(rel)?.text });
      files.delete(rel);
      return { success: true, trashId: 't1', kind: 'file' };
    }
    return undefined;
  });
  return {
    files,
    slowNext,
    trashed,
    // A board read from disk at open: its drift baseline is stamped.
    loaded(rel, text) {
      files.set(rel, { text, mtimeMs: ++clock });
      const f = files.get(rel)!;
      noteBaseline(rel, f.mtimeMs, byteLength(f.text), { ifUnchangedSince: baselineSeq(rel) });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetBaselinesForTests();
  __resetDirtyTrackingForTests();
});

afterEach(async () => {
  for (const open of openGates) open();
  openGates.clear();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  boardCacheStore.clear();
  fileTagsStore.reset();
  vaultStore.setPath('');
  __resetBaselinesForTests();
  __resetDirtyTrackingForTests();
  restoreFiloDefault();
});

describe('boards: a full save waiting on one board', () => {
  it('ends with the newer edit of a board edited meanwhile', async () => {
    const disk = boardDisk();
    disk.loaded('A.board.json', JSON.stringify(board('A', 'a-0'), null, 2));
    disk.loaded('B.board.json', JSON.stringify(board('B', 'b-0'), null, 2));
    const cache: Record<string, BoardFileData> = { A: board('A', 'a-1'), B: board('B', 'b-1') };
    const args = (id: string) => (): BoardWriteArgs => ({ vaultRoot: ROOT, boardPath: `${id}.board.json`, cached: cache[id] });

    const slowA = gate();
    disk.slowNext.set('A.board.json', slowA.wait);
    scheduleBoardWrite('A', args('A'));
    scheduleBoardWrite('B', args('B'));
    // Ctrl+S, or the save before a rename: A first (slow), then B (edit 1).
    const saving = flushAllScheduledBoards(() => null);

    cache.B = board('B', 'b-2'); // a tile dragged on B while A's save is slow
    scheduleBoardWrite('B', args('B'));
    await vi.advanceTimersByTimeAsync(400); // B's own timer saves edit 2
    expect(noteOf(disk.files.get('B.board.json')?.text)).toBe('b-2');

    slowA.open();
    const result = await saving;
    expect(result.failed).toEqual([]);
    expect(noteOf(disk.files.get('A.board.json')?.text)).toBe('a-1');
    expect(noteOf(disk.files.get('B.board.json')?.text)).toBe('b-2');
    expect(boardHasUnsavedWrite('A')).toBe(false);
    expect(boardHasUnsavedWrite('B')).toBe(false);
    expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
  });
});

describe('boards: deleting a board while a full save waits on another', () => {
  function openBoards(): ReturnType<typeof boardDisk> {
    const disk = boardDisk();
    vaultStore.setPath(ROOT);
    disk.loaded('A.board.json', JSON.stringify(board('A', 'a-0'), null, 2));
    disk.loaded('B.board.json', JSON.stringify(board('B', 'b-0'), null, 2));
    boardCacheStore.hydrate(
      { A: board('A', 'a-1'), B: board('B', 'b-1') },
      { A: 'A.board.json', B: 'B.board.json' },
    );
    return disk;
  }

  function editB(note: string): void {
    (boardCacheStore.cache.B.board.settings as { note?: string }).note = note;
    boardCacheStore.markDirty('B');
  }

  it("trashes the board's newest version when its newer edit was already saved", async () => {
    const disk = openBoards();
    const slowA = gate();
    disk.slowNext.set('A.board.json', slowA.wait);
    boardCacheStore.markDirty('A');
    boardCacheStore.markDirty('B');
    const saving = boardCacheStore.flushAllDirty();

    editB('b-2');
    await vi.advanceTimersByTimeAsync(400); // edit 2 saved by B's own timer
    const deleting = boardCacheStore.deleteBoard('B');
    await ticks();
    slowA.open(); // the move itself waits for every write in flight
    expect(await deleting).toMatchObject({ boardPath: 'B.board.json', trashId: 't1' });
    await saving;

    expect(disk.trashed.map((t) => ({ rel: t.rel, note: noteOf(t.text) }))).toEqual([
      { rel: 'B.board.json', note: 'b-2' },
    ]);
    expect(disk.files.has('B.board.json')).toBe(false);
  });

  it("trashes the board's newest version when its newer edit was still waiting", async () => {
    const disk = openBoards();
    const slowA = gate();
    disk.slowNext.set('A.board.json', slowA.wait);
    boardCacheStore.markDirty('A');
    boardCacheStore.markDirty('B');
    const saving = boardCacheStore.flushAllDirty();

    editB('b-2'); // the last change before the delete, inside its debounce
    const deleting = boardCacheStore.deleteBoard('B');
    await ticks();
    slowA.open();
    expect(await deleting).toMatchObject({ boardPath: 'B.board.json', trashId: 't1' });
    await saving;

    expect(disk.trashed.map((t) => ({ rel: t.rel, note: noteOf(t.text) }))).toEqual([
      { rel: 'B.board.json', note: 'b-2' },
    ]);
    expect(disk.files.has('B.board.json')).toBe(false);
  });
});

describe('the .filo/ settings bundle', () => {
  it('ends with a settings change made while an earlier bundle write is slow', async () => {
    const files = new Map<string, { text: string; mtimeMs: number }>();
    let clock = 1000;
    const slowOne = gate();
    const threeLanded = gate();
    const save = async (file: string, payload: string): Promise<void> => {
      if (file === 'app.json') {
        if (payload.includes('"One"')) await slowOne.wait;
        // An older bundle write still out must not be the last to land.
        if (payload.includes('"Two"')) await threeLanded.wait;
      }
      files.set(file, { text: payload, mtimeMs: ++clock });
      if (file === 'app.json' && payload.includes('"Three"')) threeLanded.open();
    };
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'config:save') return save(String(args[1]), String(args[2]));
      if (channel === 'config:save-workspace') return save('workspace.json', String(args[1]));
      if (channel === 'vault:stat') {
        const f = files.get(String(args[1]).replace(/^\.filo\//, ''));
        return f ? { success: true, mtimeMs: f.mtimeMs, size: byteLength(f.text) } : { success: false, code: 'ENOENT' };
      }
      if (channel === 'config:load') {
        const f = files.get(String(args[1]));
        return f ? JSON.parse(f.text) : null;
      }
      return undefined;
    });

    let font = 'One';
    const bundle = () => () => ({
      vaultRoot: ROOT,
      settings: { general: { globalFont: font }, mindmap: {}, kanban: {}, tasklist: {}, document: {} } as never,
      theme: 'light',
      workspace: { openTabs: [], activeTabId: '' },
      layout: { paneTree: null, activePaneId: null, boardToolbars: {} },
    });
    const appFont = (): string | undefined =>
      (JSON.parse(files.get('app.json')?.text ?? '{}') as { globalFont?: string }).globalFont;

    scheduleConfigWrite(bundle());
    await vi.advanceTimersByTimeAsync(400); // bundle 1 is sent and is slow
    font = 'Two';
    scheduleConfigWrite(bundle());
    const saving = flushScheduledConfig(() => null); // holds bundle 2 behind bundle 1

    font = 'Three';
    scheduleConfigWrite(bundle());
    await vi.advanceTimersByTimeAsync(400);
    slowOne.open();
    await saving;
    await vi.advanceTimersByTimeAsync(400);
    await ticks();

    expect(appFont()).toBe('Three');
    expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
  });
});

describe('.filo/tags.json behind a slow write of another .filo/ file', () => {
  it('ends with the tag change made meanwhile', async () => {
    let tagsOnDisk: string | null = null;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:load') return tagsOnDisk;
      if (channel === 'tags:save') {
        tagsOnDisk = String(args[1]);
        return undefined;
      }
      return undefined;
    });
    const base: TagsFile = { version: 1, tags: {}, fileTags: {} };
    fileTagsStore.commitFromCandidate(ROOT, base);

    const slow = gate();
    scheduleMiscWrite('slow-file', () => ({
      vaultRoot: ROOT,
      path: '.filo/slow.json',
      write: async () => { await slow.wait; },
    }));
    fileTagsStore.setFileTags('a.png', ['one']);
    const saving = flushAllMisc(); // the slow file first, then tags (edit 1)

    fileTagsStore.setFileTags('a.png', ['two']);
    await vi.advanceTimersByTimeAsync(400); // edit 2 saved by its own timer
    const tagsOf = (): string[] | undefined =>
      tagsOnDisk === null ? undefined : (JSON.parse(tagsOnDisk) as TagsFile).fileTags['a.png'];
    expect(tagsOf()).toEqual(['two']);

    slow.open();
    expect((await saving).failed).toEqual([]);
    expect(tagsOf()).toEqual(['two']);
    expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
  });
});
