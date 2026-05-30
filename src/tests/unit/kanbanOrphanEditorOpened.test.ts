import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/kanbanCommands';
import { historyStore } from '@renderer/stores/history.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import {
  registerForceWriter,
  __resetMarkdownFileWriterForTests,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';

// ── Stubs ──

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

interface FileMap {
  [path: string]: string;
}

function installFiloStub(filesystem: FileMap): void {
  const routes: Record<string, InvokeHandler> = {
    'vault:read-file-text': async (_vaultRoot: unknown, relPath: unknown) => {
      const p = String(relPath);
      const content = filesystem[p];
      if (content === undefined) return { success: false, error: 'ENOENT', code: 'ENOENT' };
      return { success: true, content };
    },
    'vault:write-existing-file-text': async (_vaultRoot: unknown, relPath: unknown, content: unknown) => {
      filesystem[String(relPath)] = String(content);
      return { success: true };
    },
    'vault:stat': async () => ({ success: true, mtimeMs: 0, sizeBytes: 0 }),
  };
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return { success: false, error: `unknown: ${channel}`, code: 'EUNKNOWN' };
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function seedVault(): void {
  Object.defineProperty(vaultStore, 'path', { configurable: true, get: () => '/vault' });
}

beforeEach(() => {
  vaultIndexStore.clear();
  boardCacheStore.clear();
  historyStore.clear();
  documentStore.clear();
  __resetMarkdownFileWriterForTests();
  seedVault();
});

afterEach(() => {
  delete (vaultStore as unknown as Record<string, unknown>).path;
  documentStore.clear();
  __resetMarkdownFileWriterForTests();
});

// ── Test ──

describe('UpdateOrphanFrontmatterCommand — editor opened between execute and undo (audit 2.2)', () => {
  it('routes undo through the live editor cache when a doc was opened after execute', async () => {
    const REL = 'Tasks/card.md';
    const filesystem: FileMap = { [REL]: '---\ntitle: Card\n---\nBody' };
    installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata(REL, parseMarkdown(REL, filesystem[REL]));

    // patch adds a due date; inverse removes it (empty string == delete key,
    // matching how the orphan merge and mergeFrontmatter clean fields).
    const cmd = new UpdateOrphanFrontmatterCommand('kb', REL, { due: '2026-06-01' }, { due: '' });

    // 1) Execute while the card is an orphan (no editor open) — blind disk write.
    await cmd.execute();
    expect(filesystem[REL]).toContain('due:');
    expect(filesystem[REL]).toContain('2026-06-01');

    // 2) The user now opens the card's file as a Document. A live session +
    //    force-writer appears, with the frontmatter cache mirroring disk.
    const docId = 'doc-card';
    documentStore.loadDocument({
      docId,
      filename: REL,
      title: 'Card',
      body: 'Body',
      htmlContent: '<p>Body</p>',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'Card', due: '2026-06-01' });
    const callerId = 'document-editor:doc-card';
    const buildArgs = (): WriteArgs => ({
      vaultRoot: '/vault',
      relPath: REL,
      frontmatter: documentStore.getFrontmatter(docId) ?? {},
      body: 'Body',
      callerId,
      docId,
    });
    registerForceWriter(callerId, docId, buildArgs);

    // 3) Undo. The fix must apply the inverse through the LIVE cache (so the
    //    open editor doesn't re-clobber it), not a blind disk write the
    //    editor's next debounce would revert.
    await cmd.undo();

    // The live frontmatter cache reflects the inverse (due removed). Without
    // the fix this still reads `due: 2026-06-01`, and the editor's next write
    // would re-add it — silently reverting the undo.
    const fm = documentStore.getFrontmatter(docId) ?? {};
    expect(fm.due).toBeUndefined();
    // Disk is consistent with the editor's view too.
    expect(filesystem[REL]).not.toContain('2026-06-01');
  });
});
