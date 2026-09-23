/**
 * Sprint 35.4 regression — `frontmatterWriteScheduler`'s `lastFlushedVersion`
 * map is module-state. Without a vault-swap reset it accumulates entries
 * across vaults; the reset clears it via the scheduler's registered callback
 * before the next vault opens.
 *
 * M1 (2026-05-28) — the map is now keyed by `docId` (not vault-relative
 * path), so `getLastFlushedFrontmatterVersion` takes a docId. docId keying
 * already prevents the original cross-vault same-`relPath` suppression; the
 * reset remains as growth-bounding / docId-reuse hygiene.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  getLastFlushedFrontmatterVersion,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import {
  resetWriteTracking,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('frontmatterWriteScheduler — vault-swap reset (Sprint 35.4)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
  });

  it('clears lastFlushedVersion on resetWriteTracking', async () => {
    vaultStore.setPath('/vault-A');
    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter now hydrates on demand and fails loud
      // on a read error, so the docState write path needs a working read mock.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => ({ success: true }),
    });

    // Seed a document and flush a frontmatter write so lastFlushedVersion
    // gets populated for 'Notes.md'.
    documentStore.loadDocument({
      docId: 'doc-A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'hello',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'doc-A');
    const res1 = await flushAllPendingFrontmatterWrites();
    expect(res1.failed).toEqual([]);
    expect(getLastFlushedFrontmatterVersion('doc-A')).toBeGreaterThan(0);

    // Vault swap — resetWriteTracking should fire the registered callback
    // that clears lastFlushedVersion.
    resetWriteTracking('/vault-A');

    expect(getLastFlushedFrontmatterVersion('doc-A')).toBe(0);
  });

  it('after vault swap, a write to a same-named file in the new vault is not suppressed', async () => {
    // Vault A: seed + flush so 'Notes.md' has a stale version recorded.
    vaultStore.setPath('/vault-A');
    let writeCount = 0;
    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter now hydrates on demand and fails loud
      // on a read error, so the docState write path needs a working read mock.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => {
        writeCount++;
        return { success: true };
      },
    });

    documentStore.loadDocument({
      docId: 'doc-A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'vault A body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes' });
    // Bump the FM mutation version a few times so lastFlushedVersion lands
    // at something > 0.
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes', tag: 'a' });
    documentStore.setFrontmatter('doc-A', { id: 'doc-A', title: 'Notes', tag: 'b' });

    scheduleFrontmatterWrite('Notes.md', 'doc-A');
    await flushAllPendingFrontmatterWrites();
    expect(writeCount).toBe(1);
    const versionAfterA = getLastFlushedFrontmatterVersion('doc-A');
    expect(versionAfterA).toBeGreaterThan(0);

    // Vault swap.
    resetWriteTracking('/vault-A');
    vaultStore.setPath('/vault-B');

    // Vault B: a fresh document also named 'Notes.md'. Its mutation version
    // starts at 0; without the reset, the version-token guard
    // (`scheduledVersion <= last`) would suppress this write.
    documentStore.loadDocument({
      docId: 'doc-B',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'vault B body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-B', { id: 'doc-B', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'doc-B');
    await flushAllPendingFrontmatterWrites();

    // Without the vault-swap reset this would still be 1 (suppressed). After
    // the fix, the vault-B write actually lands on disk.
    expect(writeCount).toBe(2);
  });
});
