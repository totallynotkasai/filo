/**
 * M1 (2026-05-28) — the frontmatter scheduler's version-token guard is keyed
 * by `docId`, not `relPath`. The mutation versions come from a per-docId
 * counter; keying the last-flushed map by relPath meant that when two docs
 * transiently alias one relPath (the rename-in-flight window), the
 * higher-versioned doc's flush could suppress the other doc's lower-versioned
 * — but newer-for-that-doc — write via `scheduledVersion <= last`, silently
 * dropping the edit.
 *
 * This test drives two docId streams against a single relPath and asserts
 * both writes land. With the pre-M1 relPath keying the second write would be
 * suppressed (writeCount would stay 1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  getLastFlushedFrontmatterVersion,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('frontmatterWriteScheduler — docId-keyed version guard (M1)', () => {
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

  it('does not let a high-version doc suppress a low-version doc that aliases the same relPath', async () => {
    let writeCount = 0;
    installFiloMock({
      'vault:file-exists': () => true,
      'vault:read-file-text': () => ({ success: true, content: '', mtimeMs: 1 }),
      'vault:write-existing-file-text': () => {
        writeCount++;
        return { success: true };
      },
    });

    // doc-A — bump its frontmatter several times so its mutation version
    // climbs well above 1, then flush it. lastFlushed[doc-A] lands high.
    documentStore.loadDocument({
      docId: 'doc-A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'A body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes', tag: 'a1' });
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes', tag: 'a2' });
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes', tag: 'a3' });

    scheduleFrontmatterWrite('Notes.md', 'doc-A');
    await flushAllPendingFrontmatterWrites();
    expect(writeCount).toBe(1);
    const versionA = getLastFlushedFrontmatterVersion('doc-A');
    expect(versionA).toBeGreaterThan(1);

    // doc-B — a *different* doc that, mid-rename, points at the same relPath.
    // Its mutation counter starts fresh (version 1 after one setFrontmatter),
    // which is BELOW doc-A's recorded last-flushed version.
    documentStore.loadDocument({
      docId: 'doc-B',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'B body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-B', { id: 'doc-B', title: 'Notes', tag: 'b1' });

    scheduleFrontmatterWrite('Notes.md', 'doc-B');
    await flushAllPendingFrontmatterWrites();

    // docId keying gives doc-B its own version space, so its write is NOT
    // suppressed by doc-A's higher recorded version. Pre-M1 (relPath keying)
    // this would stay at 1.
    expect(writeCount).toBe(2);
    expect(getLastFlushedFrontmatterVersion('doc-B')).toBeGreaterThan(0);
  });

  // 6.4.L2 — a docId-null (orphan) write for a relPath that ALSO has an open
  // editor must use the editor's LIVE frontmatter, not the body-stripped,
  // possibly-stale vaultIndex copy. The scheduler coalesces by relPath, so a
  // null schedule can fire over a docId-backed one; with the version guard
  // inert for null docIds, the stale index FM used to clobber the editor's.
  it('a docId-null write adopts an open editor and writes its live frontmatter', async () => {
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
      docId: 'doc-A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'live body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-A', { status: 'live' });

    // A stale copy of the same file in the search index — the pre-fix FM source
    // for a docId-null write.
    vaultIndexStore.restoreMetadata(
      'Notes.md',
      parseMarkdown('Notes.md', '---\nstatus: stale\n---\nbody'),
    );

    // Orphan (docId-null) frontmatter write scheduled for the SAME relPath.
    scheduleFrontmatterWrite('Notes.md', null);
    await flushAllPendingFrontmatterWrites();

    // L2 — the write carries the editor's live FM, not the stale index FM.
    expect(writtenContent).toContain('status: live');
    expect(writtenContent).not.toContain('status: stale');
  });
});
