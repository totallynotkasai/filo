import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore, type Command } from '@renderer/stores/history.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Regression cover for Phase 2.1 — `prompt-user` for an externally-deleted
 * file used to be silently dropped because `if (!next) continue;` short-
 * circuited the switch. With the file deleted on disk AND a dirty editor
 * open, the consumer must surface a persistent toast so the user can choose
 * between Reload (drop in-memory) and Keep local (re-create on disk).
 */

function clearToasts(): void {
  // Snapshot the array first — dismissToast filters in place.
  for (const t of [...uiStore.toasts]) {
    uiStore.dismissToast(t.id);
  }
}

describe('vaultExternalChanges — external delete + dirty editor', () => {
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
      // Unused by the slice — minimal stub to satisfy the VaultContext shape.
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
    };
    slice = makeExternalChangesSlice(ctx);

    writes = [];
    // Suppress reportError's console.error breadcrumb so the failing-write
    // test doesn't pollute the test output.
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
    installFiloMock((channel: string, ..._args: unknown[]) => {
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
    // updateContent flips isDirty=true; load alone is clean.
    documentStore.updateContent(opts.docId, `<p>${opts.body}</p>`, opts.body);
  }

  function installRecordingMock(handlerByChannel: Record<string, (...args: unknown[]) => unknown>): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      const h = handlerByChannel[channel];
      if (h) return h(...args);
      return { success: true };
    });
  }

  it('surfaces a persistent toast when the file is deleted externally and the editor is dirty', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'dirty', title: 'Notes' });

    // File is now missing.
    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();
    expect(toast?.type).toBe('warning');
    expect(toast?.duration).toBe(0);
    expect(toast?.actions).toHaveLength(2);
    expect(toast?.actions?.[0].label).toBe('Reload');
    expect(toast?.actions?.[1].label).toBe('Keep local');
  });

  it('does NOT silently re-create the deleted file (no write fires before user chooses)', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'dirty', title: 'Notes' });

    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // No write-file-text call should have fired yet — only the
    // applyChanges read calls.
    const recreationWrite = writes.find(
      (w) =>
        w.channel === 'vault:write-file-text' ||
        w.channel === 'vault:write-existing-file-text',
    );
    expect(recreationWrite).toBeUndefined();
  });

  it('Reload action drops the in-memory document', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'dirty', title: 'Notes' });

    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();
    expect(documentStore.getDocument('doc_A')).toBeDefined();

    // Invoke Reload.
    await toast?.actions?.[0].handler();

    expect(documentStore.getDocument('doc_A')).toBeUndefined();
  });

  it('Keep local action writes the file via vault:write-file-text with cached frontmatter + body', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'local body', title: 'Notes' });
    documentStore.setFrontmatter('doc_A', { tags: ['local-tag'] });

    installRecordingMock({
      'vault:read-file-text': () => ({ success: false }),
      'vault:write-file-text': () => ({ success: true }),
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();

    await toast?.actions?.[1].handler();

    // Filter for the file recreation specifically — `trackComponentWrite`
    // also fires `vault:write-file-text` for the `.filo/.dirty` sentinel.
    const write = writes.find(
      (w) => w.channel === 'vault:write-file-text' && w.args[1] === 'Notes.md',
    );
    expect(write).toBeDefined();
    expect(write?.args[0]).toBe('/vault');
    const body = write?.args[2] as string;
    expect(body).toContain('local body');
    expect(body).toContain('local-tag');

    expect(documentStore.getDocument('doc_A')?.isDirty).toBe(false);
  });

  it('Keep local routes write failures through errorBus.reportError', async () => {
    await primeIndexWith('Notes.md', '# Notes\nbody');
    loadDirtyEditor({ docId: 'doc_A', filename: 'Notes.md', body: 'local', title: 'Notes' });

    const reported: ReportedError[] = [];
    __resetErrorBusForTests();
    onError((e) => reported.push(e));

    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: false };
      // Only fail the file recreation, not the sentinel write — the sentinel
      // path is wrapped in a try/catch that swallows errors silently and
      // would obscure the failure surface under test.
      if (channel === 'vault:write-file-text' && args[1] === 'Notes.md') {
        return { success: false, error: 'EROFS' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    const toast = uiStore.toasts.find((t) => t.text.includes('deleted externally'));
    expect(toast).toBeDefined();

    await toast?.actions?.[1].handler();

    const reportedFailure = reported.find((e) =>
      (e.message ?? '').includes('Failed to re-create'),
    );
    expect(reportedFailure).toBeDefined();
    expect(reportedFailure?.context).toBe('vaultExternalChanges');
    // The doc remains dirty because the write didn't land.
    expect(documentStore.getDocument('doc_A')?.isDirty).toBe(true);
  });
});

describe('vaultExternalChanges — non-deleted decisions still flow', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
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
    };
    slice = makeExternalChangesSlice(ctx);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
  });

  it('ignore decisions do not surface a toast', async () => {
    // No editor open, no previous entry — classifier returns ignore.
    installFiloMock({
      'vault:read-file-text': () => ({ success: false }),
    });

    await slice.handleExternalMarkdownChanges(['Phantom.md']);

    expect(uiStore.toasts).toHaveLength(0);
  });
});

/**
 * Phase A.2b — sync-frontmatter `first-sight` does NOT call notePossiblyStale.
 *
 * The classifier returns `{ action: 'sync-frontmatter', reason: 'first-sight' }`
 * for every freshly-created tile (previousMetadata===null + no editor) — that's
 * bootstrap, not an external edit. Surfacing the "Earlier undo steps may no
 * longer match disk" toast for every newly-created file made the app
 * unusable. The fix is to only call `notePossiblyStale` when reason is
 * `'frontmatter-only'` (a real external metadata edit).
 */
describe('vaultExternalChanges — first-sight does NOT invalidate undo', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    historyStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    historyStore.setActiveBoard('board_test');
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
    };
    slice = makeExternalChangesSlice(ctx);
  });

  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    historyStore.setActiveBoard(null);
    historyStore.clear();
    clearToasts();
  });

  function pushDummyCommand(): void {
    // Minimal Command implementation so the notePossiblyStale gate has
    // prior history to act on. Without it, the gate short-circuits
    // regardless of reason — defeating the test.
    const cmd: Command = {
      description: 'dummy',
      execute() {},
      undo() {},
    };
    historyStore.pushWithoutExecute(cmd);
  }

  it('first-sight: no "External edit replaced" toast even with prior history', async () => {
    pushDummyCommand();
    expect(historyStore.canUndo).toBe(true);

    // First sighting: no editor open, previousMetadata === null. The file
    // is readable (next ≠ null), so classifier returns sync-frontmatter
    // with reason 'first-sight'.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: []\n---\nfresh body' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['NewTile.md']);

    const staleToast = uiStore.toasts.find((t) =>
      t.text.includes('External edit replaced'),
    );
    expect(staleToast).toBeUndefined();
  });

  it('frontmatter-only: DOES surface the "External edit replaced" toast', async () => {
    pushDummyCommand();

    // Seed the index so the next read produces previousMetadata !== null.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [a]\n---\nbody' };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Note.md']);

    // Now the watcher fires a frontmatter-only change (body same, tags changed).
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [a, b]\n---\nbody' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Note.md']);

    const staleToast = uiStore.toasts.find((t) =>
      t.text.includes('External edit replaced'),
    );
    expect(staleToast).toBeDefined();
  });
});
