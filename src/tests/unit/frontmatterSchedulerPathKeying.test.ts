/**
 * The frontmatter scheduler's version-token guard is keyed by the note's
 * case-folded path, the same key as the document store's mutation counter.
 * The recorded last-flushed version must be found under any spelling of the
 * path and must move with the note on a rename: left behind, a renamed note's
 * stale re-schedule would re-write old bytes, and a fresh key would compare a
 * carried-over mutation version against nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  getLastFlushedFrontmatterVersion,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('frontmatterWriteScheduler — path-keyed version guard', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    documentStore.clear();
    restoreFiloDefault();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    documentStore.clear();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('records the flushed version under any spelling and carries it across a rename', async () => {
    let writeCount = 0;
    installFiloMock({
      'vault:file-exists': () => true,
      'vault:read-file-text': () => ({ success: true, content: '', mtimeMs: 1 }),
      'vault:write-existing-file-text': () => {
        writeCount++;
        return { success: true };
      },
    });

    // Bump the note's frontmatter several times so its mutation version climbs
    // well above 1, then flush it.
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'A body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { title: 'Notes', tag: 'a1' });
    documentStore.setFrontmatter('Notes.md', { title: 'Notes', tag: 'a2' });
    documentStore.setFrontmatter('Notes.md', { title: 'Notes', tag: 'a3' });

    scheduleFrontmatterWrite('Notes.md', 'Notes.md');
    await flushAllPendingFrontmatterWrites();
    expect(writeCount).toBe(1);
    const flushed = getLastFlushedFrontmatterVersion('Notes.md');
    expect(flushed).toBeGreaterThan(1);
    expect(getLastFlushedFrontmatterVersion('notes.MD')).toBe(flushed);

    renameAllPathKeys('Notes.md', 'Sub/Notes.md');
    expect(getLastFlushedFrontmatterVersion('Sub/Notes.md')).toBe(flushed);
    expect(getLastFlushedFrontmatterVersion('Notes.md')).toBe(0);

    // A re-schedule with no new mutation is already on disk: the guard, now
    // under the new path, suppresses it.
    scheduleFrontmatterWrite('Sub/Notes.md', 'Sub/Notes.md');
    await flushAllPendingFrontmatterWrites();
    expect(writeCount).toBe(1);

    // A real edit after the rename is newer than the carried version and lands.
    documentStore.setFrontmatter('Sub/Notes.md', { title: 'Notes', tag: 'b1' });
    scheduleFrontmatterWrite('Sub/Notes.md', 'Sub/Notes.md');
    await flushAllPendingFrontmatterWrites();
    expect(writeCount).toBe(2);
    expect(getLastFlushedFrontmatterVersion('Sub/Notes.md')).toBeGreaterThan(flushed);
  });

  // 6.4.L2 — a null-path (orphan) write for a relPath that ALSO has an open
  // editor must use the editor's LIVE frontmatter, not the body-stripped,
  // possibly-stale vaultIndex copy. The scheduler coalesces by relPath, so a
  // null schedule can fire over a cache-backed one; with the version guard
  // inert for a null path, the stale index FM would clobber the editor's.
  it('a null-path write adopts an open editor and writes its live frontmatter', async () => {
    let writtenContent = '';
    installFiloMock({
      'vault:file-exists': () => true,
      'vault:read-file-text': () => ({
        success: true,
        content: '---\nstatus: stale\n---\nbody',
        mtimeMs: 1,
        size: 10,
      }),
      'vault:stat': () => ({ success: true, mtimeMs: 1, size: 10 }),
      'vault:write-existing-file-text': (_root: unknown, _path: unknown, content: unknown) => {
        writtenContent = String(content);
        return { success: true };
      },
    });

    // Open editor for Notes.md with live frontmatter.
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'live body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { status: 'live' });

    // A stale copy of the same file in the search index — the FM source a
    // null-path write would otherwise fall back to.
    vaultIndexStore.restoreMetadata(
      'Notes.md',
      parseMarkdown('Notes.md', '---\nstatus: stale\n---\nbody'),
    );

    // Orphan (null-path) frontmatter write scheduled for the SAME relPath.
    scheduleFrontmatterWrite('Notes.md', null);
    await flushAllPendingFrontmatterWrites();

    // L2 — the write carries the editor's live FM, not the stale index FM.
    expect(writtenContent).toContain('status: live');
    expect(writtenContent).not.toContain('status: stale');
  });
});
