import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

/**
 * Audit-19 EXT-2 — OneDrive resolves a conflict by RENAMING the local file to
 * `Note-<DEVICE>.md` (identical bytes) and downloading the other version as
 * `Note.md`. When the download lands after the watcher batch closes, the batch
 * holds a missing `Note.md` + a present `Note-DESKTOP-….md` with the same size
 * and hash, and the cross-basename pass paired them: every tile, editor and tag
 * was rebound to the LOSING copy. That exact shape is now refused and reported.
 */

function ev(filename: string, type: FileChangeEvent['type'] = 'document'): FileChangeEvent {
  return { type, filename, eventType: 'rename' };
}

const SIZE = 4096;
const present = (...paths: string[]) => (rel: string): boolean => paths.includes(rel);
const sameSize = (): number => SIZE;
const sameHash = (): string => 'abc123';

async function correlate(missing: string, pres: string, knownHosts: string[] = []) {
  return correlateRenames([ev(missing), ev(pres)], present(pres), sameSize, sameHash, true, knownHosts);
}

describe('correlateRenames — sync conflict copies are never correlated (Audit-19 EXT-2)', () => {
  it('missing Note.md + present Note-DESKTOP-1A2B3C4.md (same bytes) → no rename, one conflict (bite)', async () => {
    const res = await correlate('Note.md', 'Note-DESKTOP-1A2B3C4.md');
    expect(res.renames).toEqual([]);
    expect(res.conflicts).toEqual([
      { copyPath: 'Note-DESKTOP-1A2B3C4.md', canonicalPath: 'Note.md', client: 'onedrive' },
    ]);
    // Both events flow on as delete + create.
    expect(res.filtered.map((e) => e.filename).sort()).toEqual(['Note-DESKTOP-1A2B3C4.md', 'Note.md']);
  });

  it('a known custom host name is recognised too', async () => {
    const res = await correlate('Notes/Plan.md', 'Notes/Plan-JOHNS-SURFACE.md', ['JOHNS-SURFACE']);
    expect(res.renames).toEqual([]);
    expect(res.conflicts).toHaveLength(1);
  });

  it('a Dropbox conflicted copy of the missing file → refused', async () => {
    const res = await correlate('Note.md', "Note (Andrew's conflicted copy 2026-09-23).md");
    expect(res.renames).toEqual([]);
    expect(res.conflicts[0]).toMatchObject({ client: 'dropbox', canonicalPath: 'Note.md' });
  });

  it('a weak "Note (1).md" whose canonical IS the missing path → refused', async () => {
    const res = await correlate('Note.md', 'Note (1).md');
    expect(res.renames).toEqual([]);
    expect(res.conflicts[0]).toMatchObject({ client: 'gdrive' });
  });

  it('negative: missing Draft.md + present "Final (1).md" (canonical is not the missing path) → still a rename', async () => {
    const res = await correlate('Draft.md', 'Final (1).md');
    expect(res.renames).toEqual([{ oldPath: 'Draft.md', newPath: 'Final (1).md' }]);
    expect(res.conflicts).toEqual([]);
  });

  it('negative: Meeting.md → Meeting-Notes.md (no host match) → still a rename', async () => {
    const res = await correlate('Meeting.md', 'Meeting-Notes.md');
    expect(res.renames).toEqual([{ oldPath: 'Meeting.md', newPath: 'Meeting-Notes.md' }]);
  });

  it('a case-only rename is unaffected', async () => {
    const res = await correlateRenames(
      [ev('Notes.md'), ev('notes.md')],
      (p) => p.toLowerCase() === 'notes.md',
      sameSize,
      sameHash,
      true,
      [],
    );
    expect(res.renames).toEqual([{ oldPath: 'Notes.md', newPath: 'notes.md' }]);
    expect(res.conflicts).toEqual([]);
  });
});
