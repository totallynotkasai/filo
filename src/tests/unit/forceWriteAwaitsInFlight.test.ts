/**
 * 6.2.H10 — `forceWriteForDocument` awaits any in-flight write for the
 * same callerId before re-arming.
 *
 * Pre-fix race:
 *   1. Timer fires → `writeMarkdownFile(args1)` enters the IPC await.
 *   2. Before the IPC resolves, `forceWriteForDocument(docId)` runs,
 *      calls `cancelMarkdownWrite` (no-op — timer already fired) and
 *      starts `writeMarkdownFile(args2)`.
 *   3. Two writes race; the OS arbitrates the order; the loser's bytes
 *      silently clobber the winner under the same path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __resetMarkdownFileWriterForTests,
  cancelAllMarkdownWrites,
  forceWriteForDocument,
  markHydrated,
  registerForceWriter,
  scheduleMarkdownWrite,
  unregisterForceWriter,
  writeMarkdownFile,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('forceWriteForDocument — 6.2.H10 in-flight race', () => {
  beforeEach(() => {
    vaultStore.setPath('/vault');
    cancelAllMarkdownWrites();
    __resetMarkdownFileWriterForTests();
  });

  afterEach(() => {
    restoreFiloDefault();
    cancelAllMarkdownWrites();
    __resetMarkdownFileWriterForTests();
    vaultStore.setPath('');
  });

  it('awaits an in-flight write for the same callerId before re-arming a force write', async () => {
    // Sequence the IPCs so we can pin the order of writes that reach disk.
    // Each `vault:write-existing-file-text` resolves on a separately-created
    // deferred. The test arms write A via the scheduler, fires the timer,
    // and while A is pending in the IPC await calls forceWriteForDocument.
    // Pre-fix, A and B both race to settle and the order is non-deterministic.
    // Post-fix, B waits for A's deferred to resolve before it starts.

    const writeOrder: string[] = [];
    const aDeferred = makeDeferred<void>();
    const bDeferred = makeDeferred<void>();
    let writeCount = 0;

    installFiloMock(async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '', mtimeMs: 1 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 0 };
      if (
        channel === 'vault:write-existing-file-text' &&
        args[1] === 'Notes.md'
      ) {
        const body = args[2] as string;
        writeCount++;
        const label = writeCount === 1 ? 'A' : 'B';
        writeOrder.push(`${label}-start:${body.slice(0, 16)}`);
        await (writeCount === 1 ? aDeferred.promise : bDeferred.promise);
        writeOrder.push(`${label}-end`);
        return { success: true };
      }
      return { success: true };
    });

    // Hydrate so writeMarkdownFile won't refuse.
    markHydrated('Notes.md', false);

    const argsA: WriteArgs = {
      vaultRoot: '/vault',
      relPath: 'Notes.md',
      frontmatter: {},
      body: 'AAA-body',
      callerId: 'caller-X',
      docId: 'doc-Z',
    };
    const argsB: WriteArgs = {
      vaultRoot: '/vault',
      relPath: 'Notes.md',
      frontmatter: {},
      body: 'BBB-body',
      callerId: 'caller-X',
      docId: 'doc-Z',
    };

    // Register a force writer that returns argsB at call time.
    registerForceWriter('caller-X', 'doc-Z', () => argsB);

    try {
      // Fire write A via the public writeMarkdownFile (simulating a
      // timer-fired path that's now mid-IPC).
      const aPromise = writeMarkdownFile(argsA);

      // Give write A a microtask to populate inFlightWrites.
      await new Promise<void>((r) => setTimeout(r, 0));

      // Start a force-write for the same docId; pre-fix it would arm
      // write B WITHOUT waiting for A's IPC to settle.
      const forcePromise = forceWriteForDocument('doc-Z');

      // Give B a microtask to either start or wait.
      await new Promise<void>((r) => setTimeout(r, 0));

      // Post-fix: B has NOT started yet (it's awaiting A's deferred).
      // Pre-fix: B HAS started; writeOrder would contain 'B-start' here.
      expect(writeOrder).toEqual(['A-start:AAA-body']);

      // Now let A settle. Once A ends, B can proceed.
      aDeferred.resolve();
      await aPromise;
      bDeferred.resolve();
      await forcePromise;

      // Strictly sequential: A landed in full, then B started, then B ended.
      expect(writeOrder).toEqual([
        'A-start:AAA-body',
        'A-end',
        'B-start:BBB-body',
        'B-end',
      ]);
    } finally {
      unregisterForceWriter('caller-X');
    }
  });
});

function makeDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}
