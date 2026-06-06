import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/index';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-9 Phase 3 — source-preservation / silent formatting loss.
 *
 * A9-L5: an orphan-card frontmatter edit (no open editor, so `docId: null`)
 * used to take the lossy full-dump branch in `assembleMarkdownFile` — comments,
 * key order, and quoting were re-emitted away. The fix threads the disk FM
 * SOURCE (`hydrateResult.rawFrontmatter`) into the write as a docId-less
 * `originalFrontmatter` option so `patchFrontmatterSourceCst` patches ONLY the
 * changed key source-preservingly, matching the docId path.
 *
 * This test reds when the fix is temp-reverted (drop `originalFrontmatter` from
 * the orphan write, or revert the gateway's `: args.originalFrontmatter` back to
 * `: undefined`): the full dump strips the comment and unquotes the title.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

describe('A9-L5 — orphan-card FM edit preserves comments / key order / quoting', () => {
  let calls: Captured[];

  // Disk frontmatter with a leading comment, an explicitly-quoted scalar, and a
  // deliberate key order. The patch only changes `priority`; everything else
  // must survive byte-for-byte.
  const DISK = [
    '---',
    '# Card metadata — do not reorder',
    'title: "My Card"',
    'priority: low',
    'status: active',
    '---',
    'This is the card body.',
  ].join('\n');

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    calls = [];
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    documentStore.clear();
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: DISK, mtimeMs: 1, size: 100 };
      }
      // Same (mtime,size) as the read → the pre-write drift check sees no drift.
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 100 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    documentStore.clear();
  });

  function lastWrite(): string {
    const write = calls
      .filter((c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md')
      .pop();
    expect(write, 'orphan FM edit must reach disk').toBeDefined();
    return write?.args[2] as string;
  }

  it('keeps the doc-comment, the quoted title, and the key order while applying the patch', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();

    const written = lastWrite();
    // The edit applied.
    expect(written).toContain('priority: high');
    expect(written).not.toContain('priority: low');
    // Source-preserved: comment survives (full-dump would strip it).
    expect(written).toContain('# Card metadata — do not reorder');
    // Source-preserved: the title keeps its explicit double quotes (full-dump
    // would emit the bare `title: My Card`).
    expect(written).toContain('title: "My Card"');
    // Source-preserved: original key order title → priority → status.
    const iTitle = written.indexOf('title:');
    const iPriority = written.indexOf('priority:');
    const iStatus = written.indexOf('status:');
    expect(iTitle).toBeGreaterThanOrEqual(0);
    expect(iTitle).toBeLessThan(iPriority);
    expect(iPriority).toBeLessThan(iStatus);
    // The body is untouched.
    expect(written).toContain('This is the card body.');
  });
});
