import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sweepOrphanTmpFiles, ORPHAN_MIN_AGE_MS } from '../../main/services/orphanTmpSweep';
import {
  recordPreservedEmergencyFile,
  __resetEmergencyFilesForTests,
} from '../../main/services/emergencyFileRegistry';

/**
 * Preserved atomic-write temps (`<file>.<12hex>.tmp`) accumulated forever
 * inside the synced vault. On vault open, orphans older than 10 minutes are
 * MOVED (never deleted) into `.filo/recovery/orphan-tmp/`, sparing anything a
 * quit-failure breadcrumb or this process's emergency registry still points at.
 */
describe('sweepOrphanTmpFiles', () => {
  let vault: string;
  const now = Date.now();
  const old = new Date(now - ORPHAN_MIN_AGE_MS - 60_000);

  async function touch(rel: string, content: string, mtime?: Date): Promise<string> {
    const abs = join(vault, ...rel.split('/'));
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, content);
    if (mtime) await fs.utimes(abs, mtime, mtime);
    return abs;
  }

  beforeEach(async () => {
    vault = await fs.mkdtemp(join(tmpdir(), 'filo-orphan-'));
    __resetEmergencyFilesForTests();
  });
  afterEach(async () => {
    __resetEmergencyFilesForTests();
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('moves an old nonce tmp into .filo/recovery/orphan-tmp and keeps its bytes', async () => {
    await touch('Notes/Plan.md.0123456789ab.tmp', 'lost edit', old);
    const { moved } = await sweepOrphanTmpFiles(vault, { now });
    expect(moved).toHaveLength(1);
    expect(moved[0].from).toBe('Notes/Plan.md.0123456789ab.tmp');
    expect(moved[0].to).toMatch(/^\.filo\/recovery\/orphan-tmp\/[^/]+\/Notes__Plan\.md\.recovered$/);
    await expect(fs.readFile(join(vault, ...moved[0].to.split('/')), 'utf-8')).resolves.toBe('lost edit');
    await expect(fs.access(join(vault, 'Notes', 'Plan.md.0123456789ab.tmp'))).rejects.toBeDefined();
  });

  it('keeps a young tmp (another process / machine may be mid-write)', async () => {
    await touch('A.md.aaaaaaaaaaaa.tmp', 'x', new Date(now - 60_000));
    const { moved } = await sweepOrphanTmpFiles(vault, { now });
    expect(moved).toEqual([]);
  });

  it('keeps a tmp listed by a quit-failure breadcrumb (any machine)', async () => {
    const abs = await touch('B.md.bbbbbbbbbbbb.tmp', 'x', old);
    await touch('.filo/quit-failure.0123456789ab.json', JSON.stringify({ files: [{ preservedPath: abs }] }));
    const { moved } = await sweepOrphanTmpFiles(vault, { now });
    expect(moved).toEqual([]);
  });

  it('keeps a tmp this process still tracks as a preserved emergency file', async () => {
    const abs = await touch('C.md.cccccccccccc.tmp', 'x', old);
    recordPreservedEmergencyFile({ preservedPath: abs, targetPath: join(vault, 'C.md'), code: 'EPERM' });
    const { moved } = await sweepOrphanTmpFiles(vault, { now });
    expect(moved).toEqual([]);
  });

  it('keeps a user file named notes.tmp (no nonce) and ignores .filo / .git', async () => {
    await touch('notes.tmp', 'mine', old);
    await touch('.git/x.md.dddddddddddd.tmp', 'git', old);
    await touch('.filo/y.md.eeeeeeeeeeee.tmp', 'filo', old);
    const { moved } = await sweepOrphanTmpFiles(vault, { now });
    expect(moved).toEqual([]);
    await expect(fs.readFile(join(vault, 'notes.tmp'), 'utf-8')).resolves.toBe('mine');
  });

  it('moves a stranded case-rename temp', async () => {
    await touch('Note.md.case-rename-1790000000000', 'x', old);
    const { moved } = await sweepOrphanTmpFiles(vault, { now });
    expect(moved.map((m) => m.from)).toEqual(['Note.md.case-rename-1790000000000']);
  });
});
