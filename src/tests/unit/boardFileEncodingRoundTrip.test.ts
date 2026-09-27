import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveBoardFile, loadBoardFile, createBoardFile } from '../../main/vault/boardFileOps';
import { writtenByteLength } from '@renderer/lib/boards/boardWriteDebounce';
import { loadBoard } from '@renderer/lib/boards/boardLoader';
import { writeBoardFile, setBoardExternalEditHandler } from '@renderer/lib/boards/boardWriteScheduler';
import { getBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-19 ERR-1 — `.board.json` used to be JSON-encoded TWICE (the renderer
 * serialised, main serialised the string again), so the post-write size check
 * never matched and every board's 2nd save raised a false "modified externally"
 * prompt. These tests drive the REAL main-side board IO against a temp dir with
 * a real `fs.stat` — no stubbed sizes. Authority on real on-disk sizes (the
 * drift-logic unit tests in fileBaselineDrift.test.ts stub them).
 *
 * Bite: restore `const json = JSON.stringify(data, null, 2)` in saveBoardFile →
 * (a) and (e) go red (the external-edit handler fires on save #2).
 */

function board(name = 'Alpha'): BoardFileData {
  const now = 1_700_000_000_000;
  return {
    version: 8,
    board: {
      id: 'mindmap-1',
      name,
      emoji: '',
      type: 'mindmap',
      settings: {},
      placements: {},
      inlineTiles: {},
      createdAt: now,
      updatedAt: now,
    } as BoardFileData['board'],
    tileDefs: {},
    connections: {},
    frames: [],
  } as BoardFileData;
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'filo-board-enc-'));
  __resetBaselinesForTests();
});

afterEach(async () => {
  setBoardExternalEditHandler(null);
  restoreFiloDefault();
  await fs.rm(root, { recursive: true, force: true });
});

describe('board file encoding (real fs)', () => {
  it('(a) a string payload is written verbatim: plain JSON object, size === payload bytes', async () => {
    const data = board();
    const payload = JSON.stringify(data, null, 2);
    const p = join(root, 'A.board.json');
    await saveBoardFile(p, payload);
    const onDisk = await fs.readFile(p, 'utf-8');
    const parsed: unknown = JSON.parse(onDisk);
    expect(typeof parsed).toBe('object');
    expect(parsed).toEqual(data);
    expect((await fs.stat(p)).size).toBe(writtenByteLength(payload));
  });

  it('(b) a double-encoded file is parsed once: main hands back the string, not a board', async () => {
    const data = board();
    const p = join(root, 'Legacy.board.json');
    await fs.writeFile(p, JSON.stringify(JSON.stringify(data, null, 2), null, 2), 'utf-8');
    expect(await loadBoardFile(p)).toBe(JSON.stringify(data, null, 2));
  });

  it('(c) a hand-written plain-JSON board loads', async () => {
    const data = board();
    const p = join(root, 'Plain.board.json');
    await fs.writeFile(p, JSON.stringify(data), 'utf-8');
    expect(await loadBoardFile(p)).toEqual(data);
  });

  // The name is the file stem, so a taken name is refused, never bumped to
  // ` (2)` (a board named differently from its file), and the first file is
  // left as it was.
  it('(d) createBoardFile writes plain JSON and refuses a taken name', async () => {
    const fd = board('X');
    const first = await createBoardFile(root, 'X', JSON.stringify(fd, null, 2));
    const before = await fs.readFile(first, 'utf-8');
    expect(typeof JSON.parse(before)).toBe('object');
    await expect(createBoardFile(root, 'X', JSON.stringify(board('other'), null, 2)))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(first, 'utf-8')).toBe(before);
    expect((await fs.readdir(root)).filter((n) => n.includes('(2)'))).toEqual([]);
  });

  it('refuses a string payload that is not a JSON object', async () => {
    await expect(saveBoardFile(join(root, 'Bad.board.json'), '"oops"')).rejects.toThrow(/not a JSON object/);
  });

  it('(e) renderer load → save → save: no external-edit prompt, baseline tracks disk', async () => {
    const rel = 'Plain.board.json';
    const abs = join(root, rel);
    // Compact JSON on disk, so save #1 (pretty-printed) changes the size.
    await fs.writeFile(abs, JSON.stringify(board()), 'utf-8');

    const stat = async (r: string) => {
      const s = await fs.stat(join(root, r));
      return { success: true, ok: true, mtimeMs: s.mtimeMs, size: s.size };
    };
    (window as unknown as { filo: unknown }).filo = {
      invoke: async (channel: string, _root: string, r: string, data?: unknown) => {
        if (channel === 'vault:stat') return stat(r);
        if (channel === 'board:load') return loadBoardFile(join(root, r));
        if (channel === 'board:save') {
          await saveBoardFile(join(root, r), data);
          return { success: true, ok: true };
        }
        return undefined;
      },
      on: () => () => undefined,
      send: () => undefined,
    };
    const handler = vi.fn(async () => 'defer' as const);
    setBoardExternalEditHandler(handler);

    const loaded = await loadBoard(root, rel);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const data = loaded.data;

    // Save #1 — reformats the file. mtime resolution can be coarse; nudge time.
    data.board.name = 'Edit 1';
    await writeBoardFile(root, rel, structuredClone(data));
    expect(typeof JSON.parse(await fs.readFile(abs, 'utf-8'))).toBe('object');
    expect(getBaseline(rel)?.size).toBe((await fs.stat(abs)).size);

    await new Promise((r) => setTimeout(r, 20));
    data.board.name = 'Edit 2';
    await writeBoardFile(root, rel, structuredClone(data));
    expect(getBaseline(rel)?.size).toBe((await fs.stat(abs)).size);

    await new Promise((r) => setTimeout(r, 20));
    data.board.name = 'Edit 3';
    await writeBoardFile(root, rel, structuredClone(data));

    expect(handler).not.toHaveBeenCalled();
    const final = JSON.parse(await fs.readFile(abs, 'utf-8')) as BoardFileData;
    expect(final.board.name).toBe('Edit 3');
  });

  it.each([
    ['a double-encoded file', (d: BoardFileData) => JSON.stringify(JSON.stringify(d, null, 2), null, 2)],
    ['a version 7 file', (d: BoardFileData) => JSON.stringify({ ...d, version: 7 }, null, 2)],
  ])('(f) %s is refused by the renderer and never written', async (_label, encode) => {
    const rel = 'Old.board.json';
    const abs = join(root, rel);
    const bytes = encode(board());
    await fs.writeFile(abs, bytes, 'utf-8');
    const channels: string[] = [];
    (window as unknown as { filo: unknown }).filo = {
      invoke: async (channel: string, _root: string, r: string) => {
        channels.push(channel);
        if (channel === 'vault:stat') {
          const s = await fs.stat(join(root, r));
          return { success: true, ok: true, mtimeMs: s.mtimeMs, size: s.size };
        }
        if (channel === 'board:load') return loadBoardFile(join(root, r));
        return { success: true, ok: true };
      },
      on: () => () => undefined,
      send: () => undefined,
    };

    const loaded = await loadBoard(root, rel);
    expect(loaded).toMatchObject({ ok: false, error: 'no-migration-path' });
    expect(channels).not.toContain('board:save');
    expect(await fs.readFile(abs, 'utf-8')).toBe(bytes);
  });
});
