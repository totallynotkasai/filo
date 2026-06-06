import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore, type Command } from '@renderer/stores/history.svelte';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import {
  __testRegisterFlusher,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  __clearRecentSelfWritesForTests,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
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
    // Audit-7 L15 — handleExternalMarkdownChanges now filters recent self-writes
    // internally; clear the module-global registry so a prior test's recreate
    // write (trackComponentWrite marks the path) doesn't suppress this test's
    // external-delete reconcile.
    __clearRecentSelfWritesForTests();
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

/**
 * 6.2.H1 — when `sync-frontmatter` lands, `originalFrontmatterCache` must
 * refresh to the post-sync raw bytes. The pre-fix bug: `setFrontmatter` was
 * called WITHOUT a `rawFrontmatter` argument, so the clean-bytes signal was
 * dropped but the baseline used by `patchFrontmatterSource` stayed at the
 * pre-sync bytes. A subsequent body-only save's diff would then see the
 * external editor's value as "different" and re-emit the node, losing any
 * YAML comment on the changed line.
 */
describe('vaultExternalChanges — 6.2.H1: sync-frontmatter refreshes originalFrontmatterSource', () => {
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

  it('refreshes originalFrontmatterSource to the post-sync raw bytes (preserving the new comment)', async () => {
    // Seed the index from disk so the next handleExternalMarkdownChanges sees
    // a real previous entry and the classifier returns frontmatter-only.
    const initial = '---\ntitle: Hello\npriority: low   # inline note\n---\nbody';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: initial };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Note.md']);

    // Seed the editor's frontmatter cache as a clean disk read would (the
    // hydrate path does this via setFrontmatter with rawFrontmatter).
    documentStore.loadDocument({
      docId: 'doc_H1',
      filename: 'Note.md',
      title: 'Note',
      body: 'body',
      htmlContent: '<p>body</p>',
      richText: [],
    });
    documentStore.setFrontmatter(
      'doc_H1',
      { title: 'Hello', priority: 'low' },
      'title: Hello\npriority: low   # inline note',
    );

    expect(documentStore.getOriginalFrontmatterSource('doc_H1')).toBe(
      'title: Hello\npriority: low   # inline note',
    );

    // External editor flips priority and keeps the inline comment.
    const updated = '---\ntitle: Hello\npriority: high   # inline note\n---\nbody';
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: updated };
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Note.md']);

    // Post-fix: the baseline reflects the post-sync raw bytes (still carrying
    // the inline comment). Pre-fix: it stayed at the pre-sync bytes, so a
    // body-only save's diff would re-emit `priority: high` and lose the
    // comment because the source the engine diffs against still said `low`.
    const baseline = documentStore.getOriginalFrontmatterSource('doc_H1');
    expect(baseline).toBeDefined();
    expect(baseline).toContain('priority: high');
    expect(baseline).toContain('# inline note');
  });
});

/**
 * Audit-7 H3 — the bulk "Keep all" handler used to `markDirty` each modified
 * doc and then `flushAllMarkdownWrites()`. But `markDirty` arms NO gateway
 * timer, and `flushAllMarkdownWrites` drains only pending/in-flight timers
 * (and test flushers via their `flush`) — it never iterates the force-writer
 * registry. So a doc whose 300ms debounce already fired during the prompt
 * window had nothing armed and the drain was a no-op: disk kept the external
 * content after the user chose "keep mine". The fix mirrors the single-file
 * Keep-local path — `forceWriteForDocument(docId)` per modified doc, which
 * reads the live editor body and commits even with no armed debounce.
 */
describe('vaultExternalChanges — bulk "Keep all" force-writes each modified doc (Audit-7 H3)', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;
  const COUNT = 6; // strictly > PROMPT_AGGREGATION_THRESHOLD (5) → bulk toast

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __resetMarkdownFileWriterForTests();
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
    __resetMarkdownFileWriterForTests();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
  });

  it('calls forceWriteForDocument for every modified doc (not the no-op flushAll)', async () => {
    const forceWritten: string[] = [];
    const flushed: string[] = [];
    const rels = Array.from({ length: COUNT }, (_, i) => `F${i}.md`);

    // Prime the index from disk so each file has a previous metadata entry.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: []\n---\noriginal body' };
      }
      return { success: true };
    });
    for (const rel of rels) await vaultIndexStore.applyChanges([rel]);

    // A DIRTY editor for each file + a registered force-writer with NO armed
    // debounce. The distinct `flush` / `forceWrite` capture lists let us assert
    // the Keep-all path used the force-write route, not the (pre-fix) flushAll.
    rels.forEach((rel, i) => {
      const docId = `doc_${i}`;
      documentStore.loadDocument({
        docId,
        filename: rel,
        title: rel,
        body: `local ${i}`,
        htmlContent: `<p>local ${i}</p>`,
        richText: [],
      });
      documentStore.updateContent(docId, `<p>local ${i}</p>`, `local ${i}`); // isDirty=true
      __testRegisterFlusher(
        `w_${i}`,
        async () => {
          flushed.push(docId);
        },
        {
          forceWrite: async () => {
            forceWritten.push(docId);
          },
          getDocId: () => docId,
        },
      );
    });

    // External edit every file — body differs from both the index and the
    // editor, so the classifier routes each to prompt-user (modified).
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: []\n---\nexternal body' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(rels);

    // Over the aggregation threshold → the single Reload all / Keep all toast.
    const toast = uiStore.toasts.find((t) => t.text.includes('changed externally'));
    expect(toast).toBeDefined();
    const keepAll = toast?.actions?.find((a) => a.label === 'Keep all');
    expect(keepAll).toBeDefined();

    keepAll!.handler();
    // forceWriteForDocument is async + fire-and-forget; let microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Every modified doc was force-written through its registered writer —
    // pre-fix `forceWritten` would be empty (flushAll uses `flush`, and no
    // debounce was armed).
    expect([...forceWritten].sort()).toEqual(rels.map((_, i) => `doc_${i}`).sort());
  });
});

/**
 * A8-H2(a) (Audit-8) — `handleExternalMarkdownChanges` captures the active
 * vault identity before its awaits (`whenBuildComplete` / `applyChanges`) and
 * bails if a vault swap lands during them. Without the guard, a swap mid-await
 * applies the OUTGOING vault's classification to the NEW vault's same-named
 * file — here, clobbering a clean editor's body with the other vault's content.
 * The whole per-file loop is synchronous, so the single post-`applyChanges`
 * check covers every sink.
 *
 * 🔍 Watch it fail first: remove the `if (!isStillSameVault(identity)) return;`
 * after `applyChanges` and the guard test below reloads the editor with the
 * external body just like the control test.
 */
describe('vaultExternalChanges — A8-H2(a): vault swap during applyChanges bails before clobbering', () => {
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeExternalChangesSlice>;

  function makeCtx(): VaultContext {
    return {
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
  }

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    clearToasts();
    // Clear pending/failed write-state too — a sibling test's markPathFailed
    // would otherwise make isPathPending(rel) true and the F4 guard would route
    // the change to a pending-write prompt instead of reload-silently.
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    vaultStore.setPath('/vault'); // bumps the vault-identity generation
    ctx = makeCtx();
    slice = makeExternalChangesSlice(ctx);
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

  function primeAndLoadCleanEditor(): void {
    documentStore.loadDocument({
      docId: 'doc_A',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'original body',
      htmlContent: '<p>original body</p>',
      richText: [],
    });
    // loadDocument alone leaves the editor CLEAN → reload-silently is eligible.
  }

  it('does NOT reload a clean editor when the vault swaps during applyChanges', async () => {
    // Prime the index with the original body so `previous` is non-null.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [a]\n---\noriginal body' };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);
    primeAndLoadCleanEditor();

    // The handler's own applyChanges re-reads CHANGED content; a vault swap
    // (same path, NEW generation) lands during that read.
    let swapped = false;
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        if (!swapped) {
          swapped = true;
          beginVaultGeneration('/vault'); // close→reopen: stale captured identity
        }
        return { success: true, content: '---\ntags: [a]\n---\nEXTERNAL CLOBBER' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // Guard bailed before the reload-silently sink: the clean editor still
    // shows the original body, not the other generation's external content.
    expect(documentStore.getDocument('doc_A')?.body).toBe('original body');
  });

  it('control: WITHOUT a swap, the same external change DOES reload the clean editor', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [a]\n---\noriginal body' };
      }
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Notes.md']);
    primeAndLoadCleanEditor();

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntags: [a]\n---\nEXTERNAL CLOBBER' };
      }
      return { success: true };
    });

    await slice.handleExternalMarkdownChanges(['Notes.md']);

    // No swap → the guard passes → reload-silently applies the external body.
    // This proves the guard test above isn't passing vacuously.
    expect(documentStore.getDocument('doc_A')?.body).toBe('EXTERNAL CLOBBER');
  });
});
