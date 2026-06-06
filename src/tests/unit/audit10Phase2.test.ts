import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import {
  markHydrated,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-10 H2 — a body-only editor save must never assemble against an EMPTY /
 * never-seeded FM cache.
 *
 * `TextTile.buildWriteArgs` sets `frontmatter: getFrontmatter(contentId) || {}`
 * and passes NO `frontmatterDelta`, so the gateway takes the cache-FM branch.
 * The TextTile "adopt sibling doc" branch flips hydrated=true WITHOUT seeding the
 * FM cache (re-parsing the body-only sibling body would yield {} and clobber the
 * real cache), so a docId reaches the gateway with no cache entry while the file
 * on disk still carries frontmatter. Pre-fix `fm` collapsed to `{}` and
 * `assembleMarkdownFile` emitted BODY ONLY — the on-disk YAML block was deleted.
 *
 * The fix re-reads disk IN-CHAIN when the cache is empty (`hasFrontmatter`
 * false) and the caller's args carry no FM (`argsFmEmpty`), seeds the cache, and
 * routes the assemble through the verbatim `rawFrontmatter` path. Reverting the
 * guard turns the "FM preserved" assertions red (body-only wipe).
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string; // (vaultRoot, relPath, fileText)
    }
  }
  return undefined;
}

function readCount(captured: Captured[]): number {
  return captured.filter((c) => c.channel === 'vault:read-file-text').length;
}

describe('Audit-10 H2 — body-only save with an empty FM cache re-reads disk', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    captured = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    restoreFiloDefault();
    cancelAllMarkdownWrites();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    vi.restoreAllMocks();
  });

  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 5, size: content.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: content.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  }

  it('preserves the on-disk YAML block (the adoption-branch wipe is closed)', async () => {
    const relPath = 'Adopted.md';
    const docId = 'doc-adopt';
    // `emptyKey:` is a present-but-empty key — the kind a body-only wipe would
    // also silently destroy; assert it survives too.
    const disk = '---\ntitle: Keep\ntags:\n  - x\n  - y\nemptyKey:\n---\nold body\n';
    installDisk(disk);
    markHydrated(relPath, false);
    // Model the adoption branch: hydrated, but NO FM seeded into the cache.
    expect(documentStore.hasFrontmatter(docId)).toBe(false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {}, // body-only editor path: getFrontmatter() || {} → {}
      body: 'new body\n',
      callerId: `text-tile:${docId}`,
      docId,
      // no frontmatterDelta — exercises the cache-FM branch
    });

    const written = lastWrite(captured)!;
    expect(written).toContain('title: Keep'); // FM preserved (pre-fix: wiped)
    expect(written).toContain('- x');
    expect(written).toContain('- y');
    expect(written).toContain('emptyKey:'); // present-but-empty key survives
    expect(written).toContain('new body'); // body updated
    expect(written).not.toContain('old body');
    // The cache-empty re-read fired exactly once.
    expect(readCount(captured)).toBe(1);
    // And it seeded the cache so later saves + the display see the real FM.
    expect(documentStore.hasFrontmatter(docId)).toBe(true);
    expect(documentStore.getFrontmatter(docId)?.title).toBe('Keep');
  });

  it('a seeded FM cache is trusted — no re-read, FM preserved from the cache', async () => {
    const relPath = 'Seeded.md';
    const docId = 'doc-seeded';
    installDisk('---\ntitle: Seeded\ntags:\n  - a\n---\nbody\n');
    // A normally-hydrated doc: the cache holds the real FM, so buildWriteArgs
    // threads it (non-empty) — the H2 re-read must NOT engage.
    documentStore.setFrontmatter(docId, { title: 'Seeded', tags: ['a'] }, 'title: Seeded\ntags:\n  - a');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { title: 'Seeded', tags: ['a'] },
      body: 'new body\n',
      callerId: `text-tile:${docId}`,
      docId,
    });

    const written = lastWrite(captured)!;
    expect(written).toContain('title: Seeded');
    expect(written).toContain('- a');
    expect(written).toContain('new body');
    // No re-read — the happy path stays a pure write.
    expect(readCount(captured)).toBe(0);
  });

  it('a deliberate empty-FM seed is trusted — no re-read (never-seeded vs {} distinction)', async () => {
    const relPath = 'EmptySeed.md';
    const docId = 'doc-empty-seed';
    installDisk('---\ntitle: OnDisk\n---\nbody\n');
    // Deliberate empty seed (the no-vault / embedded-content fallback parsed a
    // body with no FM). `hasFrontmatter` is true, so the guard trusts it and does
    // NOT re-read — locking the never-seeded-vs-deliberate-`{}` distinction.
    documentStore.setFrontmatter(docId, {});
    expect(documentStore.hasFrontmatter(docId)).toBe(true);
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'new body\n',
      callerId: `text-tile:${docId}`,
      docId,
    });

    expect(readCount(captured)).toBe(0); // guard skipped the re-read
    expect(lastWrite(captured)).toContain('new body');
  });

  it('a docId-less legacy write is unaffected (no re-read, body-only)', async () => {
    // The H2 guard is docId-gated; a docId-less write keeps its prior behaviour.
    const relPath = 'Legacy.md';
    installDisk('---\ntitle: Legacy\n---\nbody\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'new body\n',
      callerId: 'legacy-caller',
      docId: null,
    });

    expect(readCount(captured)).toBe(0);
    expect(lastWrite(captured)).toContain('new body');
  });
});
