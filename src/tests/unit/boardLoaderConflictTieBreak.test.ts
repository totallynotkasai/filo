import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadAllBoards } from '@renderer/lib/boards/boardLoader';
import { scanSyncConflicts, scanBoardFiles } from '../../main/vault/boardFileOps';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-19 ERR-3 / EXT-7 — duplicate board ids were resolved by scan order:
 * the FIRST file in code-unit order won, and ' ' / '-' sort before '.', so
 * `Plan (1).board.json` or `Plan - Copy.board.json` hijacked the canonical
 * `Plan.board.json` (every later save went into the copy). The ranking is now
 * name- and freshness-based, and a sync client's fork of a board (named
 * `Plan.board-HOST.json`, invisible to `board:list`) is listed separately.
 */

function envelope(id: string, name: string, frameId?: string) {
  return {
    version: 8,
    board: {
      id, type: 'mindmap', name, emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: {}, inlineTiles: {}, waypoints: [],
    },
    tileDefs: {},
    connections: {},
    frames: frameId
      ? [{ id: frameId, boardId: id, title: 'F', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, style: {}, collapsed: false, tileIds: [], createdAt: 0, updatedAt: 0 }]
      : [],
  };
}

function installBoards(files: Record<string, { data: unknown; mtimeMs: number }>): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    const rel = args[1] as string;
    if (channel === 'board:list') return Object.keys(files).sort();
    if (channel === 'vault:stat') return { success: true, mtimeMs: files[rel]?.mtimeMs ?? 0, size: 10 };
    if (channel === 'board:load') return { success: true, data: files[rel]!.data };
    return { success: true, ok: true };
  });
}

describe('duplicate board ids — tie-break (Audit-19 ERR-3)', () => {
  afterEach(() => restoreFiloDefault());

  it('the canonical file beats a "(1)" copy that sorts first (bite)', async () => {
    installBoards({
      'Plan (1).board.json': { data: envelope('b1', 'Plan'), mtimeMs: 200 }, // newer, but a copy
      'Plan.board.json': { data: envelope('b1', 'Plan'), mtimeMs: 100 },
    });
    const res = await loadAllBoards('/vault');
    expect(res.paths.b1).toBe('Plan.board.json');
    expect(res.failedBoards).toEqual([
      expect.objectContaining({ path: 'Plan (1).board.json', errorKind: 'sync-conflict-copy' }),
    ]);
  });

  it('"Plan - Copy.board.json" (older) loses to "Plan.board.json"', async () => {
    installBoards({
      'Plan - Copy.board.json': { data: envelope('b1', 'Plan'), mtimeMs: 50 },
      'Plan.board.json': { data: envelope('b1', 'Plan'), mtimeMs: 100 },
    });
    const res = await loadAllBoards('/vault');
    expect(res.paths.b1).toBe('Plan.board.json');
    expect(res.failedBoards[0]).toMatchObject({ path: 'Plan - Copy.board.json', errorKind: 'duplicate-board-id' });
  });

  it('two unrelated names with the same id → the newer wins; the message names both, neutrally', async () => {
    installBoards({
      'Alpha.board.json': { data: envelope('b1', 'Roadmap'), mtimeMs: 100 },
      'Beta.board.json': { data: envelope('b1', 'Roadmap'), mtimeMs: 300 },
    });
    const res = await loadAllBoards('/vault');
    expect(res.paths.b1).toBe('Beta.board.json');
    const msg = res.failedBoards[0]!.message;
    expect(msg).toContain('Beta.board.json');
    expect(msg).toContain('Alpha.board.json');
    expect(msg).not.toMatch(/remove the copy|duplicate was/i);
  });

  it("the loser's frames are not merged (Audit 1.2 contract)", async () => {
    installBoards({
      'Plan (1).board.json': { data: envelope('b1', 'Plan', 'loserFrame'), mtimeMs: 200 },
      'Plan.board.json': { data: envelope('b1', 'Plan', 'winnerFrame'), mtimeMs: 100 },
    });
    const res = await loadAllBoards('/vault');
    expect(res.cache.b1!.frames.map((f) => f.id)).toEqual(['winnerFrame']);
  });
});

describe('board:list-conflicts scan (Audit-19 EXT-7)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await fs.mkdtemp(join(tmpdir(), 'filo-board-conflicts-'));
  });
  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('lists a OneDrive fork of a board; board:list still returns only the canonical file', async () => {
    await fs.writeFile(join(vault, 'Plan.board.json'), '{}');
    await fs.writeFile(join(vault, 'Plan.board-DESKTOP-1A2B3C4.json'), '{}');
    await fs.writeFile(join(vault, 'Other.board (2).json'), '{}'); // weak, no sibling → ignored
    expect(await scanBoardFiles(vault)).toEqual(['Plan.board.json']);
    expect(await scanSyncConflicts(vault, [])).toEqual([
      { copyPath: 'Plan.board-DESKTOP-1A2B3C4.json', canonicalPath: 'Plan.board.json', client: 'onedrive' },
    ]);
  });

  it("lists a note's strong conflict copy beside its note, and no numbered note", async () => {
    await fs.mkdir(join(vault, 'Book'));
    await fs.writeFile(join(vault, 'Book', 'Chapter.md'), 'PC');
    await fs.writeFile(join(vault, 'Book', 'Chapter.sync-conflict-20261004-120000-ABCDEFG.md'), 'Phone');
    await fs.writeFile(join(vault, 'Part.md'), 'one');
    await fs.writeFile(join(vault, 'Part 2.md'), 'two');
    await fs.writeFile(join(vault, 'Lost.sync-conflict-20261004-120000-ABCDEFG.md'), 'no original');
    expect(await scanSyncConflicts(vault, [])).toEqual([
      { copyPath: 'Book/Chapter.sync-conflict-20261004-120000-ABCDEFG.md', canonicalPath: 'Book/Chapter.md', client: 'syncthing' },
    ]);
  });

  it('a Dropbox conflicted copy in a subfolder is found with its folder', async () => {
    await fs.mkdir(join(vault, 'Work'));
    await fs.writeFile(join(vault, 'Work', 'Plan.board.json'), '{}');
    await fs.writeFile(join(vault, 'Work', "Plan.board (Andrew's conflicted copy 2026-09-23).json"), '{}');
    const res = await scanSyncConflicts(vault, []);
    expect(res).toEqual([
      expect.objectContaining({ canonicalPath: 'Work/Plan.board.json', client: 'dropbox' }),
    ]);
  });
});
