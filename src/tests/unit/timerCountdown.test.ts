import { describe, it, expect } from 'vitest';
import { timerRemainingAt, startTimerPatch, stopTimerPatch } from '@renderer/lib/utils/timerCountdown';
import { mindmapTileOps } from '@renderer/core/boardTileOps/mindmap';
import { buildInlineTileFromTile } from '@renderer/lib/boards/tileDefBuilder';
import { InlineTileSchema } from '@renderer/schema/index';
import type { CacheContext, BoardFileData } from '@renderer/stores/boardCacheTypes';
import type { MindMapBoard, Tile, InlineTile } from '@renderer/schema/index';

/**
 * A running countdown is stored as a wall-clock end time, so it keeps
 * counting while its board is closed and nothing rewrites the board while it
 * runs (D18).
 */
describe('timer countdown', () => {
  it('a running countdown counts down from its end time, however long nothing looked', () => {
    const timer = { remaining: 300_000, isRunning: true, endsAt: 1_000_000 };
    expect(timerRemainingAt(timer, 700_000)).toBe(300_000);
    expect(timerRemainingAt(timer, 900_000)).toBe(100_000);
    expect(timerRemainingAt(timer, 2_000_000)).toBe(0);
  });

  it('a stopped countdown, or one saved without an end time, keeps its remaining time', () => {
    expect(timerRemainingAt({ remaining: 5_000, isRunning: false }, 9e12)).toBe(5_000);
    expect(timerRemainingAt({ remaining: 5_000, isRunning: true }, 9e12)).toBe(5_000);
    expect(timerRemainingAt({ remaining: 5_000, isRunning: false, endsAt: 1 }, 9e12)).toBe(5_000);
  });

  it('start stamps the end time; stop keeps the time left and clears it', () => {
    const started = startTimerPatch(60_000, 10_000);
    expect(started).toEqual({ isRunning: true, endsAt: 70_000 });
    const stopped = stopTimerPatch({ remaining: 60_000, ...started }, 40_000);
    expect(stopped).toEqual({ remaining: 30_000, isRunning: false, endsAt: undefined });
  });
});

describe('a timer tile on a Mind Map board', () => {
  function inlineTimer(): InlineTile {
    return {
      id: 't1', type: 'timer', title: '', tags: [], x: 0, y: 0, width: 240, height: 160,
      locked: false, faded: false, createdAt: 0, updatedAt: 0,
      duration: 300_000, remaining: 300_000, mode: 'hms', isRunning: false,
    };
  }

  function fixture(): { cached: BoardFileData; ctx: CacheContext } {
    const board = {
      id: 'mm', type: 'mindmap', name: 'M', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: {}, inlineTiles: { t1: inlineTimer() }, waypoints: [],
    } as unknown as MindMapBoard;
    const cached: BoardFileData = { board, tileDefs: {}, connections: {}, frames: [] };
    const ctx = { markDirty: () => {} } as unknown as CacheContext;
    return { cached, ctx };
  }

  it('saves the end time on start and drops it on stop', () => {
    const { cached, ctx } = fixture();
    const inline = (): Record<string, unknown> => (cached.board as MindMapBoard).inlineTiles.t1 as Record<string, unknown>;

    mindmapTileOps.updateTile(ctx, cached, 'mm', 't1', startTimerPatch(300_000, 1_000) as Partial<Tile>);
    expect(inline().endsAt).toBe(301_000);
    expect(inline().isRunning).toBe(true);
    expect(InlineTileSchema.safeParse(inline()).success).toBe(true);

    mindmapTileOps.updateTile(ctx, cached, 'mm', 't1', stopTimerPatch({ remaining: 300_000, isRunning: true, endsAt: 301_000 }, 101_000) as Partial<Tile>);
    expect(inline().remaining).toBe(200_000);
    expect(inline().isRunning).toBe(false);
    // Written as JSON, a stopped timer carries no end time.
    expect(JSON.parse(JSON.stringify(inline()))).not.toHaveProperty('endsAt');
  });

  it('the tile read back from the board keeps its end time', () => {
    const { cached } = fixture();
    (cached.board as MindMapBoard).inlineTiles.t1 = { ...inlineTimer(), isRunning: true, endsAt: 5_000 };
    const tile = mindmapTileOps.getFullTiles(cached, 'mm').t1;
    expect(tile).toMatchObject({ isRunning: true, endsAt: 5_000 });
    expect(buildInlineTileFromTile(tile as Tile)).toMatchObject({ endsAt: 5_000 });
  });
});
