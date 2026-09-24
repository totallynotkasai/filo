import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';

/**
 * Phase 4.4 (2026-05-30) — `documentStore.propagateRename` repoints every
 * open document whose filename matches a rename (exact) or sits under a
 * renamed folder (prefix). Extracted from the in-app rename path so the
 * rename-cascade recovery retry can reuse the identical logic instead of a
 * divergent exact-match-only snippet.
 */

/** Loads a document whose title marks it, so a test can follow it across a re-key. */
function load(title: string, filename: string): void {
  documentStore.loadDocument({
    filename,
    title,
    body: '',
    htmlContent: '',
    richText: [],
  });
}

describe('documentStore.propagateRename (Phase 4.4)', () => {
  beforeEach(() => documentStore.clear());
  afterEach(() => documentStore.clear());

  it('repoints an exact-match file rename', () => {
    load('d', 'Notes/old.md');
    const n = documentStore.propagateRename('Notes/old.md', 'Notes/new.md');
    expect(n).toBe(1);
    expect(documentStore.findByFilename('Notes/new.md')?.title).toBe('d');
    expect(documentStore.findByFilename('Notes/old.md')).toBeNull();
  });

  it('repoints descendants under a renamed folder (prefix walk)', () => {
    load('d', 'Notes/2026/foo.md');
    const n = documentStore.propagateRename('Notes', 'Archive');
    expect(n).toBe(1);
    expect(documentStore.findByFilename('Archive/2026/foo.md')?.title).toBe('d');
    expect(documentStore.findByFilename('Notes/2026/foo.md')).toBeNull();
  });

  it('leaves unrelated documents untouched', () => {
    load('d', 'Other/bar.md');
    const n = documentStore.propagateRename('Notes', 'Archive');
    expect(n).toBe(0);
    expect(documentStore.findByFilename('Other/bar.md')?.title).toBe('d');
  });

  it('matches case-insensitively and applies the new path as given', () => {
    load('d', 'Notes/Old.md');
    const n = documentStore.propagateRename('notes/old.md', 'notes/renamed.md');
    expect(n).toBe(1);
    expect(documentStore.findByFilename('notes/renamed.md')?.title).toBe('d');
    expect(documentStore.findByFilename('notes/renamed.md')?.filename).toBe('notes/renamed.md');
  });
});
