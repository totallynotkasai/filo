import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  recordPreservedEmergencyFile,
  listPreservedEmergencyFiles,
  __resetEmergencyFilesForTests,
} from '../../main/services/emergencyFileRegistry';
import {
  writeQuitFailureBreadcrumb,
  quitFailureRelPath,
} from '../../main/services/quitFailureBreadcrumb';

/**
 * 6.2.H4 (follow-up) — the durable quit-failure breadcrumb.
 *
 * The earlier H4 fix added the blocking "Save failed → Quit anyway / Stay"
 * confirm. This covers the missing half: when a write preserves an emergency
 * partial (ENOSPC/EIO/…), the location is recorded and the quit drain persists
 * it to `.filo/quit-failure.json` so the next launch can surface it.
 */
describe('6.2.H4 (follow-up) — emergency-file registry + quit-failure breadcrumb', () => {
  let dir: string;

  beforeEach(async () => {
    __resetEmergencyFilesForTests();
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-quitfail-'));
  });

  afterEach(async () => {
    __resetEmergencyFilesForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records preserved files and de-dupes by preservedPath', () => {
    recordPreservedEmergencyFile({ preservedPath: join(dir, 'a.md'), code: 'ENOSPC' });
    recordPreservedEmergencyFile({ preservedPath: join(dir, 'a.md'), code: 'ENOSPC' }); // dup
    recordPreservedEmergencyFile({ preservedPath: join(dir, 'b.md'), code: 'EIO' });
    const list = listPreservedEmergencyFiles();
    expect(list).toHaveLength(2);
    expect(list[0].at).toBeGreaterThan(0);
    expect(list.map((f) => f.code)).toEqual(['ENOSPC', 'EIO']);
  });

  it('ignores an empty preservedPath', () => {
    recordPreservedEmergencyFile({ preservedPath: '' });
    expect(listPreservedEmergencyFiles()).toHaveLength(0);
  });

  it('writes .filo/quit-failure.json with the preserved locations', async () => {
    const preserved = join(dir, 'Notes.md');
    recordPreservedEmergencyFile({ preservedPath: preserved, targetPath: preserved, code: 'ENOSPC' });

    await writeQuitFailureBreadcrumb(dir);

    const raw = await fs.readFile(join(dir, quitFailureRelPath()), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.savedAt).toBe('string');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].preservedPath).toBe(preserved);
    expect(parsed.files[0].code).toBe('ENOSPC');
  });

  it('no-ops when the registry is empty (no breadcrumb file created)', async () => {
    await writeQuitFailureBreadcrumb(dir);
    await expect(fs.access(join(dir, quitFailureRelPath()))).rejects.toThrow();
  });

  it('no-ops for a null vault root', async () => {
    recordPreservedEmergencyFile({ preservedPath: join(dir, 'x.md') });
    await writeQuitFailureBreadcrumb(null);
    await expect(fs.access(join(dir, quitFailureRelPath()))).rejects.toThrow();
  });

  it('filters out preserved files outside the target vault (cross-vault swap)', async () => {
    const otherVault = await fs.mkdtemp(join(tmpdir(), 'filo-other-'));
    try {
      // The only recorded partial lives in a DIFFERENT vault → nothing to
      // write for `dir` (don't leak another vault's path into this breadcrumb).
      recordPreservedEmergencyFile({ preservedPath: join(otherVault, 'Stray.md'), code: 'EIO' });
      await writeQuitFailureBreadcrumb(dir);
      await expect(fs.access(join(dir, quitFailureRelPath()))).rejects.toThrow();
    } finally {
      await fs.rm(otherVault, { recursive: true, force: true });
    }
  });
});

describe('quit-failure breadcrumb — an unacknowledged earlier breadcrumb is merged', () => {
  let dir: string;

  beforeEach(async () => {
    __resetEmergencyFilesForTests();
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-quitfail-merge-'));
    await fs.mkdir(join(dir, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    __resetEmergencyFilesForTests();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writePrior(files: Array<{ preservedPath: string; code?: string; at?: number }>): Promise<void> {
    await fs.writeFile(
      join(dir, quitFailureRelPath()),
      JSON.stringify({ version: 1, savedAt: '2026-09-01T00:00:00.000Z', files }),
    );
  }

  async function readFiles(): Promise<Array<{ preservedPath: string; code?: string; at?: number }>> {
    return JSON.parse(await fs.readFile(join(dir, quitFailureRelPath()), 'utf-8')).files;
  }

  it('keeps a prior entry whose preserved file still exists, alongside this session', async () => {
    const prior = join(dir, 'Old.md.partial');
    await fs.writeFile(prior, 'partial bytes');
    await writePrior([{ preservedPath: prior, code: 'EIO', at: 111 }]);

    recordPreservedEmergencyFile({ preservedPath: join(dir, 'New.md'), code: 'ENOSPC' });
    await writeQuitFailureBreadcrumb(dir);

    const files = await readFiles();
    expect(files.map((f) => f.preservedPath).sort()).toEqual([join(dir, 'New.md'), prior].sort());
    // The prior entry keeps its own timestamp.
    expect(files.find((f) => f.preservedPath === prior)?.at).toBe(111);
  });

  it('drops prior entries whose preserved file is gone', async () => {
    await writePrior([{ preservedPath: join(dir, 'Recovered.md.partial'), code: 'EIO', at: 1 }]);
    recordPreservedEmergencyFile({ preservedPath: join(dir, 'New.md'), code: 'ENOSPC' });
    await writeQuitFailureBreadcrumb(dir);
    expect((await readFiles()).map((f) => f.preservedPath)).toEqual([join(dir, 'New.md')]);
  });

  it('dedupes by preservedPath (this session wins)', async () => {
    const same = join(dir, 'Same.md.partial');
    await fs.writeFile(same, 'x');
    await writePrior([{ preservedPath: same, code: 'EIO', at: 1 }]);
    recordPreservedEmergencyFile({ preservedPath: same, code: 'ENOSPC' });
    await writeQuitFailureBreadcrumb(dir);
    const files = await readFiles();
    expect(files).toHaveLength(1);
    expect(files[0]?.code).toBe('ENOSPC');
  });

  it('a corrupt prior file is overwritten with this session only', async () => {
    await fs.writeFile(join(dir, quitFailureRelPath()), '{ not json');
    recordPreservedEmergencyFile({ preservedPath: join(dir, 'New.md'), code: 'ENOSPC' });
    await writeQuitFailureBreadcrumb(dir);
    expect((await readFiles()).map((f) => f.preservedPath)).toEqual([join(dir, 'New.md')]);
  });

  it('a prior entry pointing outside the vault is not carried forward', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'filo-outside-'));
    try {
      const stray = join(outside, 'x.partial');
      await fs.writeFile(stray, 'x');
      await writePrior([{ preservedPath: stray, code: 'EIO', at: 1 }]);
      recordPreservedEmergencyFile({ preservedPath: join(dir, 'New.md'), code: 'ENOSPC' });
      await writeQuitFailureBreadcrumb(dir);
      expect((await readFiles()).map((f) => f.preservedPath)).toEqual([join(dir, 'New.md')]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
