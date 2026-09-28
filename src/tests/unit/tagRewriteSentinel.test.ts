import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writePendingRewrite,
  clearPendingRewrite,
  readPendingRewrite,
  hasPartialTagRewriteState,
  hasPartialTagRemovalState,
  type TagRewriteSentinelPayload,
} from '@renderer/lib/vault/tagRewriteSentinel';

/**
 * Sprint B / B3: the `.filo/tag-rewrite-pending.a1b2c3d4e5f6.json` sentinel records the
 * rename intent BEFORE Phase-2 writes start so a crash mid-rewrite leaves
 * a resume breadcrumb. These tests pin the round-trip semantics — write,
 * read back exactly, clear, read returns the steady-state empty result.
 */

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;
type FiloInvoke = (channel: string, ...args: unknown[]) => unknown | Promise<unknown>;

interface InMemoryFs {
  files: Map<string, string>;
  writes: Array<{ vaultRoot: string; path: string; content: string }>;
  deletes: Array<{ vaultRoot: string; path: string }>;
}

function installFiloStub(fs: InMemoryFs): void {
  const routes: Record<string, InvokeRoute> = {
    'vault:write-file-text': async (vaultRoot: unknown, path: unknown, content: unknown) => {
      const v = vaultRoot as string;
      const p = path as string;
      const c = content as string;
      fs.files.set(`${v}::${p}`, c);
      fs.writes.push({ vaultRoot: v, path: p, content: c });
      return { success: true };
    },
    'vault:delete': async (vaultRoot: unknown, fullPath: unknown) => {
      const v = vaultRoot as string;
      const fp = fullPath as string;
      // Recovery code passes a full path; sentinel uses a relative path on
      // write — fish out the rel path by stripping the vaultRoot prefix.
      const rel = fp.startsWith(v) ? fp.slice(v.length).replace(/^[\\/]+/, '') : fp;
      fs.files.delete(`${v}::${rel}`);
      fs.deletes.push({ vaultRoot: v, path: rel });
      return { success: true };
    },
    'vault:read-file-text': async (vaultRoot: unknown, relPath: unknown) => {
      // Phase 37 / 37.6 — canonical two-arg form.
      const v = vaultRoot as string;
      const p = relPath as string;
      const content = fs.files.get(`${v}::${p}`);
      if (content !== undefined) {
        return { success: true, content };
      }
      return { success: false, code: 'ENOENT' };
    },
  };
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return null;
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

describe('tagRewriteSentinel — Sprint B / B3', () => {
  let fs: InMemoryFs;

  beforeEach(() => {
    fs = { files: new Map(), writes: [], deletes: [] };
    installFiloStub(fs);
  });
  afterEach(() => {
    uninstallFiloStub();
  });

  it('write → read returns the exact payload (rename case)', async () => {
    const payload: TagRewriteSentinelPayload = {
      timestamp: 1700000000000,
      oldName: 'project-a',
      newName: 'project-alpha',
      plan: ['notes/foo.md', 'archive/bar.md'],
      preexistingNewNamePaths: ['already/alpha.md'],
      committedPaths: [],
    };
    await writePendingRewrite('/vault', payload);
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBeFalsy();
    expect(result.payload).toEqual(payload);
  });

  it('write → read returns the exact payload (removal case with newName=null)', async () => {
    const payload: TagRewriteSentinelPayload = {
      timestamp: 1700000000000,
      oldName: 'obsolete',
      newName: null,
      plan: ['old/note.md'],
      preexistingNewNamePaths: [],
      committedPaths: [],
    };
    await writePendingRewrite('/vault', payload);
    const result = await readPendingRewrite('/vault');
    expect(result.payload?.newName).toBeNull();
    expect(result.payload?.plan).toEqual(['old/note.md']);
  });

  it('clear deletes the sentinel; subsequent read is the steady-state empty result', async () => {
    await writePendingRewrite('/vault', {
      timestamp: 1,
      oldName: 'a',
      newName: 'b',
      plan: ['x.md'],
      preexistingNewNamePaths: [],
      committedPaths: [],
    });
    await clearPendingRewrite('/vault');
    const result = await readPendingRewrite('/vault');
    expect(result.payload).toBeUndefined();
    expect(result.unreadable).toBeFalsy();
  });

  it('read on a vault that never had a sentinel returns empty (ENOENT)', async () => {
    const result = await readPendingRewrite('/empty-vault');
    expect(result.payload).toBeUndefined();
    expect(result.unreadable).toBeFalsy();
  });

  it('read on a malformed sentinel returns unreadable', async () => {
    fs.files.set('/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json', '{ this is not valid json');
    const result = await readPendingRewrite('/vault');
    expect(result.payload).toBeUndefined();
    expect(result.unreadable).toBe(true);
  });

  it('read on a present-but-empty (zero-byte) sentinel returns unreadable (DI-16)', async () => {
    // The read SUCCEEDS (the key exists) but content is empty — a crash that
    // created the sentinel without filling it. Must surface as unreadable, not
    // the clean "no sentinel" steady state (which is ENOENT → key absent).
    fs.files.set('/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json', '');
    const result = await readPendingRewrite('/vault');
    expect(result.payload).toBeUndefined();
    expect(result.unreadable).toBe(true);
  });

  it('read on a sentinel missing required fields returns unreadable', async () => {
    fs.files.set(
      '/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json',
      JSON.stringify({ timestamp: 1, oldName: 'a' }), // no newName, no plan
    );
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBe(true);
  });

  it('read on a sentinel with non-string plan entries returns unreadable', async () => {
    fs.files.set(
      '/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json',
      JSON.stringify({ timestamp: 1, oldName: 'a', newName: 'b', plan: [42] }),
    );
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBe(true);
  });

  it('two rapid writes serialise — the second payload is what lands on disk (mutex)', async () => {
    // Phase 2.3 — without the mutex, the two `vault:write-file-text` IPC
    // calls would race at the FS layer and either payload could win. With
    // the mutex in place, the second writePendingRewrite is gated on the
    // first one's IPC resolving, so the on-disk content is deterministic.
    //
    // Introduce a small async delay on the FIRST write only — without the
    // mutex, the second write would slip past it and land on disk first
    // (then get overwritten by the slow first write, losing payloadB).
    // With the mutex, the second call blocks until the first one resolves
    // so payloadB wins.
    let writeCallNo = 0;
    (window as unknown as { filo: { invoke: FiloInvoke } }).filo.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:write-file-text') {
        const callNo = ++writeCallNo;
        const [vaultRoot, path, content] = args as [string, string, string];
        if (callNo === 1) {
          // Yield twice so the second call's microtasks could interleave
          // in the absence of the mutex.
          await Promise.resolve();
          await Promise.resolve();
        }
        fs.files.set(`${vaultRoot}::${path}`, content);
        fs.writes.push({ vaultRoot, path, content });
        return { success: true };
      }
      if (channel === 'vault:read-file-text') {
        const [vaultRoot, relPath] = args as [string, string];
        const content = fs.files.get(`${vaultRoot}::${relPath}`);
        if (content !== undefined) return { success: true, content };
        return { success: false, code: 'ENOENT' };
      }
      return null;
    };

    const payloadA: TagRewriteSentinelPayload = {
      timestamp: 1,
      oldName: 'oldA',
      newName: 'newA',
      plan: ['a.md'],
      preexistingNewNamePaths: [],
      committedPaths: [],
    };
    const payloadB: TagRewriteSentinelPayload = {
      timestamp: 2,
      oldName: 'oldB',
      newName: 'newB',
      plan: ['b.md'],
      preexistingNewNamePaths: [],
      committedPaths: [],
    };
    // Fire both without awaiting — the mutex must queue them so write #1
    // (delayed) commits before write #2 starts.
    const p1 = writePendingRewrite('/vault', payloadA);
    const p2 = writePendingRewrite('/vault', payloadB);
    await Promise.all([p1, p2]);

    expect(fs.writes).toHaveLength(2);
    expect(JSON.parse(fs.writes[0].content)).toEqual(payloadA);
    expect(JSON.parse(fs.writes[1].content)).toEqual(payloadB);

    const result = await readPendingRewrite('/vault');
    expect(result.payload).toEqual(payloadB);
  });

  it('write failure surfaces as an exception (so the caller can abort)', async () => {
    // Replace the write route with one that fails.
    (window as unknown as { filo: { invoke: FiloInvoke } }).filo.invoke = async (channel: string) => {
      if (channel === 'vault:write-file-text') {
        return { success: false, code: 'EACCES', error: 'permission denied' };
      }
      return null;
    };
    await expect(
      writePendingRewrite('/vault', {
        timestamp: 1,
        oldName: 'a',
        newName: 'b',
        plan: ['x.md'],
        preexistingNewNamePaths: [],
        committedPaths: [],
      }),
    ).rejects.toThrow();
  });

  it('reads a legacy sentinel without preexistingNewNamePaths as an empty list', async () => {
    // Forward-compat: a sentinel written by an app version before Phase 7.3
    // lacks the field. It must still recover (defaulted to []).
    fs.files.set(
      '/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json',
      JSON.stringify({ timestamp: 1, oldName: 'a', newName: 'b', plan: ['x.md'] }),
    );
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBeFalsy();
    expect(result.payload?.preexistingNewNamePaths).toEqual([]);
  });

  it('read on a sentinel with non-string preexistingNewNamePaths returns unreadable', async () => {
    fs.files.set(
      '/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json',
      JSON.stringify({
        timestamp: 1,
        oldName: 'a',
        newName: 'b',
        plan: ['x.md'],
        preexistingNewNamePaths: [42],
      }),
    );
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBe(true);
  });

  it('reads a legacy sentinel without committedPaths as an empty list (6.3 forward-compat)', async () => {
    // A sentinel written by an app version before 6.3 lacks the field; it
    // must still recover, defaulted to [] (which reads as "no partial
    // removal" — the conservative, pre-6.3 behaviour).
    fs.files.set(
      '/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json',
      JSON.stringify({ timestamp: 1, oldName: 'a', newName: null, plan: ['x.md'] }),
    );
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBeFalsy();
    expect(result.payload?.committedPaths).toEqual([]);
  });

  it('read on a sentinel with non-string committedPaths returns unreadable (6.3)', async () => {
    fs.files.set(
      '/vault::.filo/tag-rewrite-pending.a1b2c3d4e5f6.json',
      JSON.stringify({
        timestamp: 1,
        oldName: 'a',
        newName: null,
        plan: ['x.md'],
        committedPaths: [42],
      }),
    );
    const result = await readPendingRewrite('/vault');
    expect(result.unreadable).toBe(true);
  });

  it('round-trips committedPaths for a partially-committed removal (6.3)', async () => {
    const payload: TagRewriteSentinelPayload = {
      timestamp: 1700000000000,
      oldName: 'obsolete',
      newName: null,
      plan: ['a.md', 'b.md'],
      preexistingNewNamePaths: [],
      committedPaths: ['a.md'],
    };
    await writePendingRewrite('/vault', payload);
    const result = await readPendingRewrite('/vault');
    expect(result.payload).toEqual(payload);
    expect(result.payload?.committedPaths).toEqual(['a.md']);
  });
});

describe('hasPartialTagRewriteState — Phase 7.3 exemption', () => {
  const md = (path: string, ...tags: string[]) => ({ path, tags });

  it('returns false for removals (newName === null)', () => {
    expect(hasPartialTagRewriteState(null, [md('a.md', 'x')])).toBe(false);
  });

  it('returns false when no file carries newName', () => {
    expect(
      hasPartialTagRewriteState('alpha', [md('a.md', 'beta'), md('b.md', 'gamma')]),
    ).toBe(false);
  });

  it('flags a file that gained newName via an interrupted sweep', () => {
    expect(hasPartialTagRewriteState('alpha', [md('swept.md', 'alpha')], [])).toBe(true);
  });

  it('does NOT flag a file that legitimately carried newName before the rename', () => {
    // The only newName carrier is in the pre-existing snapshot → not partial.
    expect(
      hasPartialTagRewriteState('alpha', [md('already.md', 'alpha')], ['already.md']),
    ).toBe(false);
  });

  it('still flags a genuine partial when a non-exempt file also carries newName', () => {
    expect(
      hasPartialTagRewriteState(
        'alpha',
        [md('already.md', 'alpha'), md('swept.md', 'alpha')],
        ['already.md'],
      ),
    ).toBe(true);
  });
});

describe('hasPartialTagRemovalState — 6.3 removal partial-state detection', () => {
  it('returns false when no path was committed (crashed before stripping any file)', () => {
    expect(hasPartialTagRemovalState([])).toBe(false);
  });

  it('returns true when one of several planned files was stripped (the vault split)', () => {
    // committedPaths records a.md was stripped; b.md (planned) was not →
    // the vault is split between a tagged and an untagged file.
    expect(hasPartialTagRemovalState(['a.md'])).toBe(true);
  });

  it('returns true when every file was stripped but the sentinel survived (registry cascade unfinished)', () => {
    // Mirrors hasPartialTagRewriteState's "all rewritten → still partial" so
    // Finalise re-runs the (idempotent) cascade and clears the breadcrumb.
    expect(hasPartialTagRemovalState(['a.md', 'b.md'])).toBe(true);
  });

  it('accepts an iterable and short-circuits on the first element', () => {
    let pulled = 0;
    function* gen(): IterableIterator<string> {
      pulled += 1;
      yield 'a.md';
      pulled += 1;
      yield 'b.md';
    }
    expect(hasPartialTagRemovalState(gen())).toBe(true);
    expect(pulled).toBe(1);
  });
});
