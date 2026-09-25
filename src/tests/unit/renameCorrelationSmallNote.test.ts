/**
 * The cross-basename pass pairs a renamed note under 256 bytes when its whole
 * content hash matches, so a typical small note renamed in Explorer is
 * followed instead of arriving as a delete plus a create. Size alone still
 * never pairs a small file, and empty files never pair.
 */
import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

function ev(filename: string): FileChangeEvent {
  return { type: 'document', filename, eventType: 'rename' };
}

const exists = (rel: string): boolean => rel === 'Moved.md';

describe('correlateRenames — small notes across basenames', () => {
  it('pairs a small note whose content hash matches', async () => {
    const { renames, filtered } = await correlateRenames(
      [ev('Draft.md'), ev('Moved.md')],
      exists,
      () => 12,
      () => 'aaaa',
      false,
    );
    expect(renames).toEqual([{ oldPath: 'Draft.md', newPath: 'Moved.md' }]);
    expect(filtered).toEqual([]);
  });

  it('does not pair a small note whose hash differs or is unknown', async () => {
    const differ = await correlateRenames([ev('Draft.md'), ev('Moved.md')], exists, () => 12, (r) => (r === 'Draft.md' ? 'aaaa' : 'bbbb'), false);
    expect(differ.renames).toEqual([]);
    const unknown = await correlateRenames([ev('Draft.md'), ev('Moved.md')], exists, () => 12, (r) => (r === 'Draft.md' ? null : 'bbbb'), false);
    expect(unknown.renames).toEqual([]);
  });

  it('does not pair a small note on size alone (no hash probe)', async () => {
    const { renames } = await correlateRenames([ev('Draft.md'), ev('Moved.md')], exists, () => 12, undefined, false);
    expect(renames).toEqual([]);
  });

  it('never pairs two empty files', async () => {
    const { renames } = await correlateRenames(
      [ev('Draft.md'), ev('Moved.md')],
      exists,
      () => 0,
      () => 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      false,
    );
    expect(renames).toEqual([]);
  });
});
