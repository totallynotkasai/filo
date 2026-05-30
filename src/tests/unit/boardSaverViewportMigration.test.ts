import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeBoardFile,
  seedViewportsCache,
  clearViewportsCache,
  getViewportFromCache,
  type V7BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { CURRENT_BOARD_FILE_VERSION } from '@renderer/schema';
import {
  installFiloMock,
  restoreFiloDefault,
  type InvokeHandler,
} from '../helpers/filoBridge';

/**
 * Phase 5.4 — viewport snapshot on legacy migration.
 *
 * Writing a V6-shaped mind-map board (one whose `.board.json` still
 * carries an inline `viewport`) strips the field on save, which is the
 * V7 contract — viewports live in `.filo/viewports.json`. Without
 * preservation that would silently drop the user's last camera position.
 * The strip path now seeds `viewportCache` (which schedules a debounced
 * write to viewports.json) before deleting the field, so the value
 * survives the upgrade.
 */
describe('writeBoardFile — legacy viewport snapshot', () => {
  let lastSavePayload: string | null;

  const captureBoardSave: InvokeHandler = (..._args: unknown[]) => {
    lastSavePayload = String(_args[2]);
    return null;
  };

  beforeEach(() => {
    lastSavePayload = null;
    restoreFiloDefault();
    clearViewportsCache();
  });
  afterEach(() => {
    restoreFiloDefault();
    clearViewportsCache();
  });

  function legacyMindMap(boardId: string, viewport: { x: number; y: number; scale: number }): V7BoardFileData {
    return {
      board: {
        id: boardId,
        type: 'mindmap',
        name: 'M',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        placements: {},
        inlineTiles: {},
        connections: [],
        frames: [],
        waypoints: [],
        groups: [],
        // V6 inline viewport — stripped on write, but the value should be
        // preserved into the V7 viewports cache before the strip.
        viewport,
      } as unknown as V7BoardFileData['board'],
      tileDefs: {},
      connections: {},
      frames: [],
    };
  }

  it('captures the inline viewport into viewportCache before stripping it on write', async () => {
    installFiloMock({
      'board:save': captureBoardSave,
      // miscWriteScheduler schedules a debounced config:save for viewports.json;
      // stub it so the test isn't sensitive to the scheduler's timer.
      'config:save': () => null,
    });

    seedViewportsCache('/vault', {});
    expect(getViewportFromCache('mm-legacy')).toBeNull();

    const cached = legacyMindMap('mm-legacy', { x: 42, y: -100, scale: 1.5 });
    await writeBoardFile('/vault', 'mm.board.json', cached);

    // Saved payload no longer contains the inline viewport — V7 contract.
    expect(lastSavePayload).not.toBeNull();
    const out = JSON.parse(lastSavePayload!);
    expect('viewport' in out.board).toBe(false);

    // But the cache now holds the legacy value so the next vault open can
    // restore it from `.filo/viewports.json`.
    const restored = getViewportFromCache('mm-legacy');
    expect(restored).not.toBeNull();
    expect(restored?.x).toBe(42);
    expect(restored?.y).toBe(-100);
    expect(restored?.scale).toBe(1.5);
  });

  it('does not clobber an existing V7 viewport with a stale legacy value', async () => {
    installFiloMock({
      'board:save': captureBoardSave,
      'config:save': () => null,
    });

    // V7 viewport already in the cache — should win.
    seedViewportsCache('/vault', { 'mm-x': { x: 999, y: 999, scale: 2 } });

    const cached = legacyMindMap('mm-x', { x: 1, y: 1, scale: 1 });
    await writeBoardFile('/vault', 'mm.board.json', cached);

    const kept = getViewportFromCache('mm-x');
    expect(kept).not.toBeNull();
    expect(kept?.x).toBe(999);
    expect(kept?.y).toBe(999);
    expect(kept?.scale).toBe(2);
  });

  it('ignores malformed legacy viewports (non-finite numbers) without throwing', async () => {
    installFiloMock({
      'board:save': captureBoardSave,
      'config:save': () => null,
    });

    seedViewportsCache('/vault', {});
    const cached = legacyMindMap('mm-bad', { x: Number.NaN, y: 0, scale: 1 });
    await expect(writeBoardFile('/vault', 'mm.board.json', cached)).resolves.toBeUndefined();
    expect(getViewportFromCache('mm-bad')).toBeNull();
  });

  it('stamps the current envelope version on every save', async () => {
    installFiloMock({
      'board:save': captureBoardSave,
      'config:save': () => null,
    });

    const cached: V7BoardFileData = {
      board: {
        id: 'v-stamp',
        type: 'mindmap',
        name: 'M',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        placements: {},
        inlineTiles: {},
        connections: [],
        frames: [],
        waypoints: [],
        groups: [],
      } as unknown as V7BoardFileData['board'],
      tileDefs: {},
      connections: {},
      frames: [],
    };

    await writeBoardFile('/vault', 'v.board.json', cached);
    expect(lastSavePayload).not.toBeNull();
    const out = JSON.parse(lastSavePayload!);
    expect(out.version).toBe(CURRENT_BOARD_FILE_VERSION);
  });
});
