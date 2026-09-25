/**
 * Task List notes typed while their note is still being read are unsaved
 * work: save and quit must wait for them and write them, and they count as
 * pending (the crash sentinel names the path) in the meantime.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('Task notes typed while the note loads survive a quit drain', () => {
  const DISK = '---\ntitle: T\npriority: high\n---\nold body\n';
  let disk: string;
  let releaseRead: () => void;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    disk = DISK;
    const gate = new Promise<void>((r) => { releaseRead = r; });
    let first = true;
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        if (first) { first = false; await gate; }
        return { success: true, content: disk, mtimeMs: 5, size: disk.length, encoding: 'utf-8' };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: disk.length };
      if (channel === 'vault:write-existing-file-text') { disk = args[2] as string; return { success: true }; }
      return { success: true };
    });
  });

  afterEach(() => {
    releaseRead();
    noteStore.__resetForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('the notes are pending while the first read is in flight, and a drain writes them', async () => {
    const p = noteStore.writeBody('Task.md', 'My typed notes');
    await new Promise((r) => setTimeout(r, 0));
    expect(noteStore.hasPendingWrites('Task.md')).toBe(true);
    expect(isPathPending('Task.md')).toBe(true);
    const drained = noteStore.flushAll();
    releaseRead();
    await drained;
    expect(disk).toBe('---\ntitle: T\npriority: high\n---\nMy typed notes\n');
    await p;
  });
});
