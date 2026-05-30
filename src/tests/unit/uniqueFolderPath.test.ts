import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { uniqueFolderPath } from '../../main/vault/filenameUtils';

describe('uniqueFolderPath', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-folder-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the base name when the directory is empty', async () => {
    const result = await uniqueFolderPath(dir, 'New Folder');
    expect(result).toBe(join(dir, 'New Folder'));
  });

  it('appends (2) on a single collision', async () => {
    await fs.mkdir(join(dir, 'New Folder'));
    const result = await uniqueFolderPath(dir, 'New Folder');
    expect(result).toBe(join(dir, 'New Folder (2)'));
  });

  it('keeps incrementing past existing suffixes', async () => {
    await fs.mkdir(join(dir, 'New Folder'));
    await fs.mkdir(join(dir, 'New Folder (2)'));
    await fs.mkdir(join(dir, 'New Folder (3)'));
    const result = await uniqueFolderPath(dir, 'New Folder');
    expect(result).toBe(join(dir, 'New Folder (4)'));
  });

  it('sanitises illegal filename characters before checking', async () => {
    const result = await uniqueFolderPath(dir, 'Bad/Name?');
    expect(result).toBe(join(dir, 'BadName'));
  });
});
