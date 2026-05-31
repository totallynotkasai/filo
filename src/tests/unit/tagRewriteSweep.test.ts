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
