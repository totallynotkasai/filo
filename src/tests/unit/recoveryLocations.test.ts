/**
 * The recovery modal points at the rescue copies and moved-aside partial
 * files from the unfinished session on, one row per folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { recoveryLocationsSince, recoveryStampTime } from '@renderer/lib/vault/recoveryLocations';
import { listRecoverySnapshots } from '../../main/services/recoverySnapshot';

describe('recoveryLocationsSince', () => {
  const at = (iso: string): number => Date.parse(iso);

  it('reads a recovery folder name as UTC time, with or without a suffix', () => {
    expect(recoveryStampTime('2026-09-26T10-02-11.123')).toBe(at('2026-09-26T10:02:11.123Z'));
    expect(recoveryStampTime('2026-09-26T10-02-11.123-unsaved')).toBe(at('2026-09-26T10:02:11.123Z'));
    expect(recoveryStampTime('orphan-tmp')).toBeNull();
  });

  it('keeps rescue and moved-aside folders from the unfinished save on, newest first, one row each', () => {
    const rows = recoveryLocationsSince(
      [
        { relPath: '.filo/recovery/2026-09-26T09-00-00.000-unsaved/Old.md', basename: 'Old.md', timestamp: '2026-09-26T09-00-00.000-unsaved', kind: 'unsaved' },
        { relPath: '.filo/recovery/2026-09-26T10-05-00.000-unsaved/A.md', basename: 'A.md', timestamp: '2026-09-26T10-05-00.000-unsaved', kind: 'unsaved' },
        { relPath: '.filo/recovery/2026-09-26T10-05-00.000-unsaved/B.md', basename: 'B.md', timestamp: '2026-09-26T10-05-00.000-unsaved', kind: 'unsaved' },
        { relPath: '.filo/recovery/orphan-tmp/2026-09-26T10-10-00.000/C.md.recovered', basename: 'C.md.recovered', timestamp: '2026-09-26T10-10-00.000', kind: 'orphan-tmp' },
        { relPath: '.filo/recovery/2026-09-26T10-06-00.000-keep/D.md', basename: 'D.md', timestamp: '2026-09-26T10-06-00.000-keep', kind: 'keep' },
      ],
      at('2026-09-26T10:04:30.000Z'),
    );
    expect(rows).toEqual([
      { kind: 'orphan-tmp', at: at('2026-09-26T10:10:00.000Z'), firstFile: '.filo/recovery/orphan-tmp/2026-09-26T10-10-00.000/C.md.recovered', files: 1 },
      { kind: 'unsaved', at: at('2026-09-26T10:05:00.000Z'), firstFile: '.filo/recovery/2026-09-26T10-05-00.000-unsaved/A.md', files: 2 },
    ]);
  });
});

describe('listRecoverySnapshots — what each copy is', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-recovery-kinds-'));
  });
  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('labels snapshots, rescue copies, kept versions and moved-aside partial files', async () => {
    const put = async (rel: string): Promise<void> => {
      await fs.mkdir(join(vaultRoot, '.filo', 'recovery', rel, '..'), { recursive: true });
      await fs.writeFile(join(vaultRoot, '.filo', 'recovery', rel), 'x');
    };
    await put('2026-09-26T10-00-00.000/Plan.board.json');
    await put('2026-09-26T10-01-00.000-unsaved/Note.md');
    await put('2026-09-26T10-02-00.000-keep/Note.md');
    await put('orphan-tmp/2026-09-26T10-03-00.000/Note.md.recovered');
    const list = await listRecoverySnapshots(vaultRoot);
    const byKind = Object.fromEntries(list.map((s) => [s.kind, s.relPath]));
    expect(byKind).toEqual({
      snapshot: '.filo/recovery/2026-09-26T10-00-00.000/Plan.board.json',
      unsaved: '.filo/recovery/2026-09-26T10-01-00.000-unsaved/Note.md',
      keep: '.filo/recovery/2026-09-26T10-02-00.000-keep/Note.md',
      'orphan-tmp': '.filo/recovery/orphan-tmp/2026-09-26T10-03-00.000/Note.md.recovered',
    });
  });
});
