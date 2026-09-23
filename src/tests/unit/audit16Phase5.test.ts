import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markHydrated,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/boardSaver';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * AUDIT-16 Phase 5 — gateway torn/stale-read guards:
 *
 *   5.2 — the delta branch re-stats AFTER its in-chain read and verifies the
 *         file is still exactly the one the pre-write drift decision trusted.
 *         An external write landing in the stat→read gap was invisible to the
 *         drift check, and a torn/stale read of it would be written back
 *         VERBATIM as the delta body for the common no-live-editor case (the
 *         post-write baseline then adopts our bytes, suppressing detection).
 *
 *   5.3 — the Audit-10 H2 empty-cache seed re-read gets the same torn-read
 *         guard the delta branch has (Audit-14 3.3): a partial read (opening
 *         fence, no closing fence) parses as "no frontmatter"; pre-guard the
 *         assemble stripped the on-disk YAML block AND the bogus `{}` seed was
 *         CACHED, poisoning every later save for the docId.
 *
 * (5.1 / 5.4 corpus rows live in frontmatterInvariant.test.ts; 5.5 lives in
 * tagRewriter.test.ts.)
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function wroteFile(captured: Captured[]): boolean {
  return captured.some((c) => c.channel === 'vault:write-existing-file-text');
}

function lastWriteBytes(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

let captured: Captured[];

beforeEach(() => {
  __resetMarkdownFileWriterForTests();
  __resetDirtyTrackingForTests();
  __resetBaselinesForTests();
  cancelAllMarkdownWrites();
  documentStore.clear();
  vaultIndexStore.clear();
  captured = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  restoreFiloDefault();
  cancelAllMarkdownWrites();
  __resetMarkdownFileWriterForTests();
  __resetDirtyTrackingForTests();
  __resetBaselinesForTests();
  documentStore.clear();
  vaultIndexStore.clear();
  vi.restoreAllMocks();
});

describe('Audit-16 5.2 — delta write verifies the in-chain read against the drift stat', () => {
  /**
   * `stats` is consumed in call order: index 0 answers the PRE-WRITE drift
   * stat, index 1 the POST-READ verify stat (later calls repeat the last).
   */
  function installDisk(content: string, stats: Array<{ mtimeMs: number; size: number }>): void {
    let statCalls = 0;
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:stat') {
        const s = stats[Math.min(statCalls, stats.length - 1)];
        statCalls++;
        return { success: true, ...s };
      }
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 1, size: content.length };
      }
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  }

  const DELTA_ARGS = {
    vaultRoot: '/vault',
    frontmatter: {},
    body: 'body\n',
    callerId: 'a16-5-2',
    docId: null,
    frontmatterDelta: { set: { status: 'closed' }, unset: [] },
  };

  it('aborts loudly when the file changes between the pre-write stat and the in-chain read', async () => {
    const relPath = 'GapWrite.md';
    // Pre-write stat matches the baseline (no drift)…
    // …but the post-read verify stat reports a DIFFERENT file state: an external
    // write landed in the stat→read gap, so the read may be torn or stale.
    installDisk('---\ntitle: t\n---\nbody\n', [
      { mtimeMs: 1, size: 100 },
      { mtimeMs: 9, size: 100 },
    ]);
    markHydrated(relPath, false, 1, 100); // seeds the drift baseline (1, 100)

    await expect(writeMarkdownFile({ ...DELTA_ARGS, relPath })).rejects.toThrow(
      /changed on disk between the pre-write drift check and the in-chain read/i,
    );

    // Never wrote, and the path is attributed as failed (sentinel stays dirty;
    // the next debounced write retries against the settled file).
    expect(wroteFile(captured)).toBe(false);
    expect(isPathPending(relPath)).toBe(true);
  });

  it('control — stable stats across the gap write normally', async () => {
    const relPath = 'Stable.md';
    installDisk('---\ntitle: t\n---\nbody\n', [{ mtimeMs: 1, size: 100 }]);
    markHydrated(relPath, false, 1, 100);

    await writeMarkdownFile({ ...DELTA_ARGS, relPath });

    const written = lastWriteBytes(captured)!;
    expect(written).toContain('status: closed'); // delta applied
    expect(written).toContain('title: t'); // untouched key preserved
    expect(isPathPending(relPath)).toBe(false);
  });

  it('control — no drift baseline ⇒ no verify anchor ⇒ the write proceeds (legacy trust)', async () => {
    const relPath = 'NoBaseline.md';
    // Stats would diverge, but with no baseline the pre-write stat never ran,
    // so there is no anchor to verify against — same trust level as before.
    installDisk('---\ntitle: t\n---\nbody\n', [
      { mtimeMs: 1, size: 100 },
      { mtimeMs: 9, size: 100 },
    ]);
    markHydrated(relPath, false); // NO mtime ⇒ no baseline seeded

    await writeMarkdownFile({ ...DELTA_ARGS, relPath });

    expect(wroteFile(captured)).toBe(true);
    expect(isPathPending(relPath)).toBe(false);
  });
});

describe('Audit-16 5.3 — empty-cache seed re-read refuses a torn read (and never caches {})', () => {
  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 5, size: content.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: content.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  }

  const BODY_ONLY_ARGS = {
    vaultRoot: '/vault',
    frontmatter: {}, // body-only editor path: getFrontmatter() || {} → {}
    body: 'new body\n',
    callerId: 'a16-5-3',
    // no frontmatterDelta — exercises the cache-FM branch's H2 seed re-read
  };

  it('refuses the write and does NOT seed {} when the seed read is torn mid-frontmatter', async () => {
    const relPath = 'TornSeed.md';
    const docId = 'doc-torn';
    // The index knows this file HAS a frontmatter block…
    vaultIndexStore.restoreMetadata(
      relPath,
      parseMarkdown(relPath, '---\ntitle: real\nstatus: open\n---\nold body\n'),
    );
    // …but the seed read returns TRUNCATED bytes: opening fence, no closing fence.
    installDisk('---\ntitle: rea');
    markHydrated(relPath, false);
    expect(documentStore.hasFrontmatter(docId)).toBe(false); // adoption shape: never seeded

    await expect(
      writeMarkdownFile({ ...BODY_ONLY_ARGS, relPath, docId }),
    ).rejects.toThrow(/closing fence|partial read/i);

    // Never wrote (the on-disk YAML block is not stripped)…
    expect(wroteFile(captured)).toBe(false);
    // …the bogus {} was NOT cached (pre-fix it poisoned every later save)…
    expect(documentStore.hasFrontmatter(docId)).toBe(false);
    // …and the failure is attributed so `.filo/.dirty` stays set.
    expect(isPathPending(relPath)).toBe(true);
  });

  it('control — a complete seed read still seeds the cache and preserves the FM (Audit-10 H2)', async () => {
    const relPath = 'CleanSeed.md';
    const docId = 'doc-clean';
    const disk = '---\ntitle: Keep\n---\nold body\n';
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, disk));
    installDisk(disk);
    markHydrated(relPath, false);

    await writeMarkdownFile({ ...BODY_ONLY_ARGS, relPath, docId });

    const written = lastWriteBytes(captured)!;
    expect(written).toContain('title: Keep'); // FM preserved via the seeded cache
    expect(written).toContain('new body');
    expect(documentStore.hasFrontmatter(docId)).toBe(true);
    expect(isPathPending(relPath)).toBe(false);
  });

  it('control — a genuinely frontmatter-less file is not misclassified (no false positive)', async () => {
    const relPath = 'PlainSeed.md';
    const docId = 'doc-plain';
    // Index records NO frontmatter for this path (rawFrontmatter empty), so the
    // guard must not fire even though the parse reports hasFrontmatter:false.
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, 'just a body\n'));
    installDisk('just a body\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({ ...BODY_ONLY_ARGS, relPath, docId });

    expect(wroteFile(captured)).toBe(true);
    expect(isPathPending(relPath)).toBe(false);
  });
});
