/**
 * What a loaded note does when its file changes on disk: the prompt appears
 * only when an unsaved body edit meets a body change; a clean note follows
 * the disk silently; a frontmatter-only change never interrupts typing; a
 * read that caught another program mid-write is retried, not applied.
 */
import { describe, it, expect } from 'vitest';
import { decideDiskChange, type DiskChangeInput } from '@renderer/lib/notes/noteDiskChange';

const base: DiskChangeInput = {
  exists: true,
  isOwnWrite: false,
  torn: false,
  hasUnsavedBody: false,
  bodyChanged: false,
};

describe('decideDiskChange', () => {
  it('asks the user when an unsaved body edit meets a body change on disk', () => {
    expect(decideDiskChange({ ...base, hasUnsavedBody: true, bodyChanged: true })).toBe('conflict');
  });

  it('follows the disk silently when nothing is unsaved', () => {
    expect(decideDiskChange({ ...base, bodyChanged: true })).toBe('replace');
    expect(decideDiskChange(base)).toBe('replace');
  });

  it('takes a frontmatter-only change without a prompt while a body edit is unsaved', () => {
    expect(decideDiskChange({ ...base, hasUnsavedBody: true, bodyChanged: false })).toBe('take-frontmatter');
  });

  it('ignores our own write coming back, even with an edit queued', () => {
    expect(decideDiskChange({ ...base, isOwnWrite: true, hasUnsavedBody: true, bodyChanged: true })).toBe('ignore');
  });

  it('retries a read that caught another program mid-write instead of applying it', () => {
    expect(decideDiskChange({ ...base, torn: true })).toBe('retry');
    expect(decideDiskChange({ ...base, torn: true, hasUnsavedBody: true, bodyChanged: true })).toBe('retry');
  });

  it('reports a vanished file as missing, whatever else is true', () => {
    expect(decideDiskChange({ ...base, exists: false, hasUnsavedBody: true })).toBe('missing');
    expect(decideDiskChange({ ...base, exists: false, isOwnWrite: true })).toBe('missing');
  });
});
