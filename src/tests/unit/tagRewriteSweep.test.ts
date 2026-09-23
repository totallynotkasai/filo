/**
 * Polish phase 4.3 (2026-05-25) — full-function mutex.
 *
 * The previous mutex (`tagRewriteSentinel`) only guarded the sentinel JSON
 * read/write. Two rapid `rewriteTagInAllMarkdown` calls (e.g. user renames
 * a tag twice in quick succession) could interleave their per-file write
 * IPCs, producing order-dependent rewrites where the OLDER sweep's
 * vault:write-existing-file-text won the race for the same .md.
 *
 * This test fakes the IPC layer, simulates two concurrent sweeps against
 * the same metadata, and asserts the actual write IPCs land in a
 * sweep-grouped sequence (all of sweep A's writes, then all of sweep B's),
 * not interleaved (A1, B1, A2, B2, …).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  rewriteTagInAllMarkdown,
  __resetTagRewriteSweepForTests,
} from '@renderer/lib/vault/tagRewriteSweep';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import {
  __testRegisterFlusher,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';

type InvokeRoute = (...args: unknown[]) => unknown | Promise<unknown>;

interface FakeFs {
  files: Map<string, string>;
  writeLog: Array<{ path: string; content: string; at: number }>;
  /** ms to sleep inside vault:write-existing-file-text — set per test. */
  writeDelayMs: number;
}

function installFiloStub(fs: FakeFs): void {
  const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  const routes: Record<string, InvokeRoute> = {
    'vault:read-file-text': async (_vaultRoot: unknown, relPath: unknown) => {
      const content = fs.files.get(relPath as string);
      if (content === undefined) return { success: false, code: 'ENOENT' };
      return { success: true, content };
    },
    'vault:file-exists': async (_vaultRoot: unknown, relPath: unknown) => {
      return fs.files.has(relPath as string);
    },
    'vault:write-file-text': async (_vaultRoot: unknown, relPath: unknown, content: unknown) => {
      // Sentinel writes flow through this channel; record but no delay.
      fs.files.set(relPath as string, content as string);
      return { success: true };
    },
    'vault:write-existing-file-text': async (
      _vaultRoot: unknown,
      relPath: unknown,
      content: unknown,
    ) => {
      // The interleaving the mutex prevents lives here. Awaiting a delay
      // lets a second concurrent caller's pre-await code slip ahead if
      // the mutex isn't holding.
      if (fs.writeDelayMs > 0) await wait(fs.writeDelayMs);
      fs.files.set(relPath as string, content as string);
      fs.writeLog.push({
        path: relPath as string,
        content: content as string,
        at: Date.now(),
      });
      return { success: true };
    },
    'vault:delete': async () => ({ success: true }),
  };
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return { success: false };
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

function makeMetadata(paths: string[], tag: string): FileMetadata[] {
  return paths.map((path) => ({
    path,
    title: path,
    headings: [],
    tags: [tag],
    frontmatter: {},
    links: [],
    content: '',
    lastModified: 0,
  }));
}

describe('rewriteTagInAllMarkdown — sweep mutex (polish phase 4.3)', () => {
  let fs: FakeFs;

  beforeEach(() => {
    fs = { files: new Map(), writeLog: [], writeDelayMs: 0 };
    installFiloStub(fs);
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });
  afterEach(() => {
    uninstallFiloStub();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });

  it('two concurrent sweeps serialise — no interleaved writes', async () => {
    // Seed three .md files all carrying the source tag for sweep A. Sweep B
    // operates on a different set so we can identify each sweep's writes
    // by content prefix. Frontmatter tags are the canonical source — the
    // rewriter doesn't touch inline #tags in the body, so the test
    // payloads must declare the tag in YAML.
    const withFm = (tag: string, body: string) => `---\ntags:\n  - ${tag}\n---\n${body}\n`;
    fs.files.set('a1.md', withFm('draft', 'notes A1'));
    fs.files.set('a2.md', withFm('draft', 'notes A2'));
    fs.files.set('a3.md', withFm('draft', 'notes A3'));
    fs.files.set('b1.md', withFm('planning', 'notes B1'));
    fs.files.set('b2.md', withFm('planning', 'notes B2'));
    fs.files.set('b3.md', withFm('planning', 'notes B3'));

    // Small delay inside each IPC so the interleaving race window is
    // observable (without the mutex, sweep B's first write would slip
    // between sweep A's writes during the delay).
    fs.writeDelayMs = 5;

    const metaA = makeMetadata(['a1.md', 'a2.md', 'a3.md'], 'draft');
    const metaB = makeMetadata(['b1.md', 'b2.md', 'b3.md'], 'planning');

    // Kick off both sweeps in the same tick.
    const pA = rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: metaA,
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });
    const pB = rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: metaB,
      oldName: 'planning',
      newName: 'sprint',
      applyChanges: async () => {},
    });

    const [resA, resB] = await Promise.all([pA, pB]);

    // Both sweeps recorded the same number of attempts they planned.
    expect(resA.succeeded).toHaveLength(3);
    expect(resB.succeeded).toHaveLength(3);

    // The write log must be sweep-grouped: all three A writes before any B
    // write, OR all three B writes before any A write. NEVER interleaved
    // (which is what the unguarded version would produce).
    const log = fs.writeLog.map((w) => (w.path.startsWith('a') ? 'A' : 'B'));
    const firstAIdx = log.indexOf('A');
    const lastAIdx = log.lastIndexOf('A');
    const firstBIdx = log.indexOf('B');
    const lastBIdx = log.lastIndexOf('B');

    // All A's are contiguous (firstA..lastA covers exactly 3 entries, all A).
    expect(lastAIdx - firstAIdx).toBe(2);
    expect(log.slice(firstAIdx, lastAIdx + 1).every((x) => x === 'A')).toBe(true);
    // Same for B.
    expect(lastBIdx - firstBIdx).toBe(2);
    expect(log.slice(firstBIdx, lastBIdx + 1).every((x) => x === 'B')).toBe(true);
    // And the two groups don't overlap.
    expect(lastAIdx < firstBIdx || lastBIdx < firstAIdx).toBe(true);
  });

  it('a sweep that rejects releases the chain for the next sweep', async () => {
    // First sweep throws inside the write IPC. Without the dual `then(fn, fn)`
    // handler on the chain, the next sweep would hang waiting on the rejected
    // promise.
    fs.files.set('rej.md', '---\ntags:\n  - draft\n---\nonly\n');
    const meta = makeMetadata(['rej.md'], 'draft');

    // Route override: make the FIRST vault:write-existing-file-text reject.
    let writeCallCount = 0;
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === 'vault:write-existing-file-text') {
          writeCallCount++;
          if (writeCallCount === 1) {
            return { success: false, code: 'EACCES' };
          }
          const [, relPath, content] = args as [unknown, string, string];
          fs.files.set(relPath, content);
          fs.writeLog.push({ path: relPath, content, at: Date.now() });
          return { success: true };
        }
        if (channel === 'vault:read-file-text') {
          const content = fs.files.get(args[1] as string);
          if (content === undefined) return { success: false, code: 'ENOENT' };
          return { success: true, content };
        }
        if (channel === 'vault:file-exists') {
          return fs.files.has(args[1] as string);
        }
        if (channel === 'vault:write-file-text' || channel === 'vault:delete') {
          if (channel === 'vault:write-file-text') {
            fs.files.set(args[1] as string, args[2] as string);
          }
          return { success: true };
        }
        return { success: false };
      },
      on: () => () => {},
      send: () => {},
    };

    const first = rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: meta,
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });
    const second = rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: meta,
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    const r1 = await first;
    const r2 = await second;
    // First sweep recorded one failure (the EACCES rejection).
    expect(r1.failed).toContain('rej.md');
    // Second sweep ran despite the first's failure — the file was rewritten,
    // so by the time the read returns the new content the rewriter
    // short-circuits (next === raw → no plan entry, no write).
    // Either path is acceptable: the contract is that second.await resolves,
    // not that it produces a write.
    expect(r2).toBeDefined();
  });

  // ── Audit 2.2 ─────────────────────────────────────────────────────────────
  // The index preserves the file's authored casing (`Project`), but the
  // registry canonical name is `project`. Pre-fix the candidate filter
  // (`md.tags.some((t) => t === oldName)`) was case-SENSITIVE, so the file was
  // skipped and the rename never reached its `.md` — leaving a stale `Project`
  // that the next external-edit reconcile would re-assert. Both the filter AND
  // the rewriter must fold case to match identity used everywhere else.
  // ── 6.3 (AUDIT_REMEDIATION_PLAN_2026-05-31) ───────────────────────────────
  // A crash mid tag-REMOVAL used to be undetectable: the sentinel recorded no
  // per-path progress, and reopen-side detection short-circuited to "not
  // partial" for removals — so a vault split between files that still carry
  // the tag and files that don't went unwarned. The sweep must now record
  // each committed path incrementally so reopen can detect the split.
  it('records committedPaths incrementally for a partial removal (6.3)', async () => {
    const withFm = (tag: string, body: string) => `---\ntags:\n  - ${tag}\n---\n${body}\n`;
    fs.files.set('a.md', withFm('obsolete', 'note A'));
    fs.files.set('b.md', withFm('obsolete', 'note B'));

    // Fail the SECOND .md write so the removal strips a.md but not b.md —
    // exactly the "vault split" crash window 6.3 must leave detectable.
    let writeCount = 0;
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === 'vault:write-existing-file-text') {
          writeCount++;
          if (writeCount === 2) return { success: false, code: 'EACCES' };
          const [, relPath, content] = args as [unknown, string, string];
          fs.files.set(relPath, content);
          fs.writeLog.push({ path: relPath, content, at: 0 });
          return { success: true };
        }
        if (channel === 'vault:write-file-text') {
          // Sentinel writes — record so the test can read the final breadcrumb.
          fs.files.set(args[1] as string, args[2] as string);
          return { success: true };
        }
        if (channel === 'vault:read-file-text') {
          const content = fs.files.get(args[1] as string);
          if (content === undefined) return { success: false, code: 'ENOENT' };
          return { success: true, content };
        }
        if (channel === 'vault:file-exists') return fs.files.has(args[1] as string);
        if (channel === 'vault:delete') return { success: true };
        return { success: false };
      },
      on: () => () => {},
      send: () => {},
    };

    const meta = makeMetadata(['a.md', 'b.md'], 'obsolete');
    const res = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: meta,
      oldName: 'obsolete',
      newName: null, // removal
      applyChanges: async () => {},
    });

    expect(res.succeeded).toEqual(['a.md']);
    expect(res.failed).toContain('b.md');

    // The sentinel must survive (failed > 0 ⇒ not cleared) AND carry the
    // path that was actually stripped, so reopen-side detection can see the
    // removal got half-done.
    const sentinelRaw = fs.files.get('.filo/tag-rewrite-pending.json');
    expect(sentinelRaw, 'removal sentinel should survive a partial sweep').toBeDefined();
    const sentinel = JSON.parse(sentinelRaw as string) as {
      newName: string | null;
      committedPaths?: string[];
    };
    expect(sentinel.newName).toBeNull();
    expect(sentinel.committedPaths).toEqual(['a.md']);
  });

  it('rewrites a file whose frontmatter tag case differs from the registry name', async () => {
    fs.files.set('note.md', '---\ntags:\n  - Project\n---\nbody\n');
    const meta = makeMetadata(['note.md'], 'Project');
    const applied: string[] = [];
    const res = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: meta,
      oldName: 'project',
      newName: 'done',
      applyChanges: async (paths) => {
        applied.push(...paths);
      },
    });
    expect(res.succeeded).toContain('note.md');
    expect(applied).toContain('note.md');
    expect(fs.files.get('note.md')).toMatch(/- done/);
    expect(fs.files.get('note.md')).not.toMatch(/Project/);
  });
});

// ── Audit-7 M2 — the sweep re-reads after the inner drain ─────────────────────
//
// Phase 1 read each candidate and (pre-fix) snapshotted `rewrite(rawBytes)`.
// The Phase-2 commit loop's `withDrainedWrites` flushes any armed editor body to
// disk; the sweep then wrote the STALE snapshot over it, and the `mode:'full'`
// reconcile reloaded the open editor to that stale body — losing a keystroke
// that landed after the caller's up-front drain. The fix recomputes the rewrite
// from a POST-drain re-read so the flushed body survives (tag still rewritten).
describe('rewriteTagInAllMarkdown — re-reads after the drain (Audit-7 M2)', () => {
  let fs: FakeFs;

  beforeEach(() => {
    fs = { files: new Map(), writeLog: [], writeDelayMs: 0 };
    installFiloStub(fs);
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    __resetMarkdownFileWriterForTests();
  });
  afterEach(() => {
    uninstallFiloStub();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    __resetMarkdownFileWriterForTests();
  });

  it('preserves a body the inner drain flushes instead of clobbering it with a pre-drain snapshot', async () => {
    const withFm = (tag: string, body: string) => `---\ntags:\n  - ${tag}\n---\n${body}\n`;
    const C0 = withFm('draft', 'OLD BODY'); // pre-flight disk content (Phase-1 read)
    const C1 = withFm('draft', 'NEW BODY'); // the live keystroke the drain flushes (tag NOT renamed yet)
    fs.files.set('note.md', C0);

    // Simulate an editor body write that a keystroke re-armed after the caller's
    // up-front drain: the sweep's own `withDrainedWrites` flushes it to disk.
    // `flushAllMarkdownWriters` (inside withDrainedWrites) drains test flushers.
    let flushed = false;
    __testRegisterFlusher('editor:note.md', async () => {
      if (flushed) return;
      flushed = true;
      fs.files.set('note.md', C1);
      fs.writeLog.push({ path: 'note.md', content: C1, at: 0 });
    });

    const res = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      metadata: makeMetadata(['note.md'], 'draft'),
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
    });

    expect(flushed, 'the inner drain must have flushed the editor body').toBe(true);
    expect(res.succeeded).toContain('note.md');
    const final = fs.files.get('note.md')!;
    // The drained body survives AND the tag is renamed — not the stale pre-drain
    // body the Phase-1 snapshot would have re-written.
    expect(final).toContain('NEW BODY');
    expect(final).not.toContain('OLD BODY');
    expect(final).toMatch(/- review/);
    expect(final).not.toMatch(/draft/);
  });
});
