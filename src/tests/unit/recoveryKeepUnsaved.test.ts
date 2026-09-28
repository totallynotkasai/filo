import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  keepUnsavedCopies,
  snapshotForRecovery,
  listRecoverySnapshots,
  __setSnapshotCapsForTests,
} from '../../main/services/recoverySnapshot';

/**
 * Rescue copies for "Close anyway" / "Quit anyway": the text the renderer
 * holds lands in `.filo/recovery/<ts>-unsaved/`, and the snapshot prunes
 * never remove it (it exists nowhere else).
 */
describe('keepUnsavedCopies', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-rescue-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes each text under one -unsaved folder, named by its flattened path', async () => {
    const result = await keepUnsavedCopies(vaultRoot, [
      { relPath: 'Notes/A.md', text: '---\ntitle: A\n---\nunsaved\n' },
      { relPath: 'Plan.board.json', text: '{"version":8}\n' },
    ]);
    expect(result.dir).toMatch(/^\.filo\/recovery\/.+-unsaved$/);
    expect(result.kept).toEqual(['Notes/A.md', 'Plan.board.json']);
    expect(result.failed).toEqual([]);
    const dirAbs = join(vaultRoot, ...result.dir.split('/'));
    expect(await fs.readFile(join(dirAbs, 'Notes__A.md'), 'utf-8')).toBe('---\ntitle: A\n---\nunsaved\n');
    expect(await fs.readFile(join(dirAbs, 'Plan.board.json'), 'utf-8')).toBe('{"version":8}\n');
    // Nothing is written at the note's own path.
    await expect(fs.stat(join(vaultRoot, 'Notes', 'A.md'))).rejects.toThrow();
  });

  it('two paths that flatten alike both keep a copy', async () => {
    const result = await keepUnsavedCopies(vaultRoot, [
      { relPath: 'a/b.md', text: 'one' },
      { relPath: 'a__b.md', text: 'two' },
    ]);
    expect(result.kept).toHaveLength(2);
    const files = await fs.readdir(join(vaultRoot, ...result.dir.split('/')));
    expect(files.sort()).toEqual(['2 - a__b.md', 'a__b.md']);
  });

  it('the vault-open listing shows the copies', async () => {
    await keepUnsavedCopies(vaultRoot, [{ relPath: 'A.md', text: 'x' }]);
    const listed = await listRecoverySnapshots(vaultRoot);
    expect(listed.map((e) => e.basename)).toEqual(['A.md']);
  });

  it('the per-file snapshot prune leaves rescue copies alone', async () => {
    await keepUnsavedCopies(vaultRoot, [{ relPath: 'A.md', text: 'rescued' }]);
    await fs.writeFile(join(vaultRoot, 'A.md'), 'on disk', 'utf-8');
    // Past the per-name cap: the prune removes the oldest snapshots only.
    __setSnapshotCapsForTests({ perBasename: 3, total: 100 });
    try {
      for (let i = 0; i < 5; i++) {
        await snapshotForRecovery(vaultRoot, 'A.md');
        await new Promise((r) => setTimeout(r, 2));
      }
    } finally {
      __setSnapshotCapsForTests(null);
    }
    const listed = await listRecoverySnapshots(vaultRoot);
    const rescue = listed.filter((e) => e.timestamp.endsWith('-unsaved'));
    expect(rescue).toHaveLength(1);
    expect(await fs.readFile(join(vaultRoot, ...rescue[0].relPath.split('/')), 'utf-8')).toBe('rescued');
  });
});
