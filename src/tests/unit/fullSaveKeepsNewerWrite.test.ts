/**
 * A full save (`flushAll`: Ctrl+S, the save before a rename, move or delete,
 * quit) takes a copy of every waiting key at its start and sends them one
 * after another. A key scheduled again while an earlier key's write is slow
 * gets a newer write of its own; the copy the full save holds of it is older,
 * so it must never land after (or instead of) that newer write.
 *
 * Driven on the `createScheduler` primitive with a gated in-memory disk: a
 * write labelled `key@version` waits while its gate is held.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createScheduler, disposeTestSchedulers } from '../helpers/testSchedulers';
import type { Scheduler } from '@renderer/lib/boards/writeScheduler';
import { __resetDirtyTrackingForTests, unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import { restoreFiloDefault } from '../helpers/filoBridge';

// Retire every scheduler a test made, so nothing it left armed reaches the next test.
afterEach(disposeTestSchedulers);

interface Args {
  vaultRoot: string;
  path: string;
  v: number;
}

type Key = 'a' | 'b';

interface Rig {
  s: Scheduler<Args>;
  disk: Partial<Record<Key, number>>;
  /** Every write that landed, in order, as `key@version`. */
  order: string[];
  /** Changes `key` to version `v` and schedules its write. */
  edit(key: Key, v: number): void;
  /** Holds the write `label` (`key@version`) until the returned function is called. */
  hold(label: string): () => void;
  /** Makes the write `label` fail with `code` (an empty code lets it through again). */
  fail(label: string, code: string): void;
}

/** Releases every gate a test left held, so nothing waits past its test. */
const openGates = new Set<() => void>();
/**
 * Every scheduler a test made. A scheduler's armed writes keep their path
 * pending for every writer, so each is reset after its test.
 */
const made = new Set<Scheduler<Args>>();

function rig(sentinelMode: 'full' | 'pending-path' = 'full'): Rig {
  const disk: Rig['disk'] = {};
  const order: string[] = [];
  const live: Record<Key, number> = { a: 1, b: 1 };
  const gates = new Map<string, Promise<void>>();
  const failures = new Map<string, string>();
  const s = createScheduler<Args>({
    name: 'test',
    debounceMs: 300,
    performWrite: async (a) => {
      const label = `${a.path}@${a.v}`;
      await gates.get(label);
      const code = failures.get(label);
      if (code) throw Object.assign(new Error(`${label} failed`), { code });
      disk[a.path as Key] = a.v;
      order.push(label);
    },
    getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
    sentinelMode,
  });
  made.add(s);
  const argsOf = (key: Key) => (): Args => ({ vaultRoot: '/v', path: key, v: live[key] });
  return {
    s,
    disk,
    order,
    edit(key, v) {
      live[key] = v;
      s.schedule(key, argsOf(key));
    },
    hold(label) {
      let open!: () => void;
      gates.set(label, new Promise<void>((res) => { open = res; }));
      openGates.add(open);
      return open;
    },
    fail(label, code) {
      failures.set(label, code);
    },
  };
}

/** Lets every promise chain that can run without a timer run. */
async function ticks(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

/** Nothing waiting, sending or counted for either key. */
function expectIdle(s: Scheduler<Args>): void {
  expect(s.hasWork('a')).toBe(false);
  expect(s.hasWork('b')).toBe(false);
  expect(s.hasParked(() => true)).toBe(false);
  expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
}

describe('a full save never lands an older copy over a newer write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    for (const open of openGates) open();
    openGates.clear();
    for (const s of made) s.reset();
    made.clear();
    vi.useRealTimers();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it.each(['full', 'pending-path'] as const)(
    'a key edited again while an earlier key is slow ends on its newer version (%s tracking)',
    async (mode) => {
      const t = rig(mode);
      const releaseA = t.hold('a@2');
      t.edit('a', 2);
      t.edit('b', 2);
      const saving = t.s.flushAll(); // sends a (slow), holding b@2 for after it

      t.edit('b', 3);
      await vi.advanceTimersByTimeAsync(400); // b's own timer writes b@3
      expect(t.disk.b).toBe(3);
      expect(t.s.hasWork('b')).toBe(false); // nothing of b is owed any more

      releaseA();
      const result = await saving;
      expect(result.failed).toEqual([]);
      expect(t.disk).toEqual({ a: 2, b: 3 });
      expect(t.order).toEqual(['b@3', 'a@2']); // the copy b@2 is never sent
      expectIdle(t.s);
    },
  );

  it('a key whose newer write is still being written when the full save reaches it ends on that write', async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    const releaseB3 = t.hold('b@3');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    t.edit('b', 3);
    await vi.advanceTimersByTimeAsync(400); // b@3 is sent, and is slow too
    releaseA();
    await ticks(); // the full save comes to b while b@3 is out
    releaseB3();
    await saving;

    expect(t.disk).toEqual({ a: 2, b: 3 });
    expect(t.order).toEqual(['a@2', 'b@3']);
    expectIdle(t.s);
  });

  it("a key's flush during the full save sends its newer write without waiting for the earlier key", async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    t.edit('b', 3); // still waiting on its debounce
    let flushed = false;
    const flushing = t.s.flush('b').then((r) => { flushed = true; return r; });
    await ticks();
    expect(flushed).toBe(true); // a is still out: the flush didn't wait for it
    expect((await flushing).ok).toBe(true);
    expect(t.disk.b).toBe(3); // what a board delete then moves to the trash

    releaseA();
    await saving;
    expect(t.order).toEqual(['b@3', 'a@2']);
    expectIdle(t.s);
  });

  it("a key's flush already waiting on the full save's copy sends the key's newer write in its place", async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    let flushed = false;
    const flushing = t.s.flush('b').then((r) => { flushed = true; return r; });
    await ticks();
    expect(flushed).toBe(false); // b@2 hasn't been sent yet

    t.edit('b', 3);
    await ticks();
    expect(flushed).toBe(true);
    expect((await flushing).ok).toBe(true);
    expect(t.disk.b).toBe(3);

    releaseA();
    await saving;
    expect(t.order).toEqual(['b@3', 'a@2']);
    expectIdle(t.s);
  });

  it("a key whose newer write already landed is flushed at once", async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    t.edit('b', 3);
    await vi.advanceTimersByTimeAsync(400); // b@3 lands from its timer
    let flushed = false;
    const flushing = t.s.flush('b').then((r) => { flushed = true; return r; });
    await ticks();
    expect(flushed).toBe(true);
    expect((await flushing).ok).toBe(true);
    expect(t.disk.b).toBe(3);

    releaseA();
    await saving;
    expect(t.order).toEqual(['b@3', 'a@2']);
    expectIdle(t.s);
  });

  it("the newer write's failure stays reported, and Retry writes the newer version", async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    t.fail('b@3', 'EBUSY');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    t.edit('b', 3);
    await vi.advanceTimersByTimeAsync(400); // b@3 fails (a locked file)
    releaseA();
    await saving;

    expect(t.disk.b).toBeUndefined(); // the older copy didn't paper over it
    expect(unsavedWork().failed).toEqual(['b']);
    expect(t.s.hasWork('b')).toBe(true); // kept for Retry

    t.fail('b@3', '');
    expect((await t.s.retryFailed('b')).failed).toEqual([]);
    expect(t.disk.b).toBe(3);
    expectIdle(t.s);
  });

  it('a key cancelled after its newer schedule writes nothing and leaves nothing counted', async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    t.edit('b', 3);
    t.s.cancel('b'); // the board was deleted meanwhile
    releaseA();
    await saving;
    await vi.advanceTimersByTimeAsync(400);

    expect(t.disk).toEqual({ a: 2 });
    expectIdle(t.s);
  });

  it('a key cancelled while the full save holds it, then edited again, counts its new write as unsaved until it lands', async () => {
    const t = rig();
    const releaseA = t.hold('a@2');
    const releaseB3 = t.hold('b@3');
    t.edit('a', 2);
    t.edit('b', 2);
    const saving = t.s.flushAll();

    t.s.cancel('b');
    t.edit('b', 3);
    releaseA();
    await saving;
    await vi.advanceTimersByTimeAsync(400); // b@3 is sent, and is slow
    expect(unsavedWork()).toEqual({ pending: ['b'], failed: [], inflight: 1 });

    releaseB3();
    await ticks();
    expect(t.disk).toEqual({ a: 2, b: 3 });
    expectIdle(t.s);
  });

  it('a key edited again after the full save sent it counts its new write as unsaved until it lands', async () => {
    const t = rig();
    const releaseB3 = t.hold('b@3');
    t.edit('b', 2);
    await t.s.flushAll(); // b@2 sent and landed

    t.edit('b', 3);
    await vi.advanceTimersByTimeAsync(400);
    expect(unsavedWork()).toEqual({ pending: ['b'], failed: [], inflight: 1 });

    releaseB3();
    await ticks();
    expect(t.disk).toEqual({ b: 3 });
    expectIdle(t.s);
  });

  it("after a vault swap, a key's next edit is counted afresh", async () => {
    const t = rig();
    t.hold('a@2');
    t.edit('a', 2);
    t.edit('b', 2);
    void t.s.flushAll(); // b@2 still held for after a when the vault is let go

    t.s.reset();
    __resetDirtyTrackingForTests(); // as the swap's write-tracking reset
    const releaseB3 = t.hold('b@3');
    t.edit('b', 3);
    await vi.advanceTimersByTimeAsync(400);
    expect(unsavedWork()).toEqual({ pending: ['b'], failed: [], inflight: 1 });

    releaseB3();
    await ticks();
    expect(t.disk.b).toBe(3);
    expect(unsavedWork()).toEqual({ pending: [], failed: [], inflight: 0 });
  });
});
