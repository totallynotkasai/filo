import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveBoardFile, BoardFolderMissingError } from '../../main/vault/boardFileOps';
import { errorEnvelope } from '../../main/ipc/ipcErrorCode';

/**
 * Only `board:create` makes folders. A save of a board whose folder is gone
 * (moved by a rename that is still running, or deleted) fails with a code the
 * renderer keeps for a retry, instead of making the folder: made early, it
 * turned the rename into a name clash and left a second copy of the board.
 */
describe('saveBoardFile and a missing folder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-board-save-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses to create the folder, and says why in a code the writer keeps', async () => {
    const target = join(dir, 'Plan', 'Plan.board.json');
    const err = await saveBoardFile(target, '{"board":{}}').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoardFolderMissingError);
    expect(existsSync(join(dir, 'Plan'))).toBe(false);
    expect(errorEnvelope(err).code).toBe('BOARD_FOLDER_MISSING');
  });

  it('writes into a folder that exists', async () => {
    await fs.mkdir(join(dir, 'Plan'));
    const target = join(dir, 'Plan', 'Plan.board.json');
    await saveBoardFile(target, '{"board":{}}');
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('{"board":{}}');
  });

  it('makes the folder again when asked to (Save at original location)', async () => {
    const target = join(dir, 'Plan', 'Plan.board.json');
    await saveBoardFile(target, '{"board":{}}', { recreate: true });
    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('{"board":{}}');
  });
});
