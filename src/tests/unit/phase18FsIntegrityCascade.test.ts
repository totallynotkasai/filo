import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile } from '../../main/vault/filenameUtils';
import {
  rewriteRenameInBoard,
  findTilesToCascadeDelete,
  collectFileRefs,
} from '@renderer/lib/vault/fileRefIntegrity';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Frame } from '@renderer/schema/index';
import {
  markDirty,
  markClean,
} from '@renderer/lib/vault/dirtyFlagRecovery';

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) throw new Error(`No stub for channel "${channel}"`);
      return handler(...args);
    },
    on: () => () => { /* no-op */ },
    send: () => { /* no-op */ },
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function makeFrame(id: string, backgroundImage: string): Frame {
  return {
    id,
    boardId: 'b1',
    title: 'F',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    style: { backgroundImage } as Frame['style'],
    collapsed: false,
    tileIds: [],
    createdAt: 0,
    updatedAt: 0,
  } as Frame;
}

function makeMindmapBoardWithFrames(
  frames: Frame[],
  options?: { defaultFrameBg?: string },
): BoardFileData {
  return {
    board: {
      id: 'b1',
      type: 'mindmap',
      name: 'Test',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: options?.defaultFrameBg
        ? { defaults: { frame: { backgroundImage: options.defaultFrameBg } } }
        : ({} as object),
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
    } as unknown as BoardFileData['board'],
    tileDefs: {},
    connections: {},
    frames,
  };
}

describe('Phase 18 — FS integrity & cascade', () => {
  beforeEach(() => {
    uninstallFiloStub();
  });
  afterEach(() => {
    uninstallFiloStub();
  });

  describe('H8 — atomicWriteFile crash-safety', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(join(tmpdir(), 'filo-h8-'));
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('writes and renames atomically (no .tmp residue, full content)', async () => {
      const target = join(dir, 'note.md');
      const payload = '# hello\n\nA fully-saved file.';
      await atomicWriteFile(target, payload);
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe(payload);
      const entries = await fs.readdir(dir);
      expect(entries).toEqual(['note.md']);
    });

    it('overwrites existing files with the new content fully (never truncated)', async () => {
      const target = join(dir, 'note.md');
      await fs.writeFile(target, 'old', 'utf-8');
      const big = 'X'.repeat(50_000);
      await atomicWriteFile(target, big);
      const got = await fs.readFile(target, 'utf-8');
      // Either fully the old content or fully the new content — atomic
      // writes never leave a partial.
      expect(got === big || got === 'old').toBe(true);
      expect(got).toBe(big);
    });

    it('handles a rename failure by cleaning up the .tmp file', async () => {
      // Pointing at a non-existent subdirectory makes the rename target
      // unwriteable; we still want the temp file cleaned up.
      const target = join(dir, 'missing-subdir', 'note.md');
      await expect(atomicWriteFile(target, 'x')).rejects.toBeDefined();
      const entries = await fs.readdir(dir);
      expect(entries.some((n) => n.endsWith('.tmp'))).toBe(false);
    });
  });

  describe('H11 — frame backgroundImage participates in rename / cascade / broken-ref', () => {
    it('rewriteRenameInBoard rewrites frame.style.backgroundImage on rename', () => {
      const board = makeMindmapBoardWithFrames([
        makeFrame('f1', 'attachments/hero.jpg'),
        makeFrame('f2', 'other.jpg'),
      ]);

      const n = rewriteRenameInBoard(board, 'attachments/hero.jpg', 'attachments/renamed.jpg');
      expect(n).toBe(1);
      expect(board.frames[0].style.backgroundImage).toBe('attachments/renamed.jpg');
      expect(board.frames[1].style.backgroundImage).toBe('other.jpg');
    });

    it('rewriteRenameInBoard rewrites board.settings.defaults.frame.backgroundImage', () => {
      const board = makeMindmapBoardWithFrames([], { defaultFrameBg: 'attachments/hero.jpg' });
      const n = rewriteRenameInBoard(board, 'attachments/hero.jpg', 'attachments/renamed.jpg');
      expect(n).toBe(1);
      const settings = (board.board as unknown as {
        settings: { defaults: { frame: { backgroundImage: string } } };
      }).settings;
      expect(settings.defaults.frame.backgroundImage).toBe('attachments/renamed.jpg');
    });

    it('findTilesToCascadeDelete records frameBackgroundClears but leaves the frame in place', () => {
      const board = makeMindmapBoardWithFrames([
        makeFrame('f1', 'attachments/hero.jpg'),
        makeFrame('f2', 'unrelated.jpg'),
      ]);
      const result = findTilesToCascadeDelete({ b1: board }, 'attachments/hero.jpg');
      // No tile removals — frame-bg clears are separate.
      expect(result.totalCount).toBe(0);
      expect(result.frameBackgroundClears.b1).toEqual([
        { frameId: 'f1', matchedPath: 'attachments/hero.jpg' },
      ]);
    });

    it('findTilesToCascadeDelete records boardSettingsClears for the per-board frame default', () => {
      const board = makeMindmapBoardWithFrames([], { defaultFrameBg: 'attachments/hero.jpg' });
      const result = findTilesToCascadeDelete({ b1: board }, 'attachments/hero.jpg');
      expect(result.totalCount).toBe(0);
      expect(result.boardSettingsClears.b1).toEqual([
        { path: 'defaults.frame.backgroundImage', matchedPath: 'attachments/hero.jpg' },
      ]);
    });

    it('collectFileRefs surfaces frame backgroundImage with a synthetic frame: tileId', () => {
      const board = makeMindmapBoardWithFrames([
        makeFrame('f1', 'attachments/hero.jpg'),
      ]);
      const refs = collectFileRefs(board);
      expect(refs).toContainEqual({
        tileId: 'frame:f1',
        field: 'backgroundImage',
        path: 'attachments/hero.jpg',
      });
    });

    it('cascade-delete does not flag a passthrough-leaked backgroundImage on a tile def for tile removal', () => {
      // `backgroundImage` made it into FILE_REF_FIELDS but the cascade
      // intentionally only removes tile defs whose file/src/filePath
      // match — a stray backgroundImage on a tile def (which is not the
      // real carrier) shouldn't nuke the tile.
      const board = makeMindmapBoardWithFrames([]);
      // Type assertion: backgroundImage isn't on the real TileDef shape;
      // we're testing the defensive cascade behaviour.
      (board.tileDefs as Record<string, Record<string, unknown>>).t1 = {
        id: 't1',
        type: 'image',
        backgroundImage: 'attachments/hero.jpg',
        title: 'Stray',
        style: { headerColor: '', bodyColor: '', borderColor: '' },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      };
      const result = findTilesToCascadeDelete({ b1: board }, 'attachments/hero.jpg');
      expect(result.totalCount).toBe(0);
      expect(result.byBoard).toEqual({});
    });
  });

  describe('H14 — sentinel mutex serialises markDirty/markClean', () => {
    it('markDirty(vault, [...]) followed by markClean(vault) ends with .filo/.dirty deleted', async () => {
      const calls: Array<{ channel: string; args: unknown[] }> = [];
      installFiloStub({
        'vault:write-file-text': async (...args: unknown[]) => {
          calls.push({ channel: 'vault:write-file-text', args });
          return undefined;
        },
        'vault:delete': async (...args: unknown[]) => {
          calls.push({ channel: 'vault:delete', args });
          return undefined;
        },
      });

      const dirty = markDirty('/vault', ['a.md']);
      const clean = markClean('/vault');
      await Promise.all([dirty, clean]);

      const channels = calls.map((c) => c.channel);
      // Two operations queued behind the mutex — both must run, and the
      // markClean must run AFTER the markDirty (FIFO order).
      expect(channels).toEqual([
        'vault:write-file-text',
        'vault:delete',
      ]);
    });

    it('mutex survives a thrown markClean and still runs the next op', async () => {
      let writeCount = 0;
      installFiloStub({
        'vault:delete': async () => {
          throw new Error('boom');
        },
        'vault:write-file-text': async () => {
          writeCount++;
          return undefined;
        },
      });

      // markClean throws internally but the catch swallows it. The next
      // markDirty must still run.
      const clean = markClean('/vault');
      const dirty = markDirty('/vault', ['b.md']);
      await Promise.all([clean, dirty]);

      expect(writeCount).toBe(1);
    });
  });
});
