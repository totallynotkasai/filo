import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  registerForceWriter,
  unregisterForceWriter,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { syncOpenEditorsAfterDiskMutation } from '@renderer/lib/vault/syncOpenEditorsAfterDiskMutation';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 6.1.R1 — `syncOpenEditorsAfterDiskMutation` helper.
 *
 * Verifies the contract three disk-mutation-then-restore sites depend on:
 *   - For each (path, content) in `items` that has an open editor, the
 *     editor's body + frontmatter are replaced with the parsed bytes.
 *   - Any armed body writer for that docId is cancelled (the bug class —
 *     a still-armed timer would otherwise fire ~300 ms later carrying the
 *     pre-mutation body and silently revert the write). This guarantee is
 *     inherited from `applyReloadFromDisk`'s self-cancel (Phase 6.0.C2);
 *     the helper does not add a separate cancel.
 *   - A path without an open editor is a no-op (no throw).
 *   - The helper does NOT touch other documents.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWriteContent(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function makeArgs(
  docId: string,
  relPath: string,
  fm: Record<string, unknown>,
  body: string,
): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: fm,
    body,
    callerId: `text-tile:${docId}`,
    docId,
  };
}

describe('Phase 6.1.R1 — syncOpenEditorsAfterDiskMutation', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
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

  it('replaces an open editor body with the mutated bytes', () => {
    const docId = 'doc-helper-1';
    const relPath = 'Notes/A.md';

    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'A',
      body: 'pre-mutation body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'A' }, '---\ntitle: A\n---');
    markHydrated(relPath, false);

    const after = '---\ntitle: A\nstatus: updated\n---\npost-mutation body\n';
    syncOpenEditorsAfterDiskMutation([{ path: relPath, content: after }]);

    const doc = documentStore.getDocument(docId);
    expect(doc?.body).toBe('post-mutation body\n');
    const fm = documentStore.getFrontmatter(docId);
    expect(fm).toEqual({ title: 'A', status: 'updated' });
  });

  it('cancels an armed body writer so the post-mutation bytes are not reverted', async () => {
    const docId = 'doc-helper-cancel';
    const relPath = 'Notes/B.md';
    const callerId = `text-tile:${docId}`;

    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'B',
      body: 'old',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'B' }, '---\ntitle: B\n---');
    markHydrated(relPath, false);

    // Editor-backed writer registers a force-writer; the cancel helper inside
    // applyReloadFromDisk matches against this registry to find writers to disarm.
    registerForceWriter(callerId, docId, () => null);

    // User typed → debounced body write armed with the PRE-mutation body.
    scheduleMarkdownWrite(makeArgs(docId, relPath, { title: 'B' }, 'pre-mutation typed body'));

    // We just wrote disk authoritatively; sync the open editor.
    syncOpenEditorsAfterDiskMutation([
      { path: relPath, content: '---\ntitle: B\n---\nauthoritative new bytes\n' },
    ]);

    // Drain any pending writers. With the cancel, the armed timer was disarmed
    // before this flush — nothing fires. Without it, the pre-mutation body
    // would land on disk and silently revert our authoritative write.
    await flushMarkdownWrite(callerId);

    unregisterForceWriter(callerId);

    const written = lastWriteContent(captured);
    expect(written ?? '').not.toContain('pre-mutation typed body');
    expect(written).toBeUndefined();
  });

  it('is a no-op for a path without an open editor', () => {
    const otherDoc = 'doc-helper-other';
    documentStore.loadDocument({
      docId: otherDoc,
      filename: 'Other.md',
      title: 'Other',
      body: 'untouched',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(otherDoc, {}, '');

    // No editor for 'Missing.md' — helper must not throw and must not affect
    // unrelated documents.
    expect(() =>
      syncOpenEditorsAfterDiskMutation([{ path: 'Missing.md', content: '# anything\n' }]),
    ).not.toThrow();

    expect(documentStore.getDocument(otherDoc)?.body).toBe('untouched');
  });

  it('only syncs editors whose filename matches the item path', () => {
    const docA = 'doc-helper-a';
    const docB = 'doc-helper-b';
    documentStore.loadDocument({
      docId: docA,
      filename: 'A.md',
      title: 'A',
      body: 'body-a',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docA, {}, '');
    documentStore.loadDocument({
      docId: docB,
      filename: 'B.md',
      title: 'B',
      body: 'body-b',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docB, {}, '');
    markHydrated('A.md', false);
    markHydrated('B.md', false);

    syncOpenEditorsAfterDiskMutation([{ path: 'A.md', content: 'rewritten-a' }]);

    expect(documentStore.getDocument(docA)?.body).toBe('rewritten-a');
    expect(documentStore.getDocument(docB)?.body).toBe('body-b');
  });
});
