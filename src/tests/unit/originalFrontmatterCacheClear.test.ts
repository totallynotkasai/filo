import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';

/**
 * Audit-7 L6 — `originalFrontmatterCache` (the disk-baseline FM source the
 * CST engine diffs against) is deliberately retained across mutations, so the
 * vault-swap reset `clear()` and the per-doc `unloadDocument()` must drop it
 * explicitly. Both omitted it, leaking the outgoing/closed doc's FM source
 * bytes (only `clearFrontmatter` cleaned it, which `unloadDocument` doesn't
 * route through).
 */
describe('Audit-7 L6 — originalFrontmatterCache cleared on swap + unload', () => {
  beforeEach(() => {
    documentStore.clear();
  });

  it('clear(nextVault) drops the disk-baseline FM source for every doc', () => {
    const docId = 'doc-l6-clear';
    documentStore.loadDocument({
      docId,
      filename: 'A.md',
      title: 'A',
      body: '',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'A' }, 'title: A\ntags: [x]');
    expect(documentStore.getOriginalFrontmatterSource(docId)).toBe('title: A\ntags: [x]');

    documentStore.clear('/next-vault');

    expect(documentStore.getOriginalFrontmatterSource(docId)).toBeUndefined();
  });

  it('unloadDocument(docId) drops the disk-baseline FM source for that doc', () => {
    const docId = 'doc-l6-unload';
    documentStore.loadDocument({
      docId,
      filename: 'B.md',
      title: 'B',
      body: '',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'B' }, 'title: B');
    expect(documentStore.getOriginalFrontmatterSource(docId)).toBe('title: B');

    documentStore.unloadDocument(docId);

    expect(documentStore.getOriginalFrontmatterSource(docId)).toBeUndefined();
  });
});
