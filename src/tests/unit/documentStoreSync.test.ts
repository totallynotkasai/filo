import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';

/**
 * Regression test for the multi-view markdown sync fix.
 *
 * Two text tiles on different boards backed by the same `.md` file must
 * collapse onto a single DocumentState (via `findByFilename`). After they
 * share a docId, edits pushed by one tile must be visible to the other
 * through the store — which is exactly what the new `$effect` in
 * `TextTile.svelte` watches.
 */

describe('documentStore — multi-view sync', () => {
  beforeEach(() => {
    documentStore.clear();
  });

  it('findByFilename normalises slashes and is case-insensitive', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Sub/Notes.md',
      title: 'Notes',
      body: 'hello',
      htmlContent: '<p>hello</p>',
      richText: [],
    });

    expect(documentStore.findByFilename('Sub/Notes.md')?.docId).toBe('doc_A');
    expect(documentStore.findByFilename('sub\\notes.MD')?.docId).toBe('doc_A');
    expect(documentStore.findByFilename('Other.md')).toBeNull();
  });

  it('a tile that finds an existing DocumentState shares the same docId', () => {
    // First tile loads the file under doc_A.
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });

    // Second tile would have generated its own contentId — but
    // TextTile.hydrateFromDisk first calls findByFilename, finds doc_A,
    // and adopts it as the canonical id. Simulate that path:
    const existing = documentStore.findByFilename('Notes.md');
    expect(existing).not.toBeNull();
    expect(existing?.docId).toBe('doc_A');

    // The second tile would then read the SAME body from the existing
    // state instead of issuing a fresh load.
    expect(existing?.body).toBe('first');
  });

  it('updateContent from one view is observable to a sibling reading the same docId', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });

    documentStore.updateContent('doc_A', '<p>second</p>', 'second');

    const after = documentStore.getDocument('doc_A');
    expect(after?.body).toBe('second');
    expect(after?.htmlContent).toBe('<p>second</p>');
    expect(after?.isDirty).toBe(true);

    // A sibling tile, reaching for findByFilename to reconcile its own
    // contentId, sees the *latest* body — not the original "first".
    expect(documentStore.findByFilename('Notes.md')?.body).toBe('second');
  });

  it('updateFilename retargets the in-memory doc so subsequent writes land at the new path', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });

    // Simulate the rename cascade in vaultStore.rename: the .md moves
    // into a subfolder, and we patch the open document so TextTile's next
    // writeMarkdownToDisk targets the new path (rather than recreating
    // Notes.md at the root and producing a duplicate).
    documentStore.updateFilename('doc_A', 'Sub/Notes.md');

    expect(documentStore.getDocument('doc_A')?.filename).toBe('Sub/Notes.md');
    // findByFilename now resolves the new path; the old path is gone.
    expect(documentStore.findByFilename('Sub/Notes.md')?.docId).toBe('doc_A');
    expect(documentStore.findByFilename('Notes.md')).toBeNull();
  });

  it('applyReloadFromDisk clears dirty and applies the new body so consumers can detect external edits', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.updateContent('doc_A', '<p>local</p>', 'local');
    expect(documentStore.getDocument('doc_A')?.isDirty).toBe(true);

    documentStore.applyReloadFromDisk('doc_A', 'from-disk', []);

    const after = documentStore.getDocument('doc_A');
    expect(after?.body).toBe('from-disk');
    expect(after?.isDirty).toBe(false);
  });
});

/**
 * Regression coverage for the frontmatter live-cache (Step 2 of the save-system
 * audit). Before the cache, each of TextTile / DocumentEditor / PropertiesPopup /
 * TaskListBoard held a private `frontmatter` snapshot. A write from any of them
 * would overwrite the file's frontmatter from a stale view, silently dropping
 * concurrent edits made by another writer in the same 300ms window. The cache
 * makes all four writers read and mutate the same map, so the last write
 * contains every prior edit.
 */
describe('documentStore — frontmatter live cache', () => {
  beforeEach(() => {
    documentStore.clear();
  });

  it('setFrontmatter stores a copy that getFrontmatter returns', () => {
    documentStore.setFrontmatter('doc_A', { tags: ['a'], completed: false });
    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['a'], completed: false });
    expect(documentStore.getFrontmatter('doc_B')).toBeUndefined();
  });

  it('setFrontmatter copies the top-level object so a later property addition does not leak in', () => {
    const original: Record<string, unknown> = { tags: ['a'] };
    documentStore.setFrontmatter('doc_A', original);
    original.priority = 'high';
    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['a'] });
  });

  it('mergeFrontmatter merges a patch and drops empty / null / undefined values', () => {
    documentStore.setFrontmatter('doc_A', { tags: ['a'], priority: 'high', dueDate: '2026-05-20' });
    const merged = documentStore.mergeFrontmatter('doc_A', {
      priority: '', // empty → drop
      dueDate: null, // null → drop
      status: undefined, // undefined → drop
      completed: true,
    });
    expect(merged).toEqual({ tags: ['a'], completed: true });
    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['a'], completed: true });
  });

  it('mergeFrontmatter seeds an empty cache entry from the patch alone', () => {
    const merged = documentStore.mergeFrontmatter('doc_A', { tags: ['x'] });
    expect(merged).toEqual({ tags: ['x'] });
    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['x'] });
  });

  it('clearFrontmatter removes the entry without touching siblings', () => {
    documentStore.setFrontmatter('doc_A', { tags: ['a'] });
    documentStore.setFrontmatter('doc_B', { tags: ['b'] });
    documentStore.clearFrontmatter('doc_A');
    expect(documentStore.getFrontmatter('doc_A')).toBeUndefined();
    expect(documentStore.getFrontmatter('doc_B')).toEqual({ tags: ['b'] });
  });

  it('unloadDocument also clears the frontmatter cache for that docId', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.setFrontmatter('doc_A', { tags: ['a'] });
    documentStore.unloadDocument('doc_A');
    expect(documentStore.getDocument('doc_A')).toBeUndefined();
    expect(documentStore.getFrontmatter('doc_A')).toBeUndefined();
  });

  it('clear() wipes both documents and frontmatter cache', () => {
    documentStore.setFrontmatter('doc_A', { tags: ['a'] });
    documentStore.setFrontmatter('doc_B', { tags: ['b'] });
    documentStore.clear();
    expect(documentStore.getFrontmatter('doc_A')).toBeUndefined();
    expect(documentStore.getFrontmatter('doc_B')).toBeUndefined();
  });

  it('cross-writer race: PropertiesPopup setFrontmatter then TextTile read sees the new tag', () => {
    // Simulates: TextTile hydrate seeds the cache; PropertiesPopup edits a tag
    // and overwrites the cache; TextTile's debounced write fires after and
    // pulls from the cache, so the tag survives.
    documentStore.setFrontmatter('doc_A', { tags: ['a'] });

    // PropertiesPopup's persist path: full replacement with the popup's rows.
    documentStore.setFrontmatter('doc_A', { tags: ['a', 'b'] });

    // TextTile's writeMarkdownToDisk pulls from the cache at write time.
    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['a', 'b'] });
  });

  it('cross-writer race: TaskListBoard mergeFrontmatter does not clobber a popup-set tag', () => {
    // Initial state shared between popup and tasklist.
    documentStore.setFrontmatter('doc_A', { tags: ['a'] });

    // Popup adds a tag.
    documentStore.setFrontmatter('doc_A', { tags: ['a', 'b'] });

    // TaskListBoard toggles completion via mergeFrontmatter — merges into the
    // popup's value, so the tag survives.
    documentStore.mergeFrontmatter('doc_A', { completed: true });

    expect(documentStore.getFrontmatter('doc_A')).toEqual({
      tags: ['a', 'b'],
      completed: true,
    });
  });

  it('applyReloadFromDisk with frontmatter refreshes the live cache', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.setFrontmatter('doc_A', { tags: ['old'] });

    documentStore.applyReloadFromDisk('doc_A', 'from-disk', [], { tags: ['new'], status: 'done' });

    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['new'], status: 'done' });
  });

  it('applyReloadFromDisk without frontmatter leaves the live cache untouched', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.setFrontmatter('doc_A', { tags: ['keep'] });

    documentStore.applyReloadFromDisk('doc_A', 'from-disk', []);

    expect(documentStore.getFrontmatter('doc_A')).toEqual({ tags: ['keep'] });
  });
});

/**
 * Phase 20 / S6 — external-edit toast must report a byte-delta hint so the
 * user can tell at a glance whether the upstream change is a tweak or a
 * wholesale rewrite. Same-size content edits surface as "modified".
 */
describe('documentStore — external-edit toast byte-delta', () => {
  beforeEach(() => {
    documentStore.clear();
    for (const toast of [...uiStore.toasts]) {
      uiStore.dismissToast(toast.id, { silent: true });
    }
  });

  function loadDirty(body: string) {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body,
      htmlContent: `<p>${body}</p>`,
      richText: [],
    });
    documentStore.updateContent('doc_A', `<p>${body}-edited</p>`, body);
  }

  it('renders +N bytes when the external version grew', () => {
    loadDirty('hello');
    documentStore.handleExternalChange('doc_A', 'hello world!', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast).toBeDefined();
    expect(toast?.text).toContain('(+7 bytes)');
  });

  it('renders −N bytes (U+2212) when the external version shrank', () => {
    loadDirty('hello world!');
    documentStore.handleExternalChange('doc_A', 'hello', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast?.text).toContain('(−7 bytes)');
  });

  it('renders "modified" when the byte length is unchanged', () => {
    loadDirty('hello');
    documentStore.handleExternalChange('doc_A', 'world', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast?.text).toContain('(modified)');
  });

  it('counts UTF-8 byte length, not character count', () => {
    // "é" is 2 bytes in UTF-8 but 1 character. The toast must report bytes.
    loadDirty('ab');
    documentStore.handleExternalChange('doc_A', 'abé', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast?.text).toContain('(+2 bytes)');
  });

  it('clean editor skips the toast and reloads silently', () => {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.handleExternalChange('doc_A', 'second', []);
    expect(uiStore.toasts).toHaveLength(0);
    expect(documentStore.getDocument('doc_A')?.body).toBe('second');
  });
});
