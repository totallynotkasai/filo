import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveStateStore } from '@renderer/stores/saveState.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import {
  noteAdditionalPendingPath,
  dropPendingPath,
  isPathPending,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteStateInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { ownSentinelPath } from '@renderer/lib/vault/machineIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A body edit waits out the note writer's 300 ms debounce before it reaches
 * disk. For that whole window the `.filo/.dirty` crash-recovery sentinel
 * must name the note (a crash mid-typing otherwise loses the text with no recovery
 * prompt), and the save indicator must read "saving", not "saved".
 *
 * The note writer's scheduler runs in 'pending-path' sentinel mode: an armed
 * write adds its path to the pending set (which drives the sentinel) WITHOUT
 * bumping the inflight counter; the write itself owns inflight when it fires.
 */

describe('saveState — pending writes show "saving"', () => {
  beforeEach(() => saveStateStore.__reset());

  it('treats a pending (debounced-but-not-inflight) write as "saving"', () => {
    // inflight 0, failed 0, but a debounce is armed → text is unwritten.
    saveStateStore.setStatus(0, 0, 1);
    expect(saveStateStore.state).toBe('saving');
  });

  it('returns to "saved" only once nothing is pending or inflight', () => {
    saveStateStore.setStatus(0, 0, 1);
    expect(saveStateStore.state).toBe('saving');
    saveStateStore.setStatus(0, 0, 0);
    expect(saveStateStore.state).toBe('saved');
  });

  it('a failed write with no pending/inflight is still surfaced as error', () => {
    saveStateStore.setStatus(0, 1, 0);
    expect(saveStateStore.state).toBe('error');
  });
});

describe('writeStateTracking — pending-path tracking reports through the ledger', () => {
  let last: WriteStateInfo | null = null;
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    last = null;
    setWriteStateListener((info) => { last = info; });
  });
  afterEach(() => {
    setWriteStateListener(null);
    __resetDirtyTrackingForTests();
  });

  it('noteAdditionalPendingPath reports pending>0 without bumping inflight', () => {
    // vaultRoot undefined → skips the sentinel IPC but still tracks the path
    // + notifies the save indicator.
    noteAdditionalPendingPath(undefined, 'Notes/A.md');
    expect(last?.pending).toBe(1);
    expect(last?.inflight).toBe(0);
  });

  it('dropPendingPath clears the pending count', () => {
    noteAdditionalPendingPath(undefined, 'Notes/A.md');
    expect(last?.pending).toBe(1);
    dropPendingPath(undefined, 'Notes/A.md');
    expect(last?.pending).toBe(0);
  });
});

describe('note writer — a queued edit arms the crash-recovery sentinel window', () => {
  let last: WriteStateInfo | null = null;
  let vault: MemoryVault;

  beforeEach(async () => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    vault = installMemoryVault({ 'Notes/A.md': '---\ntitle: A\n---\nBody\n' });
    noteStore.__resetForTests();
    last = null;
    setWriteStateListener((info) => { last = info; });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    setWriteStateListener(null);
    __resetDirtyTrackingForTests();
    setActiveVaultPath('');
    restoreFiloDefault();
  });

  function sentinelPayloads(): Array<{ pendingPaths?: string[] }> {
    return vault.writes
      .filter(([, rel]) => rel === ownSentinelPath('dirty'))
      .map(([, , text]) => JSON.parse(text) as { pendingPaths?: string[] });
  }

  it('a body edit is pending (sentinel + indicator) before the debounce fires', async () => {
    const m = noteStore.acquire('Notes/A.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'typing', 'tile');

    expect(last?.pending).toBeGreaterThan(0);
    expect(last?.inflight).toBe(0);
    expect(isPathPending('Notes/A.md')).toBe(true);
    // The sentinel on disk names the note while its text is unwritten.
    await new Promise((r) => setTimeout(r, 0));
    expect(sentinelPayloads().some((p) => p.pendingPaths?.includes('notes/a.md'))).toBe(true);
    // Nothing has reached the note itself yet.
    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\n---\nBody\n');
  });

  it('a frontmatter change on an unopened note is pending the same way', () => {
    noteStore.patchFrontmatter('Notes/A.md', { set: { status: 'done' }, unset: [] });
    expect(last?.pending).toBeGreaterThan(0);
    expect(isPathPending('Notes/A.md')).toBe(true);
  });

  it('the pending window closes once the write lands', async () => {
    const m = noteStore.acquire('Notes/A.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'typing', 'tile');
    expect(last?.pending).toBeGreaterThan(0);
    await noteStore.flush('Notes/A.md');
    expect(last?.pending).toBe(0);
    expect(isPathPending('Notes/A.md')).toBe(false);
    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\n---\ntyping\n');
  });

  it('deleting the note in the app releases the pending window', async () => {
    const m = noteStore.acquire('Notes/A.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'typing', 'tile');
    expect(last?.pending).toBeGreaterThan(0);
    noteStore.forgetDeleted('Notes/A.md');
    expect(last?.pending).toBe(0);
    expect(isPathPending('Notes/A.md')).toBe(false);
  });
});
