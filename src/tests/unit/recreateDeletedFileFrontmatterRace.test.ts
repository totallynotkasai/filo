/**
 * Phase B / B.5 — Keep-local handler must preserve frontmatter even if
 * the doc was unloaded between toast-open and click.
 *
 * Before this fix:
 *   - The toast captured `editorDoc = { docId, title, body }` into the
 *     action closure.
 *   - The Keep-local handler called `recreateDeletedFile(rel, editorDoc,
 *     ctx)`, which read frontmatter via `documentStore.getFrontmatter
 *     (editorDoc.docId) ?? {}`.
 *   - If a parallel flow (vault swap, tab close) unloaded the doc
 *     between the toast appearing and the user clicking Keep local,
 *     `getFrontmatter` returned undefined → empty `{}` → the file was
 *     re-created body-only, losing tags / aliases / properties.
 *
 * After this fix:
 *   - Toast-open captures `fmSnapshot` + `bodySnapshot` into the
 *     closure.
 *   - Keep-local prefers live state when the doc is still loaded; falls
 *     back to the snapshot when the doc was unloaded.
 *   - If neither is available (defence in depth), a confirm dialog
 *     fires asking the user whether to recreate body-only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) {
    uiStore.dismissToast(t.id);
  }
}

describe('recreateDeletedFile — frontmatter race (Phase B.5)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  let writes: Array<{ channel: string; args: unknown[] }>;

  beforeEach(async () => {
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');

    ctx = {
      getVaultPath: () => '/vault',
      setVaultPath: () => {},
      getFileTree: () => [],
      setFileTree: () => {},
      getSearchQuery: () => '',
      setSearchQuery: () => {},
      getIsLoading: () => false,
      setIsLoading: () => {},
      getExpandedFolders: () => new Set(),
      setExpandedFolders: () => {},
      getSelectedPaths: () => new Set(),
      setSelectedPaths: () => {},
      getProject: () => null,
      setProject: () => {},
      getRecoveryPendingPaths: () => [],
      setRecoveryPendingPaths: () => {},
      markMetaDirty: () => {},
      refreshTree: async () => {},
      clearSelection: () => {},
      clearActiveRootFolderIfMatches: () => {},
    } as VaultContext;
    slice = makeExternalChangesSlice(ctx);

    writes = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    vi.restoreAllMocks();
  });

  async function primeIndexWith(rel: string, content: string): Promise<void> {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content };
      return { success: true };
    });
    await vaultIndexStore.applyChanges([rel]);
  }

  function loadDirtyEditor(opts: {
    docId: string;
    filename: string;
    body: string;
    title: string;
  }): void {
    documentStore.loadDocument({
      docId: opts.docId,
      filename: opts.filename,
      title: opts.title,
      body: opts.body,
      htmlContent: `<p>${opts.body}</p>`,
      richText: [],
    });
    documentStore.updateContent(opts.docId, `<p>${opts.body}</p>`, opts.body);
  }

  function installRecordingMock(
    handlerByChannel: Record<string, (...args: unknown[]) => unknown>,
  ): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      const h = handlerByChannel[channel];
      if (h) return h(...args);
      return { success: true };
    });
  }

  it('Keep local uses live state when doc is still loaded (regression guard)', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'local body', title: 'Notes' });
    documentStore.setFrontmatter('doc_A', { tags: ['live-tag'] });

    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
      'vault:write-file-text': () => ({ success: true }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();

    // Doc still loaded — Keep local should write with the LIVE
    // frontmatter (which equals the snapshot in this case).
    await toast?.actions?.[1].handler();

    const write = writes.find(
      (w) => w.channel === 'vault:write-file-text' && w.args[1] === 'Notes.md',
    );
    expect(write).toBeDefined();
    const body = write?.args[2] as string;
    expect(body).toContain('live-tag');
    expect(body).toContain('local body');
  });

  it('Keep local falls back to snapshot when doc was unloaded between toast-open and click', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'snapshot body', title: 'Notes' });
    documentStore.setFrontmatter('doc_A', { tags: ['snapshot-tag'] });

    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
      'vault:write-file-text': () => ({ success: true }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();

    // Simulate a parallel flow (e.g. tab close) that unloads the doc
    // between toast-open and Keep-local-click.
    documentStore.unloadDocument('doc_A');

    await toast?.actions?.[1].handler();

    // Without B.5, the write would land body-only because
    // getFrontmatter('doc_A') is undefined and the fallback to `{}`
    // strips the tag. With B.5, the snapshot keeps the tag alive.
    const write = writes.find(
      (w) => w.channel === 'vault:write-file-text' && w.args[1] === 'Notes.md',
    );
    expect(write).toBeDefined();
    const body = write?.args[2] as string;
    expect(body).toContain('snapshot-tag');
    expect(body).toContain('snapshot body');
  });

  it('Keep local prefers user edits made between toast-open and click (live wins over snapshot)', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'original', title: 'Notes' });
    documentStore.setFrontmatter('doc_A', { tags: ['original-tag'] });

    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
      'vault:write-file-text': () => ({ success: true }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();

    // User edits the doc AFTER the toast appeared but BEFORE clicking
    // Keep local. The live state should win.
    documentStore.setFrontmatter('doc_A', { tags: ['edited-tag'] });

    await toast?.actions?.[1].handler();

    const write = writes.find(
      (w) => w.channel === 'vault:write-file-text' && w.args[1] === 'Notes.md',
    );
    expect(write).toBeDefined();
    const body = write?.args[2] as string;
    expect(body).toContain('edited-tag');
  });
});
