import { describe, it, expect, beforeEach } from 'vitest';
import {
  markPropertiesPopupDirty,
  clearPropertiesPopupDirty,
  isPropertiesPopupDirty,
  getDirtyInstancesForPath,
  __resetPropertiesPopupTrackerForTests,
} from '@renderer/lib/vault/propertiesPopupTracker';

describe('propertiesPopupTracker', () => {
  beforeEach(() => {
    __resetPropertiesPopupTrackerForTests();
  });

  it('isPropertiesPopupDirty starts false for unknown paths', () => {
    expect(isPropertiesPopupDirty('note.md')).toBe(false);
  });

  it('markPropertiesPopupDirty flags the path; clear drops it', () => {
    markPropertiesPopupDirty('caller-A', 'note.md');
    expect(isPropertiesPopupDirty('note.md')).toBe(true);
    clearPropertiesPopupDirty('caller-A');
    expect(isPropertiesPopupDirty('note.md')).toBe(false);
  });

  it('empty callerId or relPath are silently ignored', () => {
    markPropertiesPopupDirty('', 'note.md');
    markPropertiesPopupDirty('caller-A', '');
    expect(isPropertiesPopupDirty('note.md')).toBe(false);
    expect(getDirtyInstancesForPath('note.md')).toEqual([]);
  });

  it('two popups on the same path: clearing one keeps the other dirty (no-shared-bit semantics)', () => {
    // Split-pane scenario — same .md backing two tiles each with its own
    // popup. Pre-tracker shared-bit ref-counting would prematurely declare
    // the path clean when the first popup closed, defeating the C.1 gate
    // for the second popup's pending writes.
    markPropertiesPopupDirty('caller-A', 'note.md');
    markPropertiesPopupDirty('caller-B', 'note.md');
    expect(isPropertiesPopupDirty('note.md')).toBe(true);
    clearPropertiesPopupDirty('caller-A');
    expect(isPropertiesPopupDirty('note.md')).toBe(true);
    clearPropertiesPopupDirty('caller-B');
    expect(isPropertiesPopupDirty('note.md')).toBe(false);
  });

  it('getDirtyInstancesForPath returns every callerId pointing at the path', () => {
    markPropertiesPopupDirty('caller-A', 'note.md');
    markPropertiesPopupDirty('caller-B', 'note.md');
    markPropertiesPopupDirty('caller-C', 'other.md');
    const dirty = getDirtyInstancesForPath('note.md').sort();
    expect(dirty).toEqual(['caller-A', 'caller-B']);
    expect(getDirtyInstancesForPath('other.md')).toEqual(['caller-C']);
    expect(getDirtyInstancesForPath('missing.md')).toEqual([]);
  });

  it('re-marking the same callerId with a new path replaces (popup mid-edit rename case)', () => {
    // The popup's tile path can change mid-edit (folder rename, in-app
    // rename). The tracker should track the latest path so the classifier
    // converts the right rel into prompt-user.
    markPropertiesPopupDirty('caller-A', 'old.md');
    expect(isPropertiesPopupDirty('old.md')).toBe(true);
    markPropertiesPopupDirty('caller-A', 'new.md');
    expect(isPropertiesPopupDirty('old.md')).toBe(false);
    expect(isPropertiesPopupDirty('new.md')).toBe(true);
  });
});
