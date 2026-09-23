import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveBoardFile, loadBoardFile, createBoardFile } from '../../main/vault/boardFileOps';
import { writtenByteLength } from '@renderer/lib/boards/boardWriteDebounce';
import { loadBoard } from '@renderer/lib/boards/boardLoader';
import { writeBoardFile, setBoardExternalEditHandler } from '@renderer/lib/boards/boardWriteScheduler';
import { getBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
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

function board(name = 'Alpha'): V7BoardFileData {
  const now = 1_700_000_000_000;
  return {
    version: 7,
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
    } as V7BoardFileData['board'],
    tileDefs: {},
    connections: {},
    frames: [],
  } as V7BoardFileData;
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

  it('(b) a legacy double-encoded file still loads as an object', async () => {
    const data = board();
    const p = join(root, 'Legacy.board.json');
    await fs.writeFile(p, JSON.stringify(JSON.stringify(data, null, 2), null, 2), 'utf-8');
    expect(await loadBoardFile(p)).toEqual(data);
  });

  it('(c) a hand-written plain-JSON board loads', async () => {
    const data = board();
    const p = join(root, 'Plain.board.json');
    await fs.writeFile(p, JSON.stringify(data), 'utf-8');
    expect(await loadBoardFile(p)).toEqual(data);
  });

  it('(d) createBoardFile writes plain JSON and keeps the (2) collision', async () => {
    const fd = board('X');
    const first = await createBoardFile(root, 'X', JSON.stringify(fd, null, 2));
    const second = await createBoardFile(root, 'X', JSON.stringify(fd, null, 2));
    expect(second).toContain('X (2).board.json');
    for (const p of [first, second]) {
      expect(typeof JSON.parse(await fs.readFile(p, 'utf-8'))).toBe('object');
    }
  });

  it('refuses a string payload that is not a JSON object', async () => {
    await expect(saveBoardFile(join(root, 'Bad.board.json'), '"oops"')).rejects.toThrow(/not a JSON object/);
  });

  it('(e) renderer load → save → save on a legacy board: no external-edit prompt, baseline tracks disk', async () => {
    const rel = 'Legacy.board.json';
    const abs = join(root, rel);
    await fs.writeFile(abs, JSON.stringify(JSON.stringify(board(), null, 2), null, 2), 'utf-8');

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

    // Save #1 — the migration. mtime resolution can be coarse; nudge time.
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
    const final = JSON.parse(await fs.readFile(abs, 'utf-8')) as V7BoardFileData;
    expect(final.board.name).toBe('Edit 3');
  });
});
