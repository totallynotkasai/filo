import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeBoardFile, type BoardFileData } from '@renderer/lib/boards/boardSaver';
import { CURRENT_BOARD_FILE_VERSION } from '@renderer/schema';
import {
  installFiloMock,
  restoreFiloDefault,
  type InvokeHandler,
} from '../helpers/filoBridge';

describe('writeBoardFile — envelope version', () => {
  let lastSavePayload: string | null;

  const captureBoardSave: InvokeHandler = (..._args: unknown[]) => {
    lastSavePayload = String(_args[2]);
    return null;
  };

  beforeEach(() => {
    lastSavePayload = null;
    restoreFiloDefault();
  });
  afterEach(() => {
    restoreFiloDefault();
  });

  it('stamps the current envelope version on every save', async () => {
    installFiloMock({
      'board:save': captureBoardSave,
      'config:save': () => null,
    });

    const cached: BoardFileData = {
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
      } as unknown as BoardFileData['board'],
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
