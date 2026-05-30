/**
 * Phase 5 / 5.5 — undo works for kanban cards without contentId.
 *
 * Before this phase the no-docId branch of `updateTileFrontmatter` called
 * `scheduleSharedFrontmatterWrite(path, null)` — a silent no-op because the
 * frontmatter scheduler reads from vaultIndexStore (not the patch) when
 * docId is null. The new `UpdateOrphanFrontmatterCommand` writes directly
 * via `vault:write-existing-file-text` and supports undo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

interface FiloRecorder {
  calls: Array<{ channel: string; args: unknown[] }>;
}

function installRecorder(): FiloRecorder {
  const calls: FiloRecorder['calls'] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:write-existing-file-text') {
      return { success: true };
    }
    return undefined;
  });
  return { calls };
}

describe('UpdateOrphanFrontmatterCommand', () => {
  let recorder: FiloRecorder;

  beforeEach(() => {
    recorder = installRecorder();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    // Seed vaultIndex with a known FM + body so the command reads from
    // disk and produces a deterministic assembled file.
    vaultIndexStore.restoreMetadata('Card.md', {
      path: 'Card.md',
      title: 'Card',
      headings: [],
      tags: [],
      frontmatter: { priority: 'low' },
      links: [],
      content: 'body content',
      lastModified: 0,
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
  });

  it('execute writes the patched frontmatter via vault:write-existing-file-text', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(writeCall).toBeDefined();
    expect(writeCall?.args[1]).toBe('Card.md');
    expect(writeCall?.args[2]).toContain('priority: high');
    expect(writeCall?.args[2]).toContain('body content');
  });

  it('undo writes the inverse patch back through the same channel', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();
    await cmd.undo();
    const writes = recorder.calls.filter((c) => c.channel === 'vault:write-existing-file-text');
    expect(writes.length).toBeGreaterThanOrEqual(2);
    // Last write reflects the inverse patch (priority: low).
    expect(writes[writes.length - 1]?.args[2]).toContain('priority: low');
  });

  it('handles missing vault gracefully (no-op)', async () => {
    vaultStore.setPath('');
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();
    expect(recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text')).toBeUndefined();
  });

  it('deep-clones the patch so caller-side mutation cannot poison', async () => {
    const patch: Record<string, unknown> = { priority: 'high' };
    const inverse: Record<string, unknown> = { priority: 'low' };
    const cmd = new UpdateOrphanFrontmatterCommand('kb', 'Card.md', patch, inverse);
    patch.priority = 'poisoned';

    await cmd.execute();
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(writeCall?.args[2]).toContain('priority: high');
    expect(writeCall?.args[2]).not.toContain('poisoned');
  });

  it('drops empty/null/undefined values from the merged frontmatter (clean semantics)', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: '' },           // clears
      { priority: 'low' },
    );
    await cmd.execute();
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    // priority field should be absent now (no `priority:` line in YAML).
    expect(writeCall?.args[2]).not.toContain('priority:');
  });

  /**
   * D.8 — when an external edit landed on disk between the last index
   * rebuild and the orphan-frontmatter command running, the command
   * must assemble the patched FM over the *fresh* disk body, not the
   * stale index snapshot. Without this, the user's frontmatter patch
   * would clobber any body change made externally since the last
   * cache rebuild.
   */
  it('reads body fresh from disk so external edits do not get clobbered', async () => {
    const freshDiskContent = '---\npriority: low\n---\nfresh disk body — index is stale';
    // Override the recorder so vault:read-file-text returns the disk
    // snapshot, not the stale index baseline.
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      recorder.calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: freshDiskContent };
      }
      if (channel === 'vault:write-existing-file-text') {
        return { success: true };
      }
      return undefined;
    });

    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();

    const writeCall = recorder.calls.find(
      (c) => c.channel === 'vault:write-existing-file-text',
    );
    expect(writeCall).toBeDefined();
    // Body came from the fresh disk read, not the (stale) index entry
    // that said "body content".
    expect(writeCall?.args[2]).toContain('fresh disk body');
    expect(writeCall?.args[2]).not.toContain('body content');
    expect(writeCall?.args[2]).toContain('priority: high');
  });

  it('falls back to vaultIndex when fresh disk read fails (no-data-loss)', async () => {
    // Disk read returns `success: false` → fallback to index baseline.
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      recorder.calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'vault:write-existing-file-text') {
        return { success: true };
      }
      return undefined;
    });

    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();

    const writeCall = recorder.calls.find(
      (c) => c.channel === 'vault:write-existing-file-text',
    );
    // Body falls back to the index entry's `content`.
    expect(writeCall?.args[2]).toContain('body content');
    expect(writeCall?.args[2]).toContain('priority: high');
  });
});
