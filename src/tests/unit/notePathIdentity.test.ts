import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { tabStore } from '@renderer/stores/tabs.svelte';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import {
  registerForceWriter,
  unregisterForceWriter,
  forceWriteForDocument,
  cancelAllMarkdownWrites,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  getLastFlushedFrontmatterVersion,
  noteFrontmatterFlushedVersion,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';

/**
 * A note's vault path is its only identity: every per-note map is keyed by
 * the case-folded path, and a rename moves each entry to the new key. These
 * pin the rename half, which a stable opaque id used to make unnecessary.
 */

function load(filename: string, body = ''): void {
  documentStore.loadDocument({ filename, title: filename, body, htmlContent: '', richText: [] });
}

beforeEach(() => {
  documentStore.clear();
  resetFrontmatterScheduler();
  cancelAllMarkdownWrites();
  tabStore.closeAll();
});
afterEach(() => {
  documentStore.clear();
  resetFrontmatterScheduler();
  cancelAllMarkdownWrites();
  tabStore.closeAll();
});

describe('one document per path', () => {
  it('any spelling of the path names the same document', () => {
    load('Notes/Shopping.md', 'milk');
    load('notes/shopping.md', 'ignored');
    expect(documentStore.documents.size).toBe(1);
    expect(documentStore.getDocument('NOTES\\Shopping.md')?.body).toBe('milk');
    expect(documentStore.findByFilename('notes/SHOPPING.md')?.filename).toBe('Notes/Shopping.md');
  });

  it('every per-note cache is shared by the path', () => {
    documentStore.setFrontmatter('Notes/A.md', { title: 'A' });
    documentStore.setReadOnly('notes/a.md', true);
    expect(documentStore.getFrontmatter('NOTES/A.MD')).toEqual({ title: 'A' });
    expect(documentStore.isReadOnly('Notes/A.md')).toBe(true);
  });
});

describe('a rename re-keys the document store', () => {
  it('moves the document, its caches and its counters to the new path', () => {
    load('Notes/Old.md', 'body');
    documentStore.setFrontmatter('Notes/Old.md', { title: 'T' }, 'title: T\n');
    documentStore.updateContent('Notes/Old.md', '<p>x</p>', 'body 2', 'writer-1');
    const version = documentStore.getFrontmatterMutationVersion('Notes/Old.md');

    renameAllPathKeys('Notes/Old.md', 'Notes/New.md');

    expect(documentStore.getDocument('Notes/Old.md')).toBeUndefined();
    const moved = documentStore.getDocument('Notes/New.md');
    expect(moved?.filename).toBe('Notes/New.md');
    expect(moved?.body).toBe('body 2');
    expect(documentStore.getFrontmatter('Notes/New.md')).toEqual({ title: 'T' });
    expect(documentStore.getOriginalFrontmatterSource('Notes/New.md')).toBe('title: T\n');
    expect(documentStore.isWriterDirty('Notes/New.md', 'writer-1')).toBe(true);
    expect(documentStore.getFrontmatterMutationVersion('Notes/New.md')).toBe(version);
    expect(documentStore.getFrontmatterMutationVersion('Notes/Old.md')).toBe(0);
  });

  it('moves every note under a renamed folder, keeping each tail as spelled', () => {
    load('Notes/2026/Daily Log.md');
    load('Other/Keep.md');
    renameAllPathKeys('Notes', 'Archive');
    expect(documentStore.getDocument('Archive/2026/Daily Log.md')?.filename).toBe('Archive/2026/Daily Log.md');
    expect(documentStore.getDocument('Notes/2026/Daily Log.md')).toBeUndefined();
    expect(documentStore.getDocument('Other/Keep.md')?.filename).toBe('Other/Keep.md');
  });

  it('a case-only rename keeps the entry and takes the new spelling', () => {
    load('Notes/foo.md', 'kept');
    renameAllPathKeys('Notes/foo.md', 'Notes/Foo.md');
    expect(documentStore.documents.size).toBe(1);
    expect(documentStore.getDocument('notes/foo.md')?.filename).toBe('Notes/Foo.md');
    expect(documentStore.getDocument('notes/foo.md')?.body).toBe('kept');
  });

  it('a counter never goes backwards when the new path already had one', () => {
    for (let i = 0; i < 5; i++) documentStore.setFrontmatter('B.md', { n: i });
    documentStore.setFrontmatter('A.md', { n: 0 });
    renameAllPathKeys('A.md', 'B.md');
    expect(documentStore.getFrontmatterMutationVersion('B.md')).toBe(5);
    // The moved note's own frontmatter-only count survives; the jump is body churn.
    expect(documentStore.getFrontmatterOnlyMutationVersion('B.md')).toBe(1);
  });
});

describe('the frontmatter scheduler follows the rename', () => {
  it('moves the flushed-version mark, so a new note at the old path is never treated as stale', () => {
    for (let i = 0; i < 5; i++) documentStore.setFrontmatter('A.md', { n: i });
    noteFrontmatterFlushedVersion('A.md', 5);

    renameAllPathKeys('A.md', 'B.md');

    // The renamed note keeps its mark next to its counter.
    expect(getLastFlushedFrontmatterVersion('b.md')).toBe(5);
    expect(documentStore.getFrontmatterMutationVersion('B.md')).toBe(5);
    // A note created at the freed path starts clean: a leftover mark of 5 would
    // make its first four writes look stale and skip them.
    expect(getLastFlushedFrontmatterVersion('A.md')).toBe(0);
    documentStore.setFrontmatter('A.md', { title: 'new note' });
    expect(documentStore.getFrontmatterMutationVersion('A.md')).toBeGreaterThan(getLastFlushedFrontmatterVersion('A.md'));
  });
});

describe('registered editors follow the rename', () => {
  it('Keep-local still reaches an editor whose note moved after it registered', async () => {
    const build = vi.fn(() => null);
    registerForceWriter('text-tile:t1', 'Notes/A.md', build);
    try {
      renameAllPathKeys('Notes', 'Archive');
      await forceWriteForDocument('archive/a.md');
      expect(build).toHaveBeenCalledTimes(1);
      build.mockClear();
      await forceWriteForDocument('Notes/A.md');
      expect(build).not.toHaveBeenCalled();
    } finally {
      unregisterForceWriter('text-tile:t1');
    }
  });

  it('a Document tab follows its note, and reopening the new path focuses it', () => {
    const tab = tabStore.openNote('Notes/A.md', 'A');
    const other = tabStore.openNote('Notes/B.md', 'B');
    renameAllPathKeys('Notes/A.md', 'Notes/Renamed.md');
    const moved = tabStore.tabs.find((t) => t.id === tab.id);
    expect(moved?.notePath).toBe('Notes/Renamed.md');
    // The board id is opaque, so the tab's undo stack is untouched by the rename.
    expect(moved?.boardId).toBe(tab.boardId);
    expect(tabStore.openNote('notes/renamed.md', 'A').id).toBe(tab.id);
    expect(tabStore.tabs.find((t) => t.id === other.id)?.notePath).toBe('Notes/B.md');
    expect(tabStore.tabs).toHaveLength(2);
  });
});

describe('frontmatter id (D6)', () => {
  it('assembling a note never adds an id key', () => {
    const text = assembleMarkdownFile({ title: 'Shopping' }, 'milk\n');
    expect(text).not.toMatch(/^id:/m);
  });

  it('an id the file already has is left untouched on a metadata edit', () => {
    const original = 'id: abc123\ntitle: Old\n';
    const text = assembleMarkdownFile({ id: 'abc123', title: 'New' }, 'body\n', {
      frontmatterDirty: true,
      originalFrontmatter: original,
    });
    expect(text).toContain('id: abc123\n');
    expect(text).toContain('title: New\n');
  });
});
