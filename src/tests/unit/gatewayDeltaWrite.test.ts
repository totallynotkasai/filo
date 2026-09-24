import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  markHydrated,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';

/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — the gateway's delta write
 * path. With `frontmatterDelta` present, the gateway must read CURRENT disk
 * in-chain, apply ONLY the delta keys, and assemble against that same fresh
 * source — so an externally-added key the caller never saw survives by
 * construction.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWriteBytes(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function installFilo(diskContent: string): Captured[] {
  const captured: Captured[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: diskContent, mtimeMs: 1, size: diskContent.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: diskContent.length };
      return { success: true, ok: true };
    },
    on: () => () => {},
    send: () => {},
  };
  return captured;
}

describe('markdownFileWriter — Phase 4 delta write path', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelAllMarkdownWrites();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async () => undefined,
      on: () => () => {},
      send: () => {},
    };
  });

  it('applies the delta to FRESH disk and preserves an externally-added key', async () => {
    const relPath = 'Card.md';
    // Disk carries `status: blocked` the caller never knew about.
    const captured = installFilo('---\ncompleted: false\nstatus: blocked\n---\ncard body\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      // `frontmatter` is intentionally STALE (no status) — it must be ignored.
      frontmatter: { completed: false },
      body: 'card body\n',
      callerId: 'delta-test',
      notePath: null,
      frontmatterDelta: { set: { completed: true }, unset: [] },
    });

    const written = lastWriteBytes(captured);
    expect(written).toBeDefined();
    expect(written).toContain('completed: true'); // delta applied
    expect(written).toContain('status: blocked'); // untouched external key preserved
    expect(written).toContain('card body');
  });

  it('reads disk in-chain — uses CURRENT disk, not the stale caller frontmatter', async () => {
    const relPath = 'Note.md';
    const captured = installFilo('---\npriority: urgent\nreviewer: alice\n---\nbody\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { priority: 'low' }, // stale snapshot — ignored on the delta path
      body: 'body\n',
      callerId: 'delta-test-2',
      notePath: null,
      frontmatterDelta: { set: { priority: 'high' }, unset: [] },
    });

    const written = lastWriteBytes(captured);
    expect(written).toContain('priority: high'); // user's delta
    expect(written).toContain('reviewer: alice'); // external key from fresh disk
    expect(written).not.toContain('priority: urgent');
    expect(written).not.toContain('priority: low');
  });

  it('unset removes a key while preserving untouched ones', async () => {
    const relPath = 'Task.md';
    const captured = installFilo('---\npriority: high\ndue: 2026-01-01\nexternal: keep\n---\nx\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'x\n',
      callerId: 'delta-unset',
      notePath: null,
      frontmatterDelta: { set: {}, unset: ['priority'] },
    });

    const written = lastWriteBytes(captured)!;
    expect(written).not.toContain('priority:');
    expect(written).toContain('due: 2026-01-01');
    expect(written).toContain('external: keep');
  });

  it('an empty delta with no live editor emits the disk frontmatter AND body verbatim', async () => {
    const relPath = 'Notes.md';
    // A comment + odd key order: an empty-delta write must byte-preserve it.
    const captured = installFilo('---\n# kept comment\nzeta: 1\nalpha: 2\n---\nold body\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      // Audit-15 P1.4 — with NO live editor for this (cache-less, null notePath) write, the body
      // is sourced from FRESH disk (`parsedFresh.body`), not the caller arg, so a
      // never-opened orphan/card whose snapshot went stale can't clobber disk. The
      // caller body here is deliberately different to prove disk wins. A live
      // editor instead keeps the caller's un-debounced body — see the N2-invariant
      // case in audit15Phase1.test.ts.
      body: 'caller body that must be ignored\n',
      callerId: 'delta-empty',
      notePath: null,
      frontmatterDelta: { set: {}, unset: [] },
    });

    const written = lastWriteBytes(captured)!;
    expect(written).toContain('# kept comment'); // comment preserved
    expect(written).toContain('zeta: 1');
    expect(written).toContain('alpha: 2'); // key order preserved (zeta before alpha)
    expect(written.indexOf('zeta')).toBeLessThan(written.indexOf('alpha'));
    expect(written).toContain('old body'); // disk body preserved (P1.4)
    expect(written).not.toContain('caller body that must be ignored');
  });

  it('rejects + marks the path failed when the in-chain read fails (no resurrection)', async () => {
    const relPath = 'Gone.md';
    markHydrated(relPath, false);
    const captured: Captured[] = [];
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string, ...args: unknown[]) => {
        captured.push({ channel, args });
        if (channel === 'vault:read-file-text') throw new Error('ENOENT');
        return { success: true };
      },
      on: () => () => {},
      send: () => {},
    };

    await expect(
      writeMarkdownFile({
        vaultRoot: '/vault',
        relPath,
        frontmatter: {},
        body: 'x',
        callerId: 'delta-gone',
        notePath: null,
        frontmatterDelta: { set: { a: 1 }, unset: [] },
      }),
    ).rejects.toThrow();

    // Never wrote — refused to resurrect a deleted file.
    expect(captured.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(false);
  });
});
