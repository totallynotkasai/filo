/**
 * A write by a stale spelling keeps the name the file has on disk, so Filo
 * never undoes another program's case-only rename by saving the note.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withOnDiskSpelling, atomicWriteFile } from '../../main/vault/filenameUtils';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

describe('withOnDiskSpelling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-spelling-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves a missing file and an exact spelling alone', async () => {
    expect(await withOnDiskSpelling(join(dir, 'Gone.md'))).toBe(join(dir, 'Gone.md'));
    await fs.writeFile(join(dir, 'Same.md'), 'x');
    expect(await withOnDiskSpelling(join(dir, 'Same.md'))).toBe(join(dir, 'Same.md'));
  });

  it.runIf(caseInsensitive)('uses the on-disk spelling, so a write keeps a case-only rename', async () => {
    await fs.writeFile(join(dir, 'draft.md'), 'before');
    const target = await withOnDiskSpelling(join(dir, 'Draft.md'));
    expect(target).toBe(join(dir, 'draft.md'));
    await atomicWriteFile(target, 'after', { expectExisting: true });
    expect(await fs.readdir(dir)).toEqual(['draft.md']);
    expect(await fs.readFile(join(dir, 'draft.md'), 'utf-8')).toBe('after');
  });
});
