import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { parseMarkdownFile } from '@renderer/lib/editor/markdownSync';

/**
 * Regression test for the multi-view markdown sync fix.
 *
 * Two text tiles on different boards backed by the same `.md` file must
 * collapse onto a single DocumentState: the store is keyed by the note's
 * path, so edits pushed by one tile must be visible to the other through the
 * store — which is exactly what the `$effect` in `TextTile.svelte` watches.
 */

describe('documentStore — multi-view sync', () => {
  beforeEach(() => {
    documentStore.clear();
  });

  it('findByFilename normalises slashes and is case-insensitive', () => {
    documentStore.loadDocument({
      filename: 'Sub/Notes.md',
      title: 'Notes',
      body: 'hello',
      htmlContent: '<p>hello</p>',
      richText: [],
    });

    expect(documentStore.findByFilename('Sub/Notes.md')?.filename).toBe('Sub/Notes.md');
    expect(documentStore.findByFilename('sub\\notes.MD')?.filename).toBe('Sub/Notes.md');
    expect(documentStore.findByFilename('Other.md')).toBeNull();
  });

  it('a second view of the same path reaches the existing DocumentState', () => {
    // First tile loads the file.
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });

    // A second tile on another board names the same note, in any spelling:
    // it lands on the same entry instead of issuing a fresh load.
    const existing = documentStore.findByFilename('notes.md');
    expect(existing).not.toBeNull();
    expect(existing).toBe(documentStore.getDocument('Notes.md'));
    expect(existing?.filename).toBe('Notes.md');
    expect(existing?.body).toBe('first');
  });

  it('updateContent from one view is observable to a sibling reading the same path', () => {
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });

    documentStore.updateContent('Notes.md', '<p>second</p>', 'second');

    const after = documentStore.getDocument('Notes.md');
    expect(after?.body).toBe('second');
    expect(after?.htmlContent).toBe('<p>second</p>');
    expect(after?.isDirty).toBe(true);

    // A sibling tile reading the same note sees the *latest* body — not the
    // original "first".
    expect(documentStore.findByFilename('Notes.md')?.body).toBe('second');
  });

  it('propagateRename re-keys the in-memory doc so subsequent writes land at the new path', () => {
    documentStore.loadDocument({
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
    expect(documentStore.propagateRename('Notes.md', 'Sub/Notes.md')).toBe(1);

    expect(documentStore.getDocument('Sub/Notes.md')?.filename).toBe('Sub/Notes.md');
    expect(documentStore.getDocument('Sub/Notes.md')?.body).toBe('first');
    // findByFilename now resolves the new path; the old path is gone.
    expect(documentStore.findByFilename('Sub/Notes.md')).not.toBeNull();
    expect(documentStore.findByFilename('Notes.md')).toBeNull();
  });

  it('applyReloadFromDisk clears dirty and applies the new body so consumers can detect external edits', () => {
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.updateContent('Notes.md', '<p>local</p>', 'local');
    expect(documentStore.getDocument('Notes.md')?.isDirty).toBe(true);

    documentStore.applyReloadFromDisk('Notes.md', 'from-disk', []);

    const after = documentStore.getDocument('Notes.md');
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
    documentStore.setFrontmatter('Notes.md', { tags: ['a'], completed: false });
    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['a'], completed: false });
    expect(documentStore.getFrontmatter('Other.md')).toBeUndefined();
  });

  it('setFrontmatter copies the top-level object so a later property addition does not leak in', () => {
    const original: Record<string, unknown> = { tags: ['a'] };
    documentStore.setFrontmatter('Notes.md', original);
    original.priority = 'high';
    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['a'] });
  });

  it('mergeFrontmatter merges a patch and drops empty / null / undefined values', () => {
    documentStore.setFrontmatter('Notes.md', { tags: ['a'], priority: 'high', dueDate: '2026-05-20' });
    const merged = documentStore.mergeFrontmatter('Notes.md', {
      priority: '', // empty → drop
      dueDate: null, // null → drop
      status: undefined, // undefined → drop
      completed: true,
    });
    expect(merged).toEqual({ tags: ['a'], completed: true });
    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['a'], completed: true });
  });

  it('mergeFrontmatter seeds an empty cache entry from the patch alone', () => {
    const merged = documentStore.mergeFrontmatter('Notes.md', { tags: ['x'] });
    expect(merged).toEqual({ tags: ['x'] });
    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['x'] });
  });

  it('clearFrontmatter removes the entry without touching siblings', () => {
    documentStore.setFrontmatter('Notes.md', { tags: ['a'] });
    documentStore.setFrontmatter('Other.md', { tags: ['b'] });
    documentStore.clearFrontmatter('Notes.md');
    expect(documentStore.getFrontmatter('Notes.md')).toBeUndefined();
    expect(documentStore.getFrontmatter('Other.md')).toEqual({ tags: ['b'] });
  });

  it('unloadDocument also clears the frontmatter cache for that note', () => {
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { tags: ['a'] });
    documentStore.unloadDocument('Notes.md');
    expect(documentStore.getDocument('Notes.md')).toBeUndefined();
    expect(documentStore.getFrontmatter('Notes.md')).toBeUndefined();
  });

  it('clear() wipes both documents and frontmatter cache', () => {
    documentStore.setFrontmatter('Notes.md', { tags: ['a'] });
    documentStore.setFrontmatter('Other.md', { tags: ['b'] });
    documentStore.clear();
    expect(documentStore.getFrontmatter('Notes.md')).toBeUndefined();
    expect(documentStore.getFrontmatter('Other.md')).toBeUndefined();
  });

  it('cross-writer race: PropertiesPopup setFrontmatter then TextTile read sees the new tag', () => {
    // Simulates: TextTile hydrate seeds the cache; PropertiesPopup edits a tag
    // and overwrites the cache; TextTile's debounced write fires after and
    // pulls from the cache, so the tag survives.
    documentStore.setFrontmatter('Notes.md', { tags: ['a'] });

    // PropertiesPopup's persist path: full replacement with the popup's rows.
    documentStore.setFrontmatter('Notes.md', { tags: ['a', 'b'] });

    // TextTile's writeMarkdownToDisk pulls from the cache at write time.
    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['a', 'b'] });
  });

  it('cross-writer race: TaskListBoard mergeFrontmatter does not clobber a popup-set tag', () => {
    // Initial state shared between popup and tasklist.
    documentStore.setFrontmatter('Notes.md', { tags: ['a'] });

    // Popup adds a tag.
    documentStore.setFrontmatter('Notes.md', { tags: ['a', 'b'] });

    // TaskListBoard toggles completion via mergeFrontmatter — merges into the
    // popup's value, so the tag survives.
    documentStore.mergeFrontmatter('Notes.md', { completed: true });

    expect(documentStore.getFrontmatter('Notes.md')).toEqual({
      tags: ['a', 'b'],
      completed: true,
    });
  });

  it('applyReloadFromDisk with frontmatter refreshes the live cache', () => {
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { tags: ['old'] });

    documentStore.applyReloadFromDisk('Notes.md', 'from-disk', [], { tags: ['new'], status: 'done' });

    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['new'], status: 'done' });
  });

  it('applyReloadFromDisk without frontmatter leaves the live cache untouched', () => {
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { tags: ['keep'] });

    documentStore.applyReloadFromDisk('Notes.md', 'from-disk', []);

    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ tags: ['keep'] });
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
      filename: 'Notes.md',
      title: 'Notes',
      body,
      htmlContent: `<p>${body}</p>`,
      richText: [],
    });
    documentStore.updateContent('Notes.md', `<p>${body}-edited</p>`, body);
  }

  it('renders +N bytes when the external version grew', () => {
    loadDirty('hello');
    documentStore.handleExternalChange('Notes.md', 'hello world!', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast).toBeDefined();
    expect(toast?.text).toContain('(+7 bytes)');
  });

  it('renders −N bytes (U+2212) when the external version shrank', () => {
    loadDirty('hello world!');
    documentStore.handleExternalChange('Notes.md', 'hello', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast?.text).toContain('(−7 bytes)');
  });

  it('renders "modified" when the byte length is unchanged', () => {
    loadDirty('hello');
    documentStore.handleExternalChange('Notes.md', 'world', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast?.text).toContain('(modified)');
  });

  it('counts UTF-8 byte length, not character count', () => {
    // "é" is 2 bytes in UTF-8 but 1 character. The toast must report bytes.
    loadDirty('ab');
    documentStore.handleExternalChange('Notes.md', 'abé', []);
    const toast = uiStore.toasts.find((t) => t.text.includes('Notes'));
    expect(toast?.text).toContain('(+2 bytes)');
  });

  it('clean editor skips the toast and reloads silently', () => {
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'first',
      htmlContent: '<p>first</p>',
      richText: [],
    });
    documentStore.handleExternalChange('Notes.md', 'second', []);
    expect(uiStore.toasts).toHaveLength(0);
    expect(documentStore.getDocument('Notes.md')?.body).toBe('second');
  });
});

/**
 * Audit2 2.2 (latent bug) — a SECOND view (a TextTile or DocumentEditor) that
 * hydrates from the in-memory `DocumentState.body` instead of a fresh disk read
 * must not re-seed frontmatter from that body. The store body is body-only by
 * contract, so `parseMarkdownFile(body).frontmatter` is always `{}` — passing
 * it to `setFrontmatter` clobbered the real FM (and dropped the 1.2 verbatim
 * raw bytes) that the first view seeded from disk, after which a body-only save
 * emitted no `---` fence and ERASED the file's frontmatter block. The fix gates
 * those hydrate branches on `hasFrontmatter`; this suite pins the store
 * contract those branches now rely on.
 */
describe('documentStore — cached-body hydrate must not clobber seeded frontmatter (audit2 2.2)', () => {
  beforeEach(() => {
    documentStore.clear();
  });

  it('hasFrontmatter reports whether a sibling view already seeded FM from disk', () => {
    expect(documentStore.hasFrontmatter('Notes.md')).toBe(false);
    documentStore.setFrontmatter('Notes.md', { title: 'X', tags: ['a'] }, '---\ntitle: X\ntags: [a]\n---');
    expect(documentStore.hasFrontmatter('Notes.md')).toBe(true);
  });

  it('a second view hydrating from the body-only store body preserves disk-seeded FM + raw bytes', () => {
    // View 1 reads the file from disk and seeds the real frontmatter plus the
    // verbatim (1.2) raw bytes.
    const raw = '---\ntitle: X\ntags: [a]\n---';
    documentStore.setFrontmatter('Notes.md', { title: 'X', tags: ['a'] }, raw);
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'just the body, no fence',
      htmlContent: '<p>just the body, no fence</p>',
      richText: [],
    });

    // View 2's cached-body hydrate branch (TextTile / DocumentEditor). The
    // store body is body-only, so re-parsing it yields no frontmatter…
    const docState = documentStore.getDocument('Notes.md')!;
    const reparsed = parseMarkdownFile(docState.body);
    expect(reparsed.frontmatter).toEqual({});

    // …so the FIXED branch guards on `hasFrontmatter` and SKIPS the re-seed
    // (pre-fix it called setFrontmatter('Notes.md', {}) → clobber). Modelled here
    // exactly as the component branch now decides.
    if (!documentStore.hasFrontmatter('Notes.md')) {
      documentStore.setFrontmatter('Notes.md', reparsed.frontmatter);
    }

    // Real FM and the verbatim raw bytes survive — a later body-only save will
    // emit the fence untouched instead of erasing it.
    expect(documentStore.getFrontmatter('Notes.md')).toEqual({ title: 'X', tags: ['a'] });
    expect(documentStore.getRawFrontmatter('Notes.md')).toBe(raw);
  });
});
