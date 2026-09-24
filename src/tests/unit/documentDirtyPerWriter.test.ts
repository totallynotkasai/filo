import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';

/**
 * Audit 2.3 — `isDirty` is shared by every writer on a note (a TextTile and a
 * DocumentEditor can be open on the same file). Before per-writer tracking,
 * one writer's `markClean` cleared the flag even while the sibling still held
 * unsaved content, letting the sibling's reload `$effect` reload from a stale
 * body. These tests pin the per-writer contract.
 */
function open(path: string): void {
  documentStore.loadDocument({
    filename: path,
    title: path.replace(/[.]md$/, ''),
    body: '',
    htmlContent: '',
    richText: [],
  });
}

describe('documentStore — per-writer dirty tracking (audit 2.3)', () => {
  beforeEach(() => documentStore.clear());

  it('stays dirty until every writer that marked dirty has flushed', () => {
    open('d.md');
    documentStore.markDirty('d.md', 'text-tile:d');
    documentStore.markDirty('d.md', 'document-editor:d');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);

    // One writer flushes — the doc must STAY dirty (the sibling is unsaved).
    documentStore.markClean('d.md', 'text-tile:d');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);

    // Last writer flushes — now clean.
    documentStore.markClean('d.md', 'document-editor:d');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(false);
  });

  it('updateContent registers the writer so a sibling flush cannot clear it', () => {
    open('d.md');
    documentStore.updateContent('d.md', '<p>a</p>', 'a', 'document-editor:d');
    documentStore.markDirty('d.md', 'text-tile:d');
    documentStore.markClean('d.md', 'text-tile:d');
    // document-editor:d is still dirty from its updateContent.
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);
  });

  it('markClean(path) with no writerId fully clears (back-compat)', () => {
    open('d.md');
    documentStore.markDirty('d.md', 'text-tile:d');
    documentStore.markClean('d.md');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(false);
  });

  it('applyReloadFromDisk clears every writer (disk authoritative)', () => {
    open('d.md');
    documentStore.markDirty('d.md', 'text-tile:d');
    documentStore.markDirty('d.md', 'document-editor:d');
    documentStore.applyReloadFromDisk('d.md', 'new body', []);
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(false);
    // A late sibling flush must not resurrect dirtiness.
    documentStore.markClean('d.md', 'text-tile:d');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(false);
  });
});

/**
 * Audit-7 M1 — `dropDirtyWriter` lets an unmounting TextTile remove its
 * writerId WITHOUT asserting the content saved. Pre-fix TextTile's onDestroy
 * never cleared its writer (the markClean lived in dead code), so the entry
 * lingered forever → `isDirty` pinned true → spurious external-edit prompts +
 * a frozen sibling reload `$effect`. These pin the drop semantics.
 */
describe('documentStore — dropDirtyWriter (audit-7 M1)', () => {
  beforeEach(() => documentStore.clear());

  it('removes the writer and clears isDirty when it was the last one', () => {
    open('d.md');
    documentStore.updateContent('d.md', '<p>a</p>', 'a', 'text-tile:d');
    expect(documentStore.isWriterDirty('d.md', 'text-tile:d')).toBe(true);
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);

    documentStore.dropDirtyWriter('d.md', 'text-tile:d');
    expect(documentStore.isWriterDirty('d.md', 'text-tile:d')).toBe(false);
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(false);
  });

  it('leaves isDirty true when a sibling writer is still dirty', () => {
    open('d.md');
    documentStore.markDirty('d.md', 'text-tile:d');
    documentStore.markDirty('d.md', 'document-editor:d');

    // The TextTile unmounts → drops its writer; the DocumentEditor is still dirty.
    documentStore.dropDirtyWriter('d.md', 'text-tile:d');
    expect(documentStore.isWriterDirty('d.md', 'text-tile:d')).toBe(false);
    expect(documentStore.isWriterDirty('d.md', 'document-editor:d')).toBe(true);
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);
  });

  it('is a no-op for an untracked writer (does not clobber no-writerId dirtiness)', () => {
    open('d.md');
    // Title-edit style dirtiness: isDirty set with NO writer registered.
    documentStore.markDirty('d.md');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);

    // An unrelated writer dropping its (nonexistent) entry must not clear the flag.
    documentStore.dropDirtyWriter('d.md', 'text-tile:d');
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);
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
    open('d.md');
    documentStore.updateContent('d.md', '<p>a</p>', 'a', 'text-tile:d');
    // The editing view is dirty; its own reload must be suppressed.
    expect(documentStore.isWriterDirty('d.md', 'text-tile:d')).toBe(true);
    // The sibling view never typed → still clean → its reload `$effect` is
    // free to pick up the latest body even though the doc is (shared) dirty.
    expect(documentStore.isWriterDirty('d.md', 'document-editor:d')).toBe(false);
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);
  });

  it('a writer that flushes becomes reload-eligible again while a sibling stays dirty', () => {
    open('d.md');
    documentStore.markDirty('d.md', 'text-tile:d');
    documentStore.markDirty('d.md', 'document-editor:d');
    documentStore.markClean('d.md', 'text-tile:d');
    // text-tile flushed → eligible to reload the sibling's edits.
    expect(documentStore.isWriterDirty('d.md', 'text-tile:d')).toBe(false);
    // document-editor still holds unsaved content → must not reload.
    expect(documentStore.isWriterDirty('d.md', 'document-editor:d')).toBe(true);
    // Shared flag is still dirty (the old, too-coarse gate) — proving the
    // per-writer gate is strictly finer-grained.
    expect(documentStore.getDocument('d.md')?.isDirty).toBe(true);
  });

  it('an unknown / never-dirtied writer is reload-eligible', () => {
    open('d.md');
    expect(documentStore.isWriterDirty('d.md', 'text-tile:d')).toBe(false);
    expect(documentStore.isWriterDirty('missing-doc', 'whatever')).toBe(false);
  });
});
