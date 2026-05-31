import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';

/**
 * Audit 2.3 — `isDirty` is shared by every writer on a docId (a TextTile and a
 * DocumentEditor can be open on the same file). Before per-writer tracking,
 * one writer's `markClean` cleared the flag even while the sibling still held
 * unsaved content, letting the sibling's reload `$effect` reload from a stale
 * body. These tests pin the per-writer contract.
 */
function open(docId: string): void {
  documentStore.loadDocument({
    docId,
    filename: `${docId}.md`,
    title: docId,
    body: '',
    htmlContent: '',
    richText: [],
  });
}

describe('documentStore — per-writer dirty tracking (audit 2.3)', () => {
  beforeEach(() => documentStore.clear());

  it('stays dirty until every writer that marked dirty has flushed', () => {
    open('d');
    documentStore.markDirty('d', 'text-tile:d');
    documentStore.markDirty('d', 'document-editor:d');
    expect(documentStore.getDocument('d')?.isDirty).toBe(true);

    // One writer flushes — the doc must STAY dirty (the sibling is unsaved).
    documentStore.markClean('d', 'text-tile:d');
    expect(documentStore.getDocument('d')?.isDirty).toBe(true);

    // Last writer flushes — now clean.
    documentStore.markClean('d', 'document-editor:d');
    expect(documentStore.getDocument('d')?.isDirty).toBe(false);
  });

  it('updateContent registers the writer so a sibling flush cannot clear it', () => {
    open('d');
    documentStore.updateContent('d', '<p>a</p>', 'a', 'document-editor:d');
    documentStore.markDirty('d', 'text-tile:d');
    documentStore.markClean('d', 'text-tile:d');
    // document-editor:d is still dirty from its updateContent.
    expect(documentStore.getDocument('d')?.isDirty).toBe(true);
  });

  it('legacy markClean(docId) with no writerId fully clears (back-compat)', () => {
    open('d');
    documentStore.markDirty('d', 'text-tile:d');
    documentStore.markClean('d');
    expect(documentStore.getDocument('d')?.isDirty).toBe(false);
  });

  it('applyReloadFromDisk clears every writer (disk authoritative)', () => {
    open('d');
    documentStore.markDirty('d', 'text-tile:d');
    documentStore.markDirty('d', 'document-editor:d');
    documentStore.applyReloadFromDisk('d', 'new body', []);
    expect(documentStore.getDocument('d')?.isDirty).toBe(false);
    // A late sibling flush must not resurrect dirtiness.
    documentStore.markClean('d', 'text-tile:d');
    expect(documentStore.getDocument('d')?.isDirty).toBe(false);
  });
});

/**
 * Audit2 2.2 — each editor view's reload `$effect` must gate on its OWN
 * writer's dirtiness, not the shared `isDirty` flag. Keying on the shared flag
 * froze EVERY view the instant any one became dirty, so two views editing the
 * same file inside one debounce window diverged and the last flush dropped the
 * other's keystrokes. `isWriterDirty` is the primitive the per-view gate reads.
 */
describe('documentStore — per-writer reload gating (audit2 2.2)', () => {
  beforeEach(() => documentStore.clear());

  it('isWriterDirty is true only for writers that marked dirty (a sibling stays eligible to reload)', () => {
    open('d');
    documentStore.updateContent('d', '<p>a</p>', 'a', 'text-tile:d');
    // The editing view is dirty; its own reload must be suppressed.
    expect(documentStore.isWriterDirty('d', 'text-tile:d')).toBe(true);
    // The sibling view never typed → still clean → its reload `$effect` is
    // free to pick up the latest body even though the doc is (shared) dirty.
    expect(documentStore.isWriterDirty('d', 'document-editor:d')).toBe(false);
    expect(documentStore.getDocument('d')?.isDirty).toBe(true);
  });

  it('a writer that flushes becomes reload-eligible again while a sibling stays dirty', () => {
    open('d');
    documentStore.markDirty('d', 'text-tile:d');
    documentStore.markDirty('d', 'document-editor:d');
    documentStore.markClean('d', 'text-tile:d');
    // text-tile flushed → eligible to reload the sibling's edits.
    expect(documentStore.isWriterDirty('d', 'text-tile:d')).toBe(false);
    // document-editor still holds unsaved content → must not reload.
    expect(documentStore.isWriterDirty('d', 'document-editor:d')).toBe(true);
    // Shared flag is still dirty (the old, too-coarse gate) — proving the
    // per-writer gate is strictly finer-grained.
    expect(documentStore.getDocument('d')?.isDirty).toBe(true);
  });

  it('an unknown / never-dirtied writer is reload-eligible', () => {
    open('d');
    expect(documentStore.isWriterDirty('d', 'text-tile:d')).toBe(false);
    expect(documentStore.isWriterDirty('missing-doc', 'whatever')).toBe(false);
  });
});
