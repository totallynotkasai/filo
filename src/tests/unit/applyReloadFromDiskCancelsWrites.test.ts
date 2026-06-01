import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  markHydrated,
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  cancelAllMarkdownWrites,
  registerForceWriter,
  unregisterForceWriter,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { documentStore } from '@renderer/stores/document.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 6.0.C2 — `applyReloadFromDisk` must cancel pending markdown body
 * writes for the doc BEFORE replacing in-memory state.
 *
 * Mechanism: `scheduleMarkdownWrite` captures `args.body` by closure at
 * schedule time. `writeMarkdownFile` reads frontmatter live from
 * `documentStore.getFrontmatter(docId)` but reads body from that frozen
 * snapshot. ~250 ms after a Reload, the timer fires with
 * `{post-Reload FM, pre-Reload body}` and silently inverts the Reload —
 * the external edit on disk is overwritten by the user's typed body the
 * Reload was supposed to discard.
 *
 * The fix calls `cancelMarkdownWritesForDocument(docId)` as the first
 * line of `applyReloadFromDisk`. The cancel matches the writer via the
 * force-writer registry (same identity `forceWriteForDocument` uses), so
 * only editor-backed writers are affected.
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

describe('Phase 6.0.C2 — applyReloadFromDisk cancels armed body writes', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
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
    restoreFiloDefault();
  });

  it('cancels a body write armed before the Reload (FM also changed)', async () => {
    const docId = 'doc-c2';
    const relPath = 'Notes/C2.md';
    const callerId = `text-tile:${docId}`;

    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'C2',
      body: 'pre-reload body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(
      docId,
      { title: 'C2', status: 'draft' },
      '---\ntitle: C2\nstatus: draft\n---',
    );
    markHydrated(relPath, false);

    // TextTile / DocumentEditor register a force-writer on mount; the cancel
    // helper matches against this registry to find writers to disarm.
    registerForceWriter(callerId, docId, () => null);

    // Simulate a keystroke that schedules a body write whose args carry the
    // PRE-RELOAD body. Without the fix this timer fires ~250 ms after the
    // Reload and writes the typed body to disk, silently inverting it.
    scheduleMarkdownWrite(
      makeArgs(docId, relPath, { title: 'C2', status: 'draft' }, 'pre-reload typed body'),
    );

    // External writer flipped disk to the post-Reload bytes; the classifier
    // calls applyReloadFromDisk with the disk truth.
    await documentStore.applyReloadFromDisk(
      docId,
      'POST-RELOAD-DISK-BODY',
      [],
      { title: 'C2', status: 'published' },
    );

    // Drain anything still pending. With the cancel in place, the timer was
    // disarmed before this flush and nothing fires; without it, flush forces
    // the captured pre-reload body onto disk.
    await flushMarkdownWrite(callerId);

    unregisterForceWriter(callerId);

    const written = lastWriteContent(captured);
    expect(written ?? '').not.toContain('pre-reload typed body');
    expect(written).toBeUndefined();
  });
});
