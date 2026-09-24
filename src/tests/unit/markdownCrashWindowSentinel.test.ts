import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveStateStore } from '@renderer/stores/saveState.svelte';
import {
  noteAdditionalPendingPath,
  dropPendingPath,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteStateInfo,
} from '@renderer/lib/boards/writeStateTracking';
import {
  scheduleMarkdownWrite,
  cancelMarkdownWrite,
  cancelAllMarkdownWrites,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit2 2.3 — a pure markdown body keystroke schedules a write through the
 * gateway, which is sentinel-mode 'pending-path': it must lay down the
 * `.filo/.dirty` crash-recovery sentinel for the duration of the 300 ms
 * debounce window (previously it didn't, so a crash mid-typing lost up to
 * ~300 ms of text with no recovery prompt), and the save indicator must read
 * "saving" — not the premature "idle"/"saved" — while text is unwritten.
 *
 * The debounce window is observable through the write-state ledger: an armed
 * markdown write now adds its path to `pendingVaultPaths` (which drives the
 * sentinel) WITHOUT bumping the inflight counter (trackComponentWrite owns
 * inflight at fire time), and reports a non-zero `pending` count to the save
 * indicator.
 */

function makeArgs(callerId: string, relPath: string): WriteArgs {
  return {
    vaultRoot: '/vault',
    relPath,
    frontmatter: {},
    body: 'hello',
    callerId,
    notePath: relPath,
  };
}

describe('saveState — pending writes show "saving" (audit2 2.3)', () => {
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

describe('writeStateTracking — pending-path tracking reports through the ledger (audit2 2.3)', () => {
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

describe('markdownFileWriter — schedule arms the crash-recovery sentinel window (audit2 2.3)', () => {
  let last: WriteStateInfo | null = null;
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    last = null;
    setWriteStateListener((info) => { last = info; });
  });
  afterEach(() => {
    cancelAllMarkdownWrites();
    setWriteStateListener(null);
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('scheduleMarkdownWrite tracks the armed write as pending (sentinel + indicator)', () => {
    scheduleMarkdownWrite(makeArgs('text-tile:t1', 'Notes/A.md'));
    // The debounce window is covered: the path is pending (drives the
    // .filo/.dirty sentinel) and the indicator would read "saving", NOT idle.
    expect(last?.pending).toBeGreaterThan(0);
    expect(last?.inflight).toBe(0); // trackComponentWrite owns inflight at fire time, not now
    expect(saveStateStore.state).not.toBe('idle');
  });

  it('cancelMarkdownWrite releases the pending window so the sentinel can clear', () => {
    scheduleMarkdownWrite(makeArgs('text-tile:t1', 'Notes/A.md'));
    expect(last?.pending).toBeGreaterThan(0);
    cancelMarkdownWrite('text-tile:t1');
    expect(last?.pending).toBe(0);
  });
});
