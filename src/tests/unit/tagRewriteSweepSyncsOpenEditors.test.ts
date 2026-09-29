import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  rewriteTagInAllMarkdown,
  __resetTagRewriteSweepForTests,
} from '@renderer/lib/vault/tagRewriteSweep';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `tagRewriteSweep` keeps open views in step with the rewritten bytes.
 *
 * Without this, an open TextTile or DocumentEditor on a sweep-rewritten file
 * keeps its pre-rewrite frontmatter in memory, and its next body write would
 * silently revert the rewrite. The sweep writes through the note store, so
 * the open note's model takes the new frontmatter and a later body edit lands
 * on top of the rewritten file.
 */

function makeMetadata(path: string, tag: string): FileMetadata {
  return {
    path,
    title: path,
    tags: [tag],
    frontmatter: { tags: [tag] },
    content: '',
    lastModified: 0,
    rawFrontmatter: '',
  };
}

describe('tagRewriteSweep — syncs open editors', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    // Runs the test-reset callbacks, which clear the active vault path.
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    __resetDirtyTrackingForTests();
  });

  it("an open editor's note reflects the rewritten tag after the sweep, and its next edit keeps it", async () => {
    const relPath = 'notes.md';
    const before = `---\ntags:\n  - draft\n---\nA note tagged draft.\n`;
    const after = `---\ntags:\n  - review\n---\nA note tagged draft.\n`;
    vault.writeExternally(relPath, before);

    const model = noteStore.acquire(relPath, 'editor');
    await model.loaded;
    expect(model.frontmatter).toEqual({ tags: ['draft'] });

    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: [makeMetadata(relPath, 'draft')],
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(result.succeeded).toEqual([relPath]);
    expect(result.failed).toEqual([]);
    expect(vault.read(relPath)).toBe(after);

    // The open note took the new bytes: frontmatter carries the renamed tag,
    // the body (untouched by a tag rewrite) is unchanged.
    expect(model.frontmatter).toEqual({ tags: ['review'] });
    expect(model.body).toBe('A note tagged draft.\n');

    // The next body edit lands on the rewritten file instead of reverting it.
    noteStore.setBody(relPath, 'Edited after the sweep.\n', 'editor');
    await noteStore.flush(relPath);
    expect(vault.read(relPath)).toBe(`---\ntags:\n  - review\n---\nEdited after the sweep.\n`);
  });

  it('files without an open editor are still rewritten on disk', async () => {
    const relPath = 'orphan.md';
    const before = `---\ntags:\n  - draft\n---\nNo editor open.\n`;
    const after = `---\ntags:\n  - review\n---\nNo editor open.\n`;
    vault.writeExternally(relPath, before);

    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: [makeMetadata(relPath, 'draft')],
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(result.succeeded).toEqual([relPath]);
    expect(vault.read(relPath)).toBe(after);
  });
});
