/**
 * Phase 5 / 5.5 — undo works for kanban cards without contentId.
 *
 * Before this phase the no-docId branch of `updateTileFrontmatter` called
 * `scheduleSharedFrontmatterWrite(path, null)` — a silent no-op because the
 * frontmatter scheduler reads from vaultIndexStore (not the patch) when
 * docId is null. The new `UpdateOrphanFrontmatterCommand` writes directly
 * via `vault:write-existing-file-text` and supports undo.
 *
 * FILO-UR-1 (Audit-11) — the orphan write now threads a FrontmatterDelta, so the
 * gateway reads disk in-chain and applies only the changed keys (preserving
 * untouched keys, incl. present-but-empty ones). The mock therefore models a real
 * mutable file (reads return current disk, writes mutate it), and a genuinely
 * failed disk read is a LOUD failure — no silent resurrection from the stale
 * index. See the read-fail test below.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/index';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

interface FiloRecorder {
  calls: Array<{ channel: string; args: unknown[] }>;
}

/**
 * Mutable-disk mock. The orphan write routes through the gateway DELTA branch
 * (FILO-UR-1), which reads `vault:read-file-text` in-chain and applies the delta
 * to those fresh bytes — so the recorder models a real file: reads return the
 * current disk and a write mutates it (so an execute→undo round-trip observes its
 * own prior write). `vault:stat` mirrors the same (mtime,size) so the pre-write
 * drift check sees no external change.
 */
function installRecorder(
  initialDisk = '---\npriority: low\nstatus: active\n---\nbody content',
): FiloRecorder {
  const calls: FiloRecorder['calls'] = [];
  let disk = initialDisk;
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:read-file-text') {
      return { success: true, content: disk, mtimeMs: 1, size: disk.length };
    }
    if (channel === 'vault:stat') {
      return { success: true, mtimeMs: 1, size: disk.length };
    }
    if (channel === 'vault:write-existing-file-text') {
      disk = args[2] as string;
      return { success: true };
    }
    return undefined;
  });
  return { calls };
}

describe('UpdateOrphanFrontmatterCommand', () => {
  let recorder: FiloRecorder;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    recorder = installRecorder();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    // Seed vaultIndex with a known FM + body. With the disk read succeeding this
    // is only the degraded fallback the read-fail test exercises.
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
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
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

  it('clears a field via an unset delta (empty value → key removed)', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: '' }, // clears
      { priority: 'low' },
    );
    await cmd.execute();
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    // priority field should be absent now (no `priority:` line in YAML).
    expect(writeCall?.args[2]).not.toContain('priority:');
  });

  /**
   * D.8 — when an external edit landed on disk between the last index rebuild and
   * the orphan-frontmatter command running, the command must assemble the patched
   * FM over the *fresh* disk body, not the stale index snapshot.
   */
  it('reads body fresh from disk so external edits do not get clobbered', async () => {
    const freshDiskContent = '---\npriority: low\n---\nfresh disk body — index is stale';
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      recorder.calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: freshDiskContent, mtimeMs: 1, size: freshDiskContent.length };
      }
      if (channel === 'vault:stat') {
        return { success: true, mtimeMs: 1, size: freshDiskContent.length };
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

    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(writeCall).toBeDefined();
    // Body came from the fresh disk read, not the (stale) index entry.
    expect(writeCall?.args[2]).toContain('fresh disk body');
    expect(writeCall?.args[2]).not.toContain('body content');
    expect(writeCall?.args[2]).toContain('priority: high');
  });

  /**
   * FILO-UR-1 (Audit-11) — a genuinely failed disk read is a LOUD failure.
   * Pre-fix, the orphan write fell back to the (possibly stale) vault index and
   * WROTE it, resurrecting a file the user may have deleted externally. The delta
   * path reads disk in-chain; a read failure rejects (markPathFailed + throw)
   * rather than committing stale bytes — matching the gateway's "never resurrect
   * from a stale snapshot" rule.
   */
  it('surfaces a loud failure when the disk read fails (no silent resurrection)', async () => {
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
    await expect(cmd.execute()).rejects.toThrow();

    // No bytes were written — the stale index was NOT resurrected to disk.
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(writeCall).toBeUndefined();
  });
});
