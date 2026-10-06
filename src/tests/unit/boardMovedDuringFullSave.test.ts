/**
 * A full save (`flushAll`: Ctrl+S, quit, a drain before a disk operation)
 * takes each waiting board's write, path included, when it starts, and sends
 * them one after another. If another program moves a board's file (or its
 * folder) while the save is still busy with an earlier board, the copy it
 * holds names the old path:
 * - it is replaced by a write that reads the board's new path, so the board
 *   is never written back where it was (a ghost copy, or a failed save into a
 *   folder that is gone);
 * - a write that failed at the old path, once the board saves at its new one,
 *   leaves no "couldn't save" mark behind for the rest of the session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleBoardWrite,
  flushAllScheduledBoards,
  type BoardWriteArgs,
} from '@renderer/lib/boards/boardWriteScheduler';
import { __resetDirtyTrackingForTests, unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import type { BoardFileData } from '@renderer/lib/boards/tileDefBuilder';
import { noteBaseline, baselineSeq, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const ROOT = '/v';
const openGates = new Set<() => void>();
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((res) => { open = res; });
  openGates.add(open);
  return { wait, open };
}
const bytes = (t: string): number => new TextEncoder().encode(t).length;

function board(id: string, note: string): BoardFileData {
  return {
    board: {
      id, type: 'mindmap', name: id, emoji: '', createdAt: 0, updatedAt: 0,
      settings: { note }, placements: {}, inlineTiles: {}, waypoints: [],
    },
    tileDefs: {}, connections: {}, frames: [],
  } as unknown as BoardFileData;
}

/** A disk that knows folders: `board:save` into a missing folder fails as main does. */
function disk() {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const folders = new Set<string>(['', 'Old', 'New']);
  const slowNext = new Map<string, Promise<void>>();
  let clock = 1000;
  const folderOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  installFiloMock((channel: string, ...args: unknown[]) => {
    const rel = String(args[1]);
    if (channel === 'vault:stat') {
      const f = files.get(rel);
      return f ? { success: true, mtimeMs: f.mtimeMs, size: bytes(f.text) } : { success: false, code: 'ENOENT' };
    }
    if (channel === 'board:save') {
      return (async () => {
        const slow = slowNext.get(rel);
        if (slow) { slowNext.delete(rel); await slow; }
        if (!folders.has(folderOf(rel))) return { ok: false, code: 'BOARD_FOLDER_MISSING', error: 'folder missing' };
        files.set(rel, { text: String(args[2]), mtimeMs: ++clock });
        return { ok: true };
      })();
    }
    return undefined;
  });
  return {
    files, folders, slowNext,
    loaded(rel: string, text: string) {
      files.set(rel, { text, mtimeMs: ++clock });
      noteBaseline(rel, clock, bytes(text), { ifUnchangedSince: baselineSeq(rel) });
    },
    move(from: string, to: string) {
      const f = files.get(from);
      if (!f) throw new Error(`no file at ${from}`);
      files.delete(from);
      files.set(to, f);
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
  __resetBaselinesForTests();
  __resetDirtyTrackingForTests();
  restoreFiloDefault();
});

/** Two boards, A (slow to save) and B in `Old/`, both with a change to save. */
function twoBoards() {
  const d = disk();
  d.loaded('A.board.json', JSON.stringify(board('A', 'a-0'), null, 2));
  d.loaded('Old/B.board.json', JSON.stringify(board('B', 'b-0'), null, 2));
  const paths: Record<string, string> = { A: 'A.board.json', B: 'Old/B.board.json' };
  const cache: Record<string, BoardFileData> = { A: board('A', 'a-1'), B: board('B', 'b-1') };
  const args = (id: string) => (): BoardWriteArgs => ({ vaultRoot: ROOT, boardPath: paths[id] ?? '', cached: cache[id] ?? board(id, '') });
  return { d, paths, args };
}

describe("a full save's copy of a board moved by another program", () => {
  it('a board file moved to another folder during the save is saved at its new path, never its old one', async () => {
    const { d, paths, args } = twoBoards();
    const slowA = gate();
    d.slowNext.set('A.board.json', slowA.wait);
    scheduleBoardWrite('A', args('A'));
    scheduleBoardWrite('B', args('B'));
    const saving = flushAllScheduledBoards(() => null); // A slow; B's copy waits

    // Explorer moves B's file to New/ (same name); the watcher's rename handler
    // rebinds the board and re-keys every path-keyed store.
    d.move('Old/B.board.json', 'New/B.board.json');
    paths.B = 'New/B.board.json';
    renameAllPathKeys('Old/B.board.json', 'New/B.board.json');

    slowA.open();
    await saving;
    await vi.runOnlyPendingTimersAsync();
    expect([...d.files.keys()].sort()).toEqual(['A.board.json', 'New/B.board.json']);
    expect(d.files.get('New/B.board.json')?.text).toContain('b-1');
    expect(unsavedWork().failed).toEqual([]);
  });

  it('a folder renamed during the save: the board is saved in the renamed folder, and nothing is left failed', async () => {
    const { d, paths, args } = twoBoards();
    const slowA = gate();
    d.slowNext.set('A.board.json', slowA.wait);
    scheduleBoardWrite('A', args('A'));
    scheduleBoardWrite('B', args('B'));
    const saving = flushAllScheduledBoards(() => null);

    // The folder Old is renamed to Moved by another program.
    d.folders.delete('Old');
    d.folders.add('Moved');
    d.move('Old/B.board.json', 'Moved/B.board.json');
    paths.B = 'Moved/B.board.json';
    renameAllPathKeys('Old', 'Moved');

    slowA.open();
    const first = await saving;
    await vi.runOnlyPendingTimersAsync();
    expect(first.failed).toEqual([]);
    expect(d.files.get('Moved/B.board.json')?.text).toContain('b-1');
    expect(unsavedWork().failed).toEqual([]);
  });

  it('a write already sent when the folder was renamed fails there; the next save at the new path clears that mark', async () => {
    const { d, paths, args } = twoBoards();
    const slowB = gate();
    d.slowNext.set('Old/B.board.json', slowB.wait);
    scheduleBoardWrite('B', args('B'));
    const saving = flushAllScheduledBoards(() => null); // B's write is out

    d.folders.delete('Old');
    d.folders.add('Moved');
    d.move('Old/B.board.json', 'Moved/B.board.json');
    paths.B = 'Moved/B.board.json';
    renameAllPathKeys('Old', 'Moved');
    slowB.open();
    const first = await saving;
    expect(first.failed).toEqual(['Old/B.board.json']);

    // The next save (Ctrl+S, quit, Retry) re-fires the kept write with fresh args.
    const second = await flushAllScheduledBoards(() => null);
    expect(second.failed).toEqual([]);
    expect(d.files.get('Moved/B.board.json')?.text).toContain('b-1');
    expect(unsavedWork().failed).toEqual([]);
  });
});
