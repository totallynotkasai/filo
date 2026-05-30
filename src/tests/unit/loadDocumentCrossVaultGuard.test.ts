/**
 * Audit 3.3 — `loadDocument` must not repopulate the store for a vault other
 * than the live one.
 *
 * On a vault swap the `document` pre-swap handler runs `clear()` (emptying the
 * map) and binds the store to the INCOMING vault. `clear()` fires while the
 * OUTGOING vault is still semantically active (the committed vault path hasn't
 * flipped yet). If a stale tile `$effect` from the outgoing vault fires
 * loadDocument before it unmounts, it would re-insert the old vault's content
 * under a docId; a later debounced write then emits that old vault-relative
 * path into the NEW vault's root (cross-vault file write).
 *
 * The fix: bind the store to the incoming vault at clear() time and refuse any
 * loadDocument whose live `getActiveVaultPath()` doesn't yet match the bound
 * vault. The active path is published at commit by `seedViewportsCache`, which
 * receives `candidate.path === newVaultPath` (no normalisation — see
 * vaultCandidate.ts), so it becomes byte-identical to the bound `nextVault`
 * after the swap commits, allowing legitimate new-vault loads through. The
 * test drives that signal directly via `setActiveVaultPath`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import type { RichTextAnnotation } from '@renderer/schema/document';

function makeDoc(docId: string, filename: string) {
  return {
    docId,
    filename,
    title: filename.replace(/\.md$/, ''),
    body: 'body',
    htmlContent: '',
    richText: [] as RichTextAnnotation[],
  };
}

describe('Audit 3.3 — loadDocument cross-vault guard', () => {
  beforeEach(() => {
    documentStore.clear(); // unbind (nextVault defaults to null)
    setActiveVaultPath('');
  });

  it('refuses a stale load while the live vault differs from the bound (incoming) vault', () => {
    // Vault A is live; loading a doc binds the store to A.
    setActiveVaultPath('/vault/A');
    documentStore.loadDocument(makeDoc('a1', 'a.md'));
    expect(documentStore.getDocument('a1')).toBeDefined();

    // Swap begins: clear() empties the map and binds to the incoming vault B.
    // The committed vault path is STILL A (pre-swap runs in the outgoing vault).
    documentStore.clear('/vault/B');
    expect(documentStore.getDocument('a1')).toBeUndefined();

    // A stale vault-A tile fires loadDocument before unmounting. Live path is
    // still A, bound vault is B → the insert must be refused (a no-op).
    const returned = documentStore.loadDocument(makeDoc('a2', 'stale.md'));
    expect(returned).toBeDefined(); // returns a state object for the caller
    expect(documentStore.getDocument('a2')).toBeUndefined(); // but NOT stored

    // Once the swap commits and the active vault path flips to B, loads work.
    setActiveVaultPath('/vault/B');
    documentStore.loadDocument(makeDoc('b1', 'b.md'));
    expect(documentStore.getDocument('b1')).toBeDefined();
  });

  it('adopts the live vault on first load when unbound (no swap fired — first open)', () => {
    setActiveVaultPath('/vault/X');
    documentStore.loadDocument(makeDoc('x1', 'x.md'));
    expect(documentStore.getDocument('x1')).toBeDefined();
  });

  it('allows loads after reopening the same vault (bound path === live path)', () => {
    setActiveVaultPath('/vault/A');
    documentStore.loadDocument(makeDoc('a1', 'a.md'));
    // Reopen the same vault: clear binds to A; live path stays A after commit.
    documentStore.clear('/vault/A');
    documentStore.loadDocument(makeDoc('a2', 'a2.md'));
    expect(documentStore.getDocument('a2')).toBeDefined();
  });

  it('returns the existing state on a repeat load of the same docId (idempotent)', () => {
    setActiveVaultPath('/vault/A');
    const first = documentStore.loadDocument(makeDoc('a1', 'a.md'));
    const second = documentStore.loadDocument(makeDoc('a1', 'a.md'));
    expect(second).toBe(first); // same object — short-circuits before the guard
    expect(documentStore.getDocument('a1')).toBeDefined();
  });
});
