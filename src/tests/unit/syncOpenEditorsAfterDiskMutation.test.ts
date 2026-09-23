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
import {
  syncOpenEditorsAfterDiskMutation,
  writeMarkdownAndReconcile,
} from '@renderer/lib/vault/syncOpenEditorsAfterDiskMutation';
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

/**
 * Phase 6.6 — `writeMarkdownAndReconcile`: the coupled write+reconcile helper.
 *
 * The whole point is that the disk write and the open-editor reconcile read ONE
 * `path` argument, so the written path and the reconciled path cannot diverge —
 * the data-flow guarantee `ci:md-writers-reconcile-editors` could not prove
 * statically. These tests pin: the write targets the SAME path it reconciles;
 * `mode` selects full-reload vs frontmatter-only; `create` selects the channel;
 * and a FAILED write reconciles nothing (no editor convergence on bytes that
 * never landed).
 */
describe('Phase 6.6 — writeMarkdownAndReconcile', () => {
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

  it("writes via write-existing and reconciles the SAME path (mode: 'full')", async () => {
    const docId = 'doc-couple-full';
    const relPath = 'Notes/Couple.md';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Couple',
      body: 'old body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'Couple' }, '---\ntitle: Couple\n---');
    markHydrated(relPath, false);

    const after = '---\ntitle: Couple\nstatus: done\n---\nnew body\n';
    await writeMarkdownAndReconcile({ vaultRoot: '/vault', path: relPath, content: after, mode: 'full' });

    // The bytes hit the write-existing channel at the exact path.
    const write = captured.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(write?.args[1]).toBe(relPath);
    expect(write?.args[2]).toBe(after);
    // The reconcile took the SAME path's bytes: body + frontmatter both refreshed.
    expect(documentStore.getDocument(docId)?.body).toBe('new body\n');
    expect(documentStore.getFrontmatter(docId)).toEqual({ title: 'Couple', status: 'done' });
  });

  it('uses the create channel (vault:write-file-text) when create:true', async () => {
    const docId = 'doc-couple-create';
    const relPath = 'Notes/Created.md';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Created',
      body: 'x',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, {}, '');
    markHydrated(relPath, false);

    await writeMarkdownAndReconcile({
      vaultRoot: '/vault',
      path: relPath,
      content: '---\n---\nbody\n',
      mode: 'full',
      create: true,
    });

    expect(
      captured.some((c) => c.channel === 'vault:write-file-text' && c.args[1] === relPath),
    ).toBe(true);
    expect(captured.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(false);
  });

  it("frontmatter mode refreshes the FM cache only and preserves the editor body", async () => {
    const docId = 'doc-couple-fm';
    const relPath = 'Notes/FmOnly.md';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'FmOnly',
      body: 'unsaved edits',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'FmOnly' }, 'title: FmOnly');
    // Dirty in-memory edit — a full reload would clobber it; FM-only must not.
    documentStore.updateContent(docId, '<p>x</p>', 'unsaved edits', 'w1');
    markHydrated(relPath, false);

    await writeMarkdownAndReconcile({
      vaultRoot: '/vault',
      path: relPath,
      content: '---\ntitle: FmOnly\ntags:\n  - foo\n---\nstale disk body\n',
      mode: 'frontmatter',
    });

    // Body preserved (the unsaved edits), frontmatter cache took the new tag.
    expect(documentStore.getDocument(docId)?.body).toBe('unsaved edits');
    expect(documentStore.getFrontmatter(docId)).toEqual({ title: 'FmOnly', tags: ['foo'] });
  });

  it('reconciles only the editor on the written path, never a sibling', async () => {
    documentStore.loadDocument({
      docId: 'A',
      filename: 'A.md',
      title: 'A',
      body: 'body-A',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('A', {}, '');
    documentStore.loadDocument({
      docId: 'B',
      filename: 'B.md',
      title: 'B',
      body: 'body-B',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('B', {}, '');
    markHydrated('A.md', false);
    markHydrated('B.md', false);

    await writeMarkdownAndReconcile({ vaultRoot: '/vault', path: 'A.md', content: 'rewritten-A', mode: 'full' });

    // The reconcile is keyed to the SAME path the write targeted — B untouched.
    expect(documentStore.getDocument('A')?.body).toBe('rewritten-A');
    expect(documentStore.getDocument('B')?.body).toBe('body-B');
  });

  it('does NOT reconcile when the write fails (no convergence on bytes that never landed)', async () => {
    const docId = 'doc-couple-fail';
    const relPath = 'Notes/Fail.md';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Fail',
      body: 'pre-fail body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'Fail' }, '---\ntitle: Fail\n---');
    markHydrated(relPath, false);

    // The write channel rejects → trackComponentWrite re-throws → the helper
    // rejects BEFORE the reconcile runs.
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:write-existing-file-text') {
        return { success: false, error: 'EACCES', code: 'EACCES' };
      }
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { ok: true, success: true };
    });

    await expect(
      writeMarkdownAndReconcile({ vaultRoot: '/vault', path: relPath, content: 'never lands', mode: 'full' }),
    ).rejects.toThrow();

    // Editor untouched — it was never reconciled to bytes that didn't land.
    expect(documentStore.getDocument(docId)?.body).toBe('pre-fail body');
  });
});
