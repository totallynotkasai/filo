import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  rewriteTagInAllMarkdown,
  __resetTagRewriteSweepForTests,
} from '@renderer/lib/vault/tagRewriteSweep';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import { documentStore } from '@renderer/stores/document.svelte';
import { markHydrated, cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';

/**
 * Phase 6.1.R1 — `tagRewriteSweep` syncs open editors with the rewritten
 * bytes after the write loop succeeds.
 *
 * Without this, an open TextTile or DocumentEditor on a sweep-rewritten file
 * keeps its pre-rewrite body in memory. The next debounced write — whose
 * `args.body` was closure-captured before the rewrite — fires ~300 ms later
 * and silently reverts the rewrite. The fix routes the (path, content) list
 * for every successful sweep write through `syncOpenEditorsAfterDiskMutation`,
 * which goes through `applyReloadFromDisk` (self-cancelling per 6.0.C2).
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

interface FakeFs {
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
}

function installFiloStub(fs: FakeFs): void {
  const routes: Record<string, InvokeRoute> = {
    'vault:read-file-text': async (_root: unknown, relPath: unknown) => {
      const content = fs.files.get(relPath as string);
      if (content === undefined) return { success: false, code: 'ENOENT' };
      return { success: true, content };
    },
    'vault:file-exists': async (_root: unknown, relPath: unknown) =>
      fs.files.has(relPath as string),
    'vault:write-file-text': async (_root: unknown, relPath: unknown, content: unknown) => {
      fs.files.set(relPath as string, content as string);
      return { success: true };
    },
    'vault:write-existing-file-text': async (
      _root: unknown,
      relPath: unknown,
      content: unknown,
    ) => {
      fs.files.set(relPath as string, content as string);
      fs.writes.push({ path: relPath as string, content: content as string });
      return { success: true };
    },
    'vault:stat': async () => ({ ok: true, mtimeMs: 1, size: 1 }),
    'vault:delete': async () => ({ success: true }),
  };
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return { success: false };
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function makeMetadata(path: string, tag: string): FileMetadata {
  return {
    path,
    title: path,
    headings: [],
    tags: [tag],
    frontmatter: { tags: [tag] },
    links: [],
    content: '',
    lastModified: 0,
  };
}

describe('tagRewriteSweep — syncs open editors (Phase 6.1.R1)', () => {
  let fs: FakeFs;

  beforeEach(() => {
    fs = { files: new Map(), writes: [] };
    installFiloStub(fs);
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
  });

  afterEach(() => {
    uninstallFiloStub();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
  });

  it("an open editor's body reflects the rewritten tag after the sweep", async () => {
    const relPath = 'notes.md';
    const before = `---\ntags:\n  - draft\n---\nA note tagged draft.\n`;
    const after = `---\ntags:\n  - review\n---\nA note tagged draft.\n`;
    fs.files.set(relPath, before);

    documentStore.loadDocument({
      filename: relPath,
      title: 'notes',
      body: 'A note tagged draft.\n',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(
      relPath,
      { tags: ['draft'] },
      '---\ntags:\n  - draft\n---',
    );
    markHydrated(relPath, false);

    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: [makeMetadata(relPath, 'draft')],
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(result.succeeded).toEqual([relPath]);
    expect(result.failed).toEqual([]);
    expect(fs.files.get(relPath)).toBe(after);

    // Phase 6.1.R1 — the sweep MUST have synced the open editor with the new
    // bytes. Frontmatter cache now carries the renamed tag; body is unchanged.
    const fm = documentStore.getFrontmatter(relPath);
    expect(fm).toEqual({ tags: ['review'] });
    // Body is unchanged on a tag rewrite (only frontmatter mutates), but the
    // doc state should still have been reloaded — assert via the parsed body.
    expect(documentStore.getDocument(relPath)?.body).toBe('A note tagged draft.\n');
  });

  it('files without an open editor are still rewritten on disk (helper is a no-op there)', async () => {
    const relPath = 'orphan.md';
    const before = `---\ntags:\n  - draft\n---\nNo editor open.\n`;
    const after = `---\ntags:\n  - review\n---\nNo editor open.\n`;
    fs.files.set(relPath, before);

    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: [makeMetadata(relPath, 'draft')],
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(result.succeeded).toEqual([relPath]);
    expect(fs.files.get(relPath)).toBe(after);
  });
});
