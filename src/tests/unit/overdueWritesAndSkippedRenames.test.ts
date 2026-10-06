/**
 * Two things that outlast what was waiting for them:
 *
 * - A write that overran `writeTimeoutMs` is reported as failed but can still
 *   land. The next write of the same key waits for it, so the newest bytes
 *   land last; one that lands later still makes the newest write fire again.
 * - An external rename that arrives while the vault is being let go is
 *   skipped by the reconcile queue; it leaves a rename-cascade breadcrumb in
 *   that vault (still open until `vault:close`), so the next open replays it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  beginVaultGeneration,
  retireVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { enqueueRenameQueueWork, resetRenameQueue } from '@renderer/stores/vaultRenameQueue';
import { keepSkippedRenameBreadcrumb } from '@renderer/stores/vaultExternalChanges';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a write past its timeout keeps its place in the key\'s order', () => {
  beforeEach(() => __resetDirtyTrackingForTests());
  afterEach(() => __resetDirtyTrackingForTests());

  function stalledFirstWrite() {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let calls = 0;
    const scheduler = createScheduler<{ path: string; v: string }>({
      name: 'overdue-test',
      debounceMs: 5,
      writeTimeoutMs: 40,
      performWrite: async (args) => {
        calls++;
        events.push(`fire ${args.v}`);
        if (calls === 1) {
          await new Promise<void>((res) => { releaseFirst = res; });
          events.push(`land ${args.v}`);
          return;
        }
        events.push(`land ${args.v}`);
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });
    return { scheduler, events, release: () => releaseFirst() };
  }

  it('the next write of the key fires only after the timed-out one settles', async () => {
    const { scheduler, events, release } = stalledFirstWrite();
    let value = 'A';
    scheduler.schedule('k', () => ({ path: 'b.board.json', v: value }));
    expect((await scheduler.flushAll()).failed).toEqual(['b.board.json']); // timed out

    value = 'B';
    scheduler.schedule('k', () => ({ path: 'b.board.json', v: value }));
    const second = scheduler.flushAll();
    await wait(10);
    expect(events).toEqual(['fire A']); // B waits for A
    release();
    expect((await second).failed).toEqual([]);
    expect(events).toEqual(['fire A', 'land A', 'fire B', 'land B']);
  });

  it('one that lands after the wait gave up makes the newest write fire again', async () => {
    const { scheduler, events, release } = stalledFirstWrite();
    let value = 'A';
    scheduler.schedule('k', () => ({ path: 'b.board.json', v: value }));
    await scheduler.flushAll(); // A timed out

    value = 'B';
    scheduler.schedule('k', () => ({ path: 'b.board.json', v: value }));
    await scheduler.flushAll(); // waited 40 ms for A, then fired B
    expect(events).toEqual(['fire A', 'fire B', 'land B']);

    release(); // A lands over B
    await wait(20);
    await scheduler.flushAll();
    expect(events.slice(-3)).toEqual(['land A', 'fire B', 'land B']);
  });
});

describe('an external rename skipped while the vault is let go leaves a breadcrumb', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    resetRenameQueue();
    __resetRenameCascadeSentinelForTests();
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetRenameCascadeSentinelForTests();
    __resetVaultIdentityForTests();
  });

  it('the queue hands a skipped task to onSkipped with the vault it was enqueued for', async () => {
    beginVaultGeneration('/vault');
    retireVaultGeneration();
    let ran = false;
    const skipped: string[] = [];
    await enqueueRenameQueueWork(
      async () => { ran = true; },
      undefined,
      async (captured) => { skipped.push(captured.path); },
    );
    expect(ran).toBe(false);
    expect(skipped).toEqual(['/vault']);
  });

  it('the breadcrumb is a rename-cascade sentinel entry naming both paths', async () => {
    const writes: Array<{ path: string; text: string }> = [];
    installFiloMock({
      'vault:read-file-text': async () => ({ success: false, code: 'ENOENT', error: 'ENOENT' }),
      'vault:write-file-text': async (...args: unknown[]) => {
        writes.push({ path: String(args[1]), text: String(args[2]) });
        return { success: true };
      },
    });
    await keepSkippedRenameBreadcrumb('/vault', 'Notes/a.md', 'Notes/b.md');
    const sentinel = writes.find((w) => w.path.includes('rename-cascade-pending'));
    expect(sentinel).toBeDefined();
    const entries = JSON.parse(sentinel!.text) as { entries?: Array<{ oldPath: string; newPath: string }> } | Array<{ oldPath: string; newPath: string }>;
    const list = Array.isArray(entries) ? entries : entries.entries ?? [];
    expect(list.map((e) => [e.oldPath, e.newPath])).toEqual([['Notes/a.md', 'Notes/b.md']]);
  });
});
