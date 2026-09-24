import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  markHydrated,
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { documentStore } from '@renderer/stores/document.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit2 2.5 — a debounced body write captures its frontmatter from the live
 * cache at SCHEDULE time. If the frontmatter cache is then updated before the
 * write fires (an external frontmatter-only edit reconciled into the cache, a
 * PropertiesPopup / TaskList mutation, a cross-board flush), the write must
 * emit the LIVE frontmatter at fire time — not the stale snapshot frozen into
 * its args — or it silently clobbers the newer metadata.
 *
 * The frontmatter cache is the documented source of truth (documentStore),
 * so the body writer reads it live at fire time.
 */

interface Captured { channel: string; args: unknown[]; }

function lastWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string; // (vaultRoot, relPath, fileText)
    }
  }
  return undefined;
}

function makeArgs(relPath: string, frontmatter: Record<string, unknown>): WriteArgs {
  return { vaultRoot: '/vault', relPath, frontmatter, body: 'the body', callerId: `text-tile:${relPath}`, notePath: relPath };
}

describe('markdownFileWriter — body write emits LIVE frontmatter at fire time (audit2 2.5)', () => {
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

  it('a frontmatter mutation after schedule survives the armed body write', async () => {
    const relPath = 'Notes/A.md';
    documentStore.loadDocument({ filename: relPath, title: 'A', body: 'the body', htmlContent: '', richText: [] });
    // Seed the live cache from disk (with verbatim raw bytes, as a hydrate
    // does). `rawFrontmatter` is the source BETWEEN the `---` fences — no fences,
    // exactly what `parseMarkdownFile` produces — so the baseline is parseable
    // (a fenced `---…---` string parses as a multi-document YAML).
    documentStore.setFrontmatter(relPath, { status: 'draft' }, 'status: draft');
    markHydrated(relPath, false);

    // Body keystroke arms a write — args froze the OLD frontmatter snapshot.
    scheduleMarkdownWrite(makeArgs(relPath, { status: 'draft' }));

    // An external frontmatter-only edit is reconciled into the live cache
    // (documentStore.setFrontmatter — what vaultExternalChanges' sync path and
    // the reload handler do). No raw bytes → the verbatim passthrough is
    // invalidated, so the write must re-emit from the (live) object.
    documentStore.setFrontmatter(relPath, { status: 'published' });

    await flushMarkdownWrite(`text-tile:${relPath}`);

    const written = lastWrite(captured);
    expect(written).toBeDefined();
    // The external metadata edit must survive — not be clobbered by the stale snapshot.
    expect(written).toContain('published');
    expect(written).not.toContain('draft');
  });
});
