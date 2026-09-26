/**
 * Failed marks tell the truth: one whose owner already reported it with
 * nothing left to retry doesn't hold save or close hostage, and every mark
 * follows a rename instead of staying on a path that no longer exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  beginWrite,
  endWrite,
  markPathFailed,
  markPathReported,
  reportedFailedPaths,
  unsavedWork,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';

describe('write marks: reported failures and renames', () => {
  beforeEach(() => __resetDirtyTrackingForTests());
  afterEach(() => __resetDirtyTrackingForTests());

  it('a reported failure is listed but is not unsaved work', () => {
    markPathFailed(undefined, 'Tagged.md');
    expect(unsavedWork().failed).toEqual(['tagged.md']);
    markPathReported(undefined, 'Tagged.md');
    expect(unsavedWork().failed).toEqual([]);
    expect(reportedFailedPaths()).toEqual(['tagged.md']);
  });

  it('a later successful write clears the reported failure', () => {
    markPathReported(undefined, 'Tagged.md');
    beginWrite(undefined, 'Tagged.md');
    endWrite(undefined, 'Tagged.md', true);
    expect(reportedFailedPaths()).toEqual([]);
  });

  it('failed and pending marks follow a file rename', () => {
    markPathFailed(undefined, 'Old.md');
    beginWrite(undefined, 'Other.md');
    renameAllPathKeys('Old.md', 'New.md');
    renameAllPathKeys('Other.md', 'Moved/Other.md');
    const work = unsavedWork();
    expect(work.failed).toEqual(['new.md']);
    expect(work.pending).toEqual(['moved/other.md']);
    endWrite(undefined, 'Moved/Other.md', true);
    expect(unsavedWork().pending).toEqual([]);
  });

  it('marks under a renamed folder move with it', () => {
    markPathFailed(undefined, 'Notes/A.md');
    markPathReported(undefined, 'Notes/Sub/B.md');
    renameAllPathKeys('Notes', 'Archive');
    expect(unsavedWork().failed).toEqual(['archive/a.md']);
    expect(reportedFailedPaths()).toEqual(['archive/sub/b.md']);
  });
});
