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
 * `documentStore.getFrontmatter(path)` but reads body from that frozen
 * snapshot. ~250 ms after a Reload, the timer fires with
 * `{post-Reload FM, pre-Reload body}` and silently inverts the Reload —
 * the external edit on disk is overwritten by the user's typed body the
 * Reload was supposed to discard.
 *
 * The fix calls `cancelMarkdownWritesForDocument(path)` as the first
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
  relPath: string,
  fm: Record<string, unknown>,
  body: string,
): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: fm,
    body,
    callerId: `text-tile:${relPath}`,
    notePath: relPath,
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
    const relPath = 'Notes/C2.md';
    const callerId = `text-tile:${relPath}`;

    documentStore.loadDocument({
      filename: relPath,
      title: 'C2',
      body: 'pre-reload body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(
      relPath,
      { title: 'C2', status: 'draft' },
      '---\ntitle: C2\nstatus: draft\n---',
    );
    markHydrated(relPath, false);

    // TextTile / DocumentEditor register a force-writer on mount; the cancel
    // helper matches against this registry to find writers to disarm.
    registerForceWriter(callerId, relPath, () => null);

    // Simulate a keystroke that schedules a body write whose args carry the
    // PRE-RELOAD body. Without the fix this timer fires ~250 ms after the
    // Reload and writes the typed body to disk, silently inverting it.
    scheduleMarkdownWrite(
      makeArgs(relPath, { title: 'C2', status: 'draft' }, 'pre-reload typed body'),
    );

    // External writer flipped disk to the post-Reload bytes; the classifier
    // calls applyReloadFromDisk with the disk truth.
    await documentStore.applyReloadFromDisk(
      relPath,
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

  // Phase 6.0.C3 — same primitive as C2; the audit surfaced it as a
  // separate item to make clear the bug is NOT gated by frontmatter sync.
  // A body-only edit followed by an external Reload (no newFrontmatter
  // argument) still hits the closure-captured pre-Reload body. The fix
  // landed in 6.0.C2 (applyReloadFromDisk self-cancels); this test pins
  // the body-only path so a future regression that breaks it without
  // also breaking the FM-changed path still trips here.
  it('cancels a body write armed before a body-only Reload (no newFrontmatter — covers 6.0.C3)', async () => {
    const relPath = 'Notes/C3.md';
    const callerId = `text-tile:${relPath}`;

    documentStore.loadDocument({
      filename: relPath,
      title: 'C3',
      body: 'pre-reload body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(
      relPath,
      { title: 'C3' },
      '---\ntitle: C3\n---',
    );
    markHydrated(relPath, false);

    registerForceWriter(callerId, relPath, () => null);

    scheduleMarkdownWrite(
      makeArgs(relPath, { title: 'C3' }, 'pre-reload typed body c3'),
    );

    // Body-only Reload: applyReloadFromDisk receives no newFrontmatter.
    // The cancel must still fire — the bug is independent of whether the
    // reload also carries a frontmatter update.
    documentStore.applyReloadFromDisk(relPath, 'POST-RELOAD-DISK-BODY-C3', []);

    await flushMarkdownWrite(callerId);

    unregisterForceWriter(callerId);

    const written = lastWriteContent(captured);
    expect(written ?? '').not.toContain('pre-reload typed body c3');
    expect(written).toBeUndefined();
  });
});
