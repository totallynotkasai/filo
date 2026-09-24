import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-7 M1 — a successful gateway write clears THAT writer's dirty entry.
 *
 * Pre-fix the gateway never cleared `documentStore.dirtyWriters`, so a TextTile
 * that typed once stayed registered forever (only reload / unload / vault-swap
 * removed it). `DocumentState.isDirty` pinned true → the external-edit
 * classifier routed a now-saved file's edit to a spurious "modified externally"
 * prompt, and the reactive reload `$effect` (gated on `isWriterDirty`) never
 * picked up a sibling view's edits. The fix lives in `writeMarkdownFileImpl` so
 * it covers every gateway-backed editor write (TextTile + DocumentEditor) in one
 * place.
 */
function bodyWriteArgs(relPath: string, body: string): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: documentStore.getFrontmatter(relPath) ?? {},
    body,
    callerId: `text-tile:${relPath}`,
    notePath: relPath,
  };
}

describe('Audit-7 M1 — gateway clears the writer on a successful write', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    installFiloMock((channel: string) => {
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { ok: true, success: true };
    });
  });
  afterEach(() => {
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    restoreFiloDefault();
  });

  it('a keystroke-then-flush leaves the writer clean and the doc not dirty', async () => {
    const relPath = 'Notes/M1A.md';
    const callerId = `text-tile:${relPath}`;
    documentStore.loadDocument({
      filename: relPath,
      title: 'M1A',
      body: 'orig',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { title: 'M1A' }, 'title: M1A');
    markHydrated(relPath, false);

    // Keystroke registers the writer as dirty.
    documentStore.updateContent(relPath, '<p>x</p>', 'edited body', callerId);
    expect(documentStore.isWriterDirty(relPath, callerId)).toBe(true);
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(true);

    // A normal debounced write lands.
    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited body'));
    await flushMarkdownWrite(callerId);

    // M1 — the gateway's success path cleared this writer; the doc is clean.
    expect(documentStore.isWriterDirty(relPath, callerId)).toBe(false);
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(false);
  });

  it('clears only the writer that wrote — a dirty sibling keeps the doc dirty', async () => {
    const relPath = 'Notes/M1B.md';
    const textTile = `text-tile:${relPath}`;
    const docEditor = `document-editor:${relPath}`;
    documentStore.loadDocument({
      filename: relPath,
      title: 'M1B',
      body: 'orig',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { title: 'M1B' }, 'title: M1B');
    markHydrated(relPath, false);

    // Both views are dirty; only the TextTile flushes.
    documentStore.updateContent(relPath, '<p>x</p>', 'edited body', textTile);
    documentStore.markDirty(relPath, docEditor);
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(true);

    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited body'));
    await flushMarkdownWrite(textTile);

    // The flushing writer went clean; the still-dirty sibling keeps the doc dirty.
    expect(documentStore.isWriterDirty(relPath, textTile)).toBe(false);
    expect(documentStore.isWriterDirty(relPath, docEditor)).toBe(true);
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(true);
  });
});
