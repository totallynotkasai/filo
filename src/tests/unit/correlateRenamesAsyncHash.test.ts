/**
 * `correlateRenames` accepts an async (Promise-returning)
 * hash probe so the fileWatcher's reconcile pass can read file bytes via
 * `fs.promises.readFile` (concurrency-bounded) instead of blocking the
 * event loop with `readFileSync`. The function awaits the probe inside
 * the cross-basename loop, so:
 *
 *   1. A Promise-returning probe resolves before the rename pair is emitted.
 *   2. Sync probes still work (return value flows through `await` unchanged).
 *   3. Probes that resolve to `null` refuse to pair (defensive fallthrough).
 */

import { describe, it, expect } from 'vitest';
import { correlateRenames } from '../../main/services/renameCorrelation';
import type { FileChangeEvent } from '../../main/services/fileWatcherTypes';

function ev(filename: string, type: FileChangeEvent['type'] = 'document'): FileChangeEvent {
  return { type, filename, eventType: 'rename' };
}

function existsAmong(...paths: string[]): (rel: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

function sizeAmong(map: Record<string, number>): (rel: string) => number | null {
  return (p) => (p in map ? map[p] : null);
}

describe('correlateRenames — async hash probe', () => {
  it('pairs cross-basename when an ASYNC hash probe resolves to matching hashes', async () => {
    const events = [ev('OldName.md'), ev('NewName.md')];
    const exists = existsAmong('NewName.md');
    const sizes = sizeAmong({ 'OldName.md': 1024, 'NewName.md': 1024 });
    const asyncHashes = async (rel: string): Promise<string | null> => {
      // Simulate the libuv-thread-pool read latency.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (rel === 'OldName.md' || rel === 'NewName.md') return 'matchhash';
      return null;
    };
    const { renames, filtered } = await correlateRenames(events, exists, sizes, asyncHashes);
    expect(renames).toEqual([{ oldPath: 'OldName.md', newPath: 'NewName.md' }]);
    expect(filtered).toEqual([]);
  });

  it('refuses to pair when an ASYNC hash probe resolves to differing hashes', async () => {
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const sizes = sizeAmong({ 'Foo.md': 1024, 'Bar.md': 1024 });
    const asyncHashes = async (rel: string): Promise<string | null> => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (rel === 'Foo.md') return 'aaa';
      if (rel === 'Bar.md') return 'bbb';
      return null;
    };
    const { renames, filtered } = await correlateRenames(events, exists, sizes, asyncHashes);
    expect(renames).toEqual([]);
    expect(filtered).toEqual(events);
  });

  it('refuses to pair when an ASYNC hash probe resolves to null', async () => {
    // The fileWatcher's hashAsync falls back to `null` when the file is
    // gone AND no cached hash exists. The correlator must treat that
    // outcome as a refusal-to-pair rather than fabricating a rename.
    const events = [ev('Foo.md'), ev('Bar.md')];
    const exists = existsAmong('Bar.md');
    const sizes = sizeAmong({ 'Foo.md': 1024, 'Bar.md': 1024 });
    const asyncHashes = async (): Promise<string | null> => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return null;
    };
    const { renames } = await correlateRenames(events, exists, sizes, asyncHashes);
    expect(renames).toEqual([]);
  });

  it('serialises hash probe calls per candidate (only one probe in flight at a time per call)', async () => {
    // The cross-basename loop iterates per size bucket and awaits each
    // probe sequentially. Confirm that semantic — important when the
    // upstream `hashAsync` uses a semaphore to cap fs read concurrency.
    const events = [ev('OldName.md'), ev('NewName.md')];
    const exists = existsAmong('NewName.md');
    const sizes = sizeAmong({ 'OldName.md': 1024, 'NewName.md': 1024 });

    let inflight = 0;
    let maxInflight = 0;
    const asyncHashes = async (): Promise<string | null> => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inflight -= 1;
      return 'sharedhash';
    };

    await correlateRenames(events, exists, sizes, asyncHashes);
    // Sequential awaits in the loop ⇒ never more than 1 probe outstanding
    // for a single correlateRenames call.
    expect(maxInflight).toBe(1);
  });
});
