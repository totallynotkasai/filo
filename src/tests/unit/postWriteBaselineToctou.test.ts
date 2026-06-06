import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { getBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-7 L5 — post-write baseline re-stat TOCTOU.
 *
 * The gateway writes the file, then runs a SEPARATE `vault:stat` to refresh the
 * drift baseline. An external edit landing between the write IPC resolving and
 * the stat IPC resolving would make `postStat` reflect FOREIGN (mtime,size);
 * stamping that poisons the baseline so the NEXT write's drift check matches and
 * silently overwrites the external edit. The fix compares the post-write stat's
 * size against the exact UTF-8 byte length just written: a mismatch means the
 * stat observed someone else's write, so the baseline is NOT stamped (kept,
 * per DI-14) and the next write re-detects the drift instead.
 */
function bodyWriteArgs(docId: string, relPath: string, body: string): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: documentStore.getFrontmatter(docId) ?? {},
    body,
    callerId: `text-tile:${docId}`,
    docId,
  };
}

describe('Audit-7 L5 — post-write baseline TOCTOU guard', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
  });
  afterEach(() => {
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    documentStore.clear();
    restoreFiloDefault();
  });

  function setup(docId: string, relPath: string): void {
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'T',
      body: 'orig',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { title: 'T' }, 'title: T');
    // No mtime → no baseline seeded, so the ONLY vault:stat is the post-write one.
    markHydrated(relPath, false);
  }

  it('does NOT stamp the baseline when the post-write stat size differs from the bytes written', async () => {
    const docId = 'doc-l5-a';
    const relPath = 'Notes/L5A.md';
    const callerId = `text-tile:${docId}`;
    setup(docId, relPath);

    installFiloMock((channel: string) => {
      if (channel === 'vault:write-existing-file-text') return { ok: true, success: true };
      if (channel === 'vault:stat') {
        // Post-write stat observed a FOREIGN edit that grew the file — its
        // size can't match the small note we wrote.
        return { ok: true, mtimeMs: 999, size: 10_000_000 };
      }
      return { ok: true, success: true };
    });

    documentStore.updateContent(docId, '<p>x</p>', 'edited body', callerId);
    scheduleMarkdownWrite(bodyWriteArgs(docId, relPath, 'edited body'));
    await flushMarkdownWrite(callerId);

    // Size mismatch → the foreign (mtime,size) is rejected. No prior baseline
    // existed (markHydrated had no mtime), so it stays absent — NOT poisoned.
    expect(getBaseline(relPath)).toBeUndefined();
  });

  it('stamps the baseline to the post-write stat when its size matches the bytes written', async () => {
    const docId = 'doc-l5-b';
    const relPath = 'Notes/L5B.md';
    const callerId = `text-tile:${docId}`;
    setup(docId, relPath);

    let writtenBytes = 0;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:write-existing-file-text') {
        writtenBytes = new TextEncoder().encode(String(args[2])).length;
        return { ok: true, success: true };
      }
      // Clean self-write: the post-write stat reflects exactly our bytes.
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 4242, size: writtenBytes };
      return { ok: true, success: true };
    });

    documentStore.updateContent(docId, '<p>x</p>', 'edited body', callerId);
    scheduleMarkdownWrite(bodyWriteArgs(docId, relPath, 'edited body'));
    await flushMarkdownWrite(callerId);

    expect(getBaseline(relPath)).toEqual({ mtimeMs: 4242, size: writtenBytes });
    expect(writtenBytes).toBeGreaterThan(0);
  });
});
