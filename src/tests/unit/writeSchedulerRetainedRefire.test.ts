import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import { retryAllFailedWrites, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { RETAINABLE, isRetainableWriteError } from '@renderer/lib/boards/writeSchedulerFailures';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

/**
 * Audit-19 EXT-5 / ERR-9 — a write that failed on a transient lock used to be
 * forgotten: the scheduler kept only the failure id, `flushAll()` re-fired only
 * `pending`, and the quit dialog's retry re-issued nothing. Transient failures
 * now RETAIN their args getter and the next flushAll / Retry re-fires them.
 */

interface Args { path: string; body: string }

function lock(code: string): Error {
  return Object.assign(new Error(`${code}: locked`), { code });
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('condition not met');
}

describe('writeScheduler — retained failed writes re-fire (Audit-19 EXT-5)', () => {
  beforeEach(() => {
    installFiloMock(() => ({ success: true, ok: true }));
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  function makeScheduler(fail: (args: Args, attempt: number) => Error | null) {
    const writes: Args[] = [];
    let attempt = 0;
    const scheduler = createScheduler<Args>({
      name: 'retain-test',
      debounceMs: 5,
      performWrite: async (args) => {
        attempt++;
        const err = fail(args, attempt);
        if (err) throw err;
        writes.push(args);
      },
      getSentinelInfo: (a) => ({ vaultRoot: '/vault', path: a.path }),
    });
    return { scheduler, writes, attempts: () => attempt };
  }

  it('an EPERM timer fire is re-fired by the next flushAll with the SAME getter (bite)', async () => {
    const { scheduler, writes, attempts } = makeScheduler((_a, n) => (n === 1 ? lock('EPERM') : null));
    let body = 'v1';
    scheduler.schedule('Note.md', () => ({ path: 'Note.md', body }));
    await waitFor(() => attempts() === 1);
    await new Promise((r) => setTimeout(r, 5));
    body = 'v2'; // the getter reads live state at re-fire time
    const res = await scheduler.flushAll();
    expect(res.failed).toEqual([]);
    expect(writes).toEqual([{ path: 'Note.md', body: 'v2' }]);
  });

  it('a user-deferred failure (no RETAINABLE code) is NOT re-fired', async () => {
    const { scheduler, attempts } = makeScheduler(() => new Error('write deferred — external edit unresolved'));
    scheduler.schedule('Note.md', () => ({ path: 'Note.md', body: 'x' }));
    await waitFor(() => attempts() === 1);
    await new Promise((r) => setTimeout(r, 5));
    await scheduler.flushAll();
    expect(attempts()).toBe(1);
  });

  it('a newer schedule supersedes the retained args (one write, newest payload)', async () => {
    const { scheduler, writes, attempts } = makeScheduler((_a, n) => (n === 1 ? lock('EBUSY') : null));
    scheduler.schedule('Note.md', () => ({ path: 'Note.md', body: 'old' }));
    await waitFor(() => attempts() === 1);
    await new Promise((r) => setTimeout(r, 5));
    scheduler.schedule('Note.md', () => ({ path: 'Note.md', body: 'new' }));
    await scheduler.flushAll();
    expect(writes).toEqual([{ path: 'Note.md', body: 'new' }]);
  });

  it('flushAll re-fires once per call; a still-locked write stays retained for the next', async () => {
    const { scheduler, writes, attempts } = makeScheduler((_a, n) => (n <= 2 ? lock('EPERM') : null));
    scheduler.schedule('Note.md', () => ({ path: 'Note.md', body: 'x' }));
    await waitFor(() => attempts() === 1);
    await new Promise((r) => setTimeout(r, 5));
    const first = await scheduler.flushAll();
    expect(first.failed).toEqual(['Note.md']);
    expect(attempts()).toBe(2);
    const second = await scheduler.flushAll();
    expect(second.failed).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it('retryAllFailedWrites fans out to every scheduler with retained writes', async () => {
    const a = makeScheduler((_x, n) => (n === 1 ? lock('EIO') : null));
    const b = makeScheduler((_x, n) => (n === 1 ? lock('EACCES') : null));
    a.scheduler.schedule('A.md', () => ({ path: 'A.md', body: 'a' }));
    b.scheduler.schedule('B.board.json', () => ({ path: 'B.board.json', body: 'b' }));
    await waitFor(() => a.attempts() === 1 && b.attempts() === 1);
    await new Promise((r) => setTimeout(r, 5));
    const res = await retryAllFailedWrites();
    expect(res.failed).toEqual([]);
    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(1);
  });

  it('a retained write whose source vanished is dropped silently (no missing-source fire)', async () => {
    const { scheduler, attempts } = makeScheduler((_a, n) => (n === 1 ? lock('EPERM') : null));
    let alive = true;
    scheduler.schedule('Gone.md', () => (alive ? { path: 'Gone.md', body: 'x' } : null));
    await waitFor(() => attempts() === 1);
    await new Promise((r) => setTimeout(r, 5));
    alive = false;
    const res = await scheduler.flushAll();
    expect(res.failed).toEqual([]);
    expect(attempts()).toBe(1);
  });

  it('RETAINABLE holds the lock/IO codes and no user-decision marker', () => {
    for (const c of ['EPERM', 'EBUSY', 'EACCES', 'WRITE_TIMEOUT', 'BOARD_PATH_HELD']) expect(RETAINABLE.has(c)).toBe(true);
    expect(isRetainableWriteError(new Error('deferred'))).toBe(false);
    expect(isRetainableWriteError(Object.assign(new Error('x'), { code: 'EXTERNAL_EDIT' }))).toBe(false);
  });
});
