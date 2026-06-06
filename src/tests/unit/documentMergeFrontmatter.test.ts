import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';

/**
 * 1.1 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — `mergeFrontmatter` cleaned every
 * key of the merged object, so a present-but-empty disk key the user never
 * touched (`aliases:`, `cssclasses:`, `subtitle: ""`) was stripped whenever an
 * UNRELATED field was edited — and the next write then erased it from the file.
 * The fix cleans ONLY the keys present in the patch (the ones the user set).
 */
describe('documentStore.mergeFrontmatter — untouched empty key survives (1.1)', () => {
  beforeEach(() => documentStore.clear());

  it('keeps a present-but-empty key when an unrelated field is merged', () => {
    documentStore.setFrontmatter('doc_X', { aliases: null, title: 'x' });
    const merged = documentStore.mergeFrontmatter('doc_X', { priority: 'high' });

    expect('aliases' in merged).toBe(true);
    expect(merged.aliases).toBeNull();
    expect(merged.priority).toBe('high');
    expect(merged.title).toBe('x');
    // The cache reflects the same survival.
    const cached = documentStore.getFrontmatter('doc_X') ?? {};
    expect('aliases' in cached).toBe(true);
  });

  it('keeps an empty-string key (subtitle: "") the user did not touch', () => {
    documentStore.setFrontmatter('doc_Z', { subtitle: '', title: 'x' });
    const merged = documentStore.mergeFrontmatter('doc_Z', { priority: 'low' });
    expect('subtitle' in merged).toBe(true);
    expect(merged.subtitle).toBe('');
  });

  it('still drops a key the user explicitly clears in the patch', () => {
    documentStore.setFrontmatter('doc_Y', { title: 'x', subtitle: 'sub' });
    const merged = documentStore.mergeFrontmatter('doc_Y', { subtitle: '' });
    expect('subtitle' in merged).toBe(false);
    expect(merged.title).toBe('x');
  });
});
