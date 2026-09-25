import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeBoardFile } from '@renderer/lib/boards/boardWriteScheduler';
import {
  noteBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';

/**
 * Audit 4.5 — a debounced `.board.json` write that fires AFTER the file has
 * been deleted on disk (external tool / sync client) must NOT resurrect it.
 *
 * `writeBoardFile`'s pre-write `vault:stat` swallows ENOENT, so the write
 * falls through to `board:save` whose `ensureDir + atomicWriteFile`
 * re-creates the directory and file — fighting the user's/sync's deletion.
 * The in-app delete path already cancels the armed write (`cancelBoardWrite`);
 * this closes the external-delete-racing-an-armed-write window.
 *
 * Fix: when the pre-write stat reports ENOENT for a path that HAD a baseline
 * (i.e. the file was previously known to exist on disk), abort the write as a
 * clean no-op so `board:save` never fires. Scoped to baseline-present so a
 * legitimate first write to a freshly-created board (no baseline yet, but the
 * file already exists via `board:create`) is never affected.
 */

type InvokeRecord = { channel: string; args: unknown[] };

function installFiloStub(calls: InvokeRecord[]): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      // The file is gone: vault:stat reports ENOENT (matches the real handler
      // shape — { success: false, code } — which invokeOk turns into a thrown
      // IpcEnvelopeError carrying code 'ENOENT').
      if (channel === 'vault:stat') return { success: false, code: 'ENOENT' };
      if (channel === 'board:save') return { ok: true };
      return null;
    },
    on: () => () => {},
    send: () => {},
  };
}

function makeCached(): BoardFileData {
  return {
    board: {
      id: 'b',
      type: 'mindmap',
      name: 'B',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

describe('writeBoardFile — externally-deleted file is not resurrected (audit 4.5)', () => {
  let calls: InvokeRecord[];
  beforeEach(() => {
    calls = [];
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    installFiloStub(calls);
  });
  afterEach(() => {
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  it('aborts the write (no board:save) when the file was deleted under an armed write', async () => {
    // The board was loaded/written before, so it has a drift baseline — i.e.
    // the file was known to exist on disk.
    noteBaseline('b.board.json', 1000, 200);

    await expect(writeBoardFile('/v', 'b.board.json', makeCached())).resolves.toBeUndefined();

    const boardSaves = calls.filter((c) => c.channel === 'board:save');
    expect(boardSaves.length).toBe(0);
  });
});
